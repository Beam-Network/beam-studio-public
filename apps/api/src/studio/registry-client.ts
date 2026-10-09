import type { ActionManifest } from "@beam-studio/core";

export type RegistryAdvisory = {
  id: string;
  title: string;
  severity: "low" | "moderate" | "high" | "critical" | "unknown";
  status: string;
  summary: string | null;
  url: string | null;
  affectedVersions: string[];
  patchedVersions: string[];
  cves: string[];
  blocking: boolean;
};

export type PublicRegistryVersion = {
  version: string;
  manifest: ActionManifest;
  manifestChecksum: string | null;
  artifactChecksum: string | null;
  artifactSizeBytes: number;
  artifactReference: string | null;
  /**
   * Short-lived signed download URL the Registry issues to a caller that may
   * read the package. It is a bearer capability to these exact bytes: freeze it
   * into a dispatched step, never into the installed catalog.
   */
  artifactUrl: string | null;
  hippiusBucket: string | null;
  hippiusKey: string | null;
  hippiusEndpoint: string | null;
  mediaType: string;
  signature: string | null;
  provenance: Record<string, unknown>;
  sourceRegistry: string;
  trustLevel: string;
  validationStatus: string;
  status: string;
  publishedBy: string | null;
  publishedAt: string | null;
  advisories: RegistryAdvisory[];
  vulnerable: boolean;
};

export type PublicRegistryResolveResult = {
  packageName: string;
  packageStatus: string;
  packageTrustLevel: string;
  packageVisibility: RegistryPackageVisibility;
  requestedRange: string;
  resolvedVersion: string;
  version: PublicRegistryVersion;
};

export type RegistryPackageVisibility = "public" | "unlisted" | "private";

export type RegistryRepository = { url: string; directory: string | null };

export class RegistryClientError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly action: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: {
      statusCode?: number;
      retryable?: boolean;
      action?: string;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "RegistryClientError";
    this.code = code;
    this.statusCode = options.statusCode ?? 502;
    this.retryable = options.retryable ?? false;
    this.action =
      options.action ?? "Check the Registry response and try again.";
    this.details = options.details ?? {};
  }
}

export function createRegistryClient(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /**
   * The organization's Beam API key. The Registry takes the organization from
   * it and shows that organization's private packages. Without one, only
   * public and unlisted packages are readable.
   */
  apiKey?: string | null;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizedRegistryBaseUrl(options.baseUrl);

  async function request(path: string) {
    const url = registryClientUrl(baseUrl, path);
    const authorization = registryAuthorization(baseUrl, url, options.apiKey);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        cache: "no-store",
        // A redirect must not carry the key to another origin.
        ...(authorization
          ? { headers: { authorization }, redirect: "error" as const }
          : {}),
      });
    } catch (error) {
      throw new RegistryClientError(
        "registry_unavailable",
        `Unable to reach the Actions Registry: ${errorMessage(error)}`,
        {
          statusCode: 502,
          retryable: true,
          action: "Check the Registry URL or network connection, then retry.",
          details: { registryUrl: baseUrl },
        },
      );
    }

    const responseText = await response.text();
    if (!response.ok) {
      const upstream = jsonObject(responseText);
      const upstreamMessage = stringValue(upstream.error) ?? responseText;
      throw new RegistryClientError(
        stringValue(upstream.code) ?? "registry_request_failed",
        upstreamMessage
          ? `Registry request failed with ${response.status}: ${upstreamMessage}`
          : `Registry request failed with ${response.status}.`,
        {
          statusCode: upstreamStatus(response.status),
          retryable: response.status >= 500 || response.status === 429,
          action:
            response.status === 404
              ? "Check the package name and requested version."
              : "Retry after the Registry is healthy, or choose another version.",
          details: {
            registryUrl: baseUrl,
            upstreamStatus: response.status,
          },
        },
      );
    }

    try {
      return responseText ? (JSON.parse(responseText) as unknown) : {};
    } catch {
      throw new RegistryClientError(
        "registry_invalid_response",
        "Registry returned a response that is not valid JSON.",
        {
          statusCode: 502,
          retryable: true,
          action: "Check the Registry service logs, then retry.",
          details: { registryUrl: baseUrl },
        },
      );
    }
  }

  return {
    async list() {
      return normalizeRegistryList(await request("/v1/registry"));
    },
    async resolve(packageName: string, range: string) {
      const path = `/v1/resolve/${registryPackagePath(
        packageName,
      )}?range=${encodeURIComponent(range)}`;
      return normalizeRegistryResolve(await request(path), {
        packageName,
        range,
      });
    },
    /** One exact release, including a fresh signed `artifactUrl` if issued. */
    async version(packageName: string, version: string) {
      const path = `/v1/packages/${registryPackagePath(
        packageName,
      )}/versions/${encodeURIComponent(version)}`;
      return normalizeRegistryVersion(recordValue(await request(path)), {
        packageName,
        packageStatus: null,
        packageTrustLevel: null,
        inheritedAdvisories: [],
      });
    },
  };
}

/**
 * The bearer header for a Registry request, or null. The key is sent only to
 * the configured Registry origin, and only over HTTPS (plain HTTP is accepted
 * for a loopback Registry in local development).
 */
export function registryAuthorization(
  baseUrl: string,
  url: URL,
  apiKey: string | null | undefined,
) {
  const key = apiKey?.trim();
  if (!key) return null;
  const registry = new URL(normalizedRegistryBaseUrl(baseUrl));
  if (url.origin !== registry.origin) return null;
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) return null;
  return `Bearer ${key}`;
}

/**
 * Accepts the Registry's signed artifact URL only as an absolute http(s) URL
 * without embedded credentials. The downloader still verifies the sha256, so
 * a wrong URL can fail a run but never substitute bytes.
 */
export function validSignedArtifactUrl(value: unknown) {
  const text = stringValue(value);
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return null;
  return url.toString();
}

/**
 * A fresh signed URL for the exact artifact a step froze, or null when the
 * Registry issues none (an older Registry). It is returned only while the
 * Registry still reports that release with the same sha256.
 */
export async function freshSignedArtifactUrl(
  client: Pick<RegistryClient, "version">,
  input: { packageName: string; version: string; artifactChecksum: unknown },
) {
  const expected = normalizeSha256Checksum(input.artifactChecksum);
  if (!expected) return null;
  const release = await client.version(input.packageName, input.version);
  if (!release.artifactUrl) return null;
  if (normalizeSha256Checksum(release.artifactChecksum) !== expected) {
    throw new RegistryClientError(
      "registry_artifact_checksum_mismatch",
      `The Registry no longer serves the frozen artifact of ${input.packageName}@${input.version}.`,
      { statusCode: 409, action: "Investigate the Registry release." },
    );
  }
  return release.artifactUrl;
}

/**
 * The package's source repository link, only if it is an `https:` URL without
 * credentials. Anything else (for example `javascript:`) is dropped.
 */
export function normalizeRegistryRepository(
  value: unknown,
): RegistryRepository | null {
  const record = recordValue(value);
  const text = stringValue(record.url);
  if (!text || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const directory = stringValue(record.directory);
  return {
    url: url.toString(),
    directory:
      directory &&
      directory.length <= 512 &&
      !directory.startsWith("/") &&
      !directory.split(/[\\/]/).includes("..")
        ? directory
        : null,
  };
}

function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

export type RegistryClient = ReturnType<typeof createRegistryClient>;

export function normalizedRegistryBaseUrl(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

export function registryClientUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\/+/, ""), normalizedRegistryBaseUrl(baseUrl));
}

export function normalizeRegistryList(value: unknown) {
  const payload = recordValue(value);
  const packages = arrayValue(payload.packages).map((entry) =>
    normalizeRegistryPackage(entry),
  );
  return {
    categories: arrayValue(payload.categories),
    packages,
  };
}

export function normalizeRegistryResolve(
  value: unknown,
  input: { packageName: string; range: string },
): PublicRegistryResolveResult {
  const payload = recordValue(value);
  const packageRecord = recordValue(payload.package ?? payload.packageInfo);
  const rawVersion = recordValue(payload.version);
  const version = normalizeRegistryVersion(rawVersion, {
    packageName: input.packageName,
    packageStatus: stringValue(packageRecord.status ?? payload.packageStatus),
    packageTrustLevel: stringValue(
      packageRecord.trustLevel ?? payload.packageTrustLevel,
    ),
    inheritedAdvisories: normalizeAdvisories(
      packageRecord.advisories ?? payload.advisories,
    ),
  });
  const resolvedVersion =
    stringValue(payload.resolvedVersion) ?? version.version;

  if (!version.manifest.name || version.manifest.name !== input.packageName) {
    throw new RegistryClientError(
      "registry_manifest_identity_mismatch",
      `Registry manifest identity does not match ${input.packageName}.`,
      {
        statusCode: 502,
        action: "Do not install this version; contact the Registry operator.",
        details: {
          expectedPackageName: input.packageName,
          manifestPackageName: version.manifest.name || null,
        },
      },
    );
  }
  if (!version.version || version.manifest.version !== resolvedVersion) {
    throw new RegistryClientError(
      "registry_version_identity_mismatch",
      `Registry resolved ${resolvedVersion || "an unknown version"}, but the manifest declares ${version.manifest.version || "an unknown version"}.`,
      {
        statusCode: 502,
        action: "Do not install this version; contact the Registry operator.",
        details: {
          resolvedVersion: resolvedVersion || null,
          manifestVersion: version.manifest.version || null,
        },
      },
    );
  }

  return {
    packageName: input.packageName,
    packageStatus:
      stringValue(packageRecord.status ?? payload.packageStatus) ?? "active",
    packageTrustLevel:
      stringValue(packageRecord.trustLevel ?? payload.packageTrustLevel) ??
      version.trustLevel,
    packageVisibility: normalizeVisibility(
      packageRecord.visibility ?? payload.visibility,
    ),
    requestedRange: input.range,
    resolvedVersion,
    version,
  };
}

export function assertRegistryVersionInstallable(
  resolved: PublicRegistryResolveResult,
) {
  const version = resolved.version;
  const blockedAdvisories = version.advisories.filter(
    (advisory) => advisory.blocking,
  );
  if (
    resolved.packageStatus === "blocked" ||
    resolved.packageTrustLevel === "blocked" ||
    version.status === "blocked" ||
    version.status === "yanked" ||
    version.trustLevel === "blocked" ||
    version.validationStatus === "blocked" ||
    version.validationStatus === "rejected" ||
    blockedAdvisories.length
  ) {
    throw new RegistryClientError(
      blockedAdvisories.length
        ? "registry_advisory_blocked"
        : "registry_version_blocked",
      blockedAdvisories.length
        ? `${resolved.packageName}@${resolved.resolvedVersion} is blocked by ${blockedAdvisories.length} security advisory${blockedAdvisories.length === 1 ? "" : "ies"}.`
        : `${resolved.packageName}@${resolved.resolvedVersion} is blocked and cannot be installed.`,
      {
        statusCode: 409,
        action: "Choose a non-blocked patched version before installing.",
        details: {
          packageName: resolved.packageName,
          resolvedVersion: resolved.resolvedVersion,
          packageStatus: resolved.packageStatus,
          packageTrustLevel: resolved.packageTrustLevel,
          versionStatus: version.status,
          validationStatus: version.validationStatus,
          advisoryIds: blockedAdvisories.map((advisory) => advisory.id),
        },
      },
    );
  }
  if (!["validated", "verified"].includes(version.validationStatus)) {
    throw new RegistryClientError(
      "registry_version_not_validated",
      `${resolved.packageName}@${resolved.resolvedVersion} is ${version.validationStatus} and is not ready to install.`,
      {
        statusCode: 409,
        retryable:
          version.validationStatus === "pending" ||
          version.validationStatus === "validating",
        action:
          "Wait for Registry validation to finish or choose a verified version.",
        details: {
          packageName: resolved.packageName,
          resolvedVersion: resolved.resolvedVersion,
          validationStatus: version.validationStatus,
        },
      },
    );
  }
  if (!version.manifestChecksum) {
    throw new RegistryClientError(
      "registry_manifest_checksum_missing",
      `Registry did not return a manifest checksum for ${resolved.packageName}.`,
      {
        statusCode: 502,
        action: "Wait for the Registry package to be republished correctly.",
      },
    );
  }
  if (!normalizeSha256Checksum(version.artifactChecksum)) {
    throw new RegistryClientError(
      "registry_artifact_checksum_invalid",
      `Registry did not return a valid sha256 artifact checksum for ${resolved.packageName}.`,
      {
        statusCode: 502,
        action: "Do not install unverified bytes; choose another version.",
        details: { artifactChecksum: version.artifactChecksum },
      },
    );
  }
}

export function normalizeSha256Checksum(value: unknown) {
  const text = String(value ?? "").trim();
  if (/^sha256:[a-f0-9]{64}$/i.test(text)) {
    return text.toLowerCase();
  }
  const dashed = /^sha256-([a-f0-9]{64})$/i.exec(text);
  if (dashed) {
    return `sha256:${dashed[1]?.toLowerCase()}`;
  }
  if (/^[a-f0-9]{64}$/i.test(text)) {
    return `sha256:${text.toLowerCase()}`;
  }
  return null;
}

function normalizeRegistryPackage(value: unknown) {
  const item = recordValue(value);
  const packageName =
    stringValue(item.packageName ?? item.name) ?? "@unknown/unknown";
  const inheritedAdvisories = normalizeAdvisories(item.advisories);
  const rawVersions = arrayValue(item.versions);
  const versions = rawVersions.map((entry) =>
    normalizeRegistryVersion(recordValue(entry), {
      packageName,
      packageStatus: stringValue(item.status),
      packageTrustLevel: stringValue(item.trustLevel),
      inheritedAdvisories,
    }),
  );
  const latestVersion =
    stringValue(item.latestVersion) ?? versions[0]?.version ?? null;
  const rawLatest = recordValue(
    item.latest ?? item.latestVersionInfo ?? item.version,
  );
  const latest = Object.keys(rawLatest).length
    ? normalizeRegistryVersion(rawLatest, {
        packageName,
        packageStatus: stringValue(item.status),
        packageTrustLevel: stringValue(item.trustLevel),
        inheritedAdvisories,
      })
    : (versions.find((version) => version.version === latestVersion) ?? null);
  const latestManifest =
    latest?.manifest ?? recordValue(item.latestManifest ?? item.manifest);
  const catalog = recordValue(latestManifest.catalog);
  const execution = recordValue(latestManifest.execution);
  const runtime = recordValue(latestManifest.runtime);
  const advisories = mergeAdvisories(
    inheritedAdvisories,
    latest?.advisories ?? [],
  );

  return {
    ...item,
    packageName,
    displayName:
      stringValue(item.displayName ?? latestManifest.displayName) ??
      packageName,
    description:
      stringValue(item.description ?? latestManifest.description) ?? null,
    status: stringValue(item.status) ?? latest?.status ?? "active",
    trustLevel:
      stringValue(item.trustLevel ?? latestManifest.trustLevel) ??
      latest?.trustLevel ??
      "external",
    latestVersion,
    versionCount: numberValue(item.versionCount, versions.length),
    latestValidationStatus:
      stringValue(item.latestValidationStatus) ??
      latest?.validationStatus ??
      null,
    latestVersionStatus:
      stringValue(item.latestVersionStatus) ?? latest?.status ?? null,
    latestManifest,
    latestManifestChecksum:
      stringValue(item.latestManifestChecksum) ??
      latest?.manifestChecksum ??
      null,
    latestArtifactChecksum:
      stringValue(item.latestArtifactChecksum) ??
      latest?.artifactChecksum ??
      null,
    latestArtifactReference:
      stringValue(item.latestArtifactReference) ??
      latest?.artifactReference ??
      null,
    latestSourceRegistry:
      stringValue(item.latestSourceRegistry) ??
      latest?.sourceRegistry ??
      "public-registry",
    latestHippiusBucket:
      stringValue(item.latestHippiusBucket) ?? latest?.hippiusBucket ?? null,
    latestHippiusKey:
      stringValue(item.latestHippiusKey) ?? latest?.hippiusKey ?? null,
    category: stringValue(item.category ?? catalog.category) ?? "Workflow",
    categorySlug:
      stringValue(item.categorySlug) ??
      slugify(stringValue(item.category ?? catalog.category) ?? "workflow"),
    visibility: normalizeVisibility(item.visibility),
    repository: normalizeRegistryRepository(item.repository),
    permissions: stringArray(item.permissions ?? latestManifest.permissions),
    placements: stringArray(
      item.placements ?? execution.supportedPlacements ?? runtime.placements,
    ),
    tags: stringArray(item.tags ?? catalog.tags),
    advisories,
    vulnerable:
      booleanValue(item.vulnerable) ||
      advisories.some((advisory) => advisoryIsActive(advisory)),
    versions,
    updatedAt:
      stringValue(item.updatedAt ?? latest?.publishedAt) ??
      new Date(0).toISOString(),
  };
}

function normalizeRegistryVersion(
  value: Record<string, unknown>,
  context: {
    packageName: string;
    packageStatus: string | null;
    packageTrustLevel: string | null;
    inheritedAdvisories: RegistryAdvisory[];
  },
): PublicRegistryVersion {
  const manifest = recordValue(value.manifest) as ActionManifest;
  const provenance = recordValue(value.provenance);
  const advisories = mergeAdvisories(
    context.inheritedAdvisories,
    normalizeAdvisories(value.advisories),
  );
  const hippiusBucket = stringValue(value.hippiusBucket);
  const hippiusKey = stringValue(value.hippiusKey);
  // `artifactUrl` is a signed, expiring capability and never a durable
  // reference; it is carried separately below.
  const registryArtifactUrl = stringValue(
    value.artifactReference ??
      value.registryArtifactUrl ??
      value.downloadUrl ??
      provenance.registryArtifactUrl,
  );
  const artifactReference =
    registryArtifactUrl ??
    (hippiusBucket && hippiusKey
      ? `s3://${hippiusBucket}/${hippiusKey.replace(/^\/+/, "")}`
      : null);
  const status = stringValue(value.status) ?? context.packageStatus ?? "active";
  const trustLevel =
    stringValue(value.trustLevel ?? manifest.trustLevel) ??
    context.packageTrustLevel ??
    "external";

  return {
    version: stringValue(value.version ?? manifest.version) ?? "",
    manifest,
    manifestChecksum: stringValue(value.manifestChecksum),
    artifactChecksum: stringValue(value.artifactChecksum),
    artifactSizeBytes: numberValue(value.artifactSizeBytes, 0),
    artifactReference,
    artifactUrl: validSignedArtifactUrl(value.artifactUrl),
    hippiusBucket,
    hippiusKey,
    hippiusEndpoint: stringValue(value.hippiusEndpoint),
    mediaType:
      stringValue(value.mediaType) ?? "application/vnd.beam.action+gzip",
    signature: stringValue(value.signature),
    provenance,
    sourceRegistry:
      stringValue(value.sourceRegistry ?? provenance.source) ??
      "public-registry",
    trustLevel,
    validationStatus: stringValue(value.validationStatus) ?? "validated",
    status,
    publishedBy: stringValue(value.publishedBy),
    publishedAt: stringValue(value.publishedAt),
    advisories,
    vulnerable:
      booleanValue(value.vulnerable) ||
      advisories.some((advisory) => advisoryIsActive(advisory)),
  };
}

function normalizeAdvisories(value: unknown): RegistryAdvisory[] {
  return arrayValue(value).map((entry, index) => {
    const advisory = recordValue(entry);
    const severity = normalizeSeverity(advisory.severity);
    const status = stringValue(advisory.status) ?? "active";
    return {
      id:
        stringValue(advisory.id ?? advisory.advisoryId) ??
        `registry-advisory-${index + 1}`,
      title:
        stringValue(advisory.title) ??
        stringValue(advisory.summary) ??
        "Security advisory",
      severity,
      status,
      summary: stringValue(advisory.summary ?? advisory.description),
      url: stringValue(advisory.url),
      affectedVersions: stringArray(
        advisory.affectedVersions ?? advisory.affected,
      ),
      patchedVersions: stringArray(
        advisory.patchedVersions ?? advisory.patched,
      ),
      cves: stringArray(advisory.cves ?? advisory.identifiers),
      blocking:
        booleanValue(advisory.blocking ?? advisory.blocked) ||
        status === "blocked",
    };
  });
}

function normalizeVisibility(value: unknown): RegistryPackageVisibility {
  return value === "private" || value === "unlisted" ? value : "public";
}

function normalizeSeverity(value: unknown): RegistryAdvisory["severity"] {
  const severity = String(value ?? "").toLowerCase();
  if (severity === "medium") {
    return "moderate";
  }
  return severity === "low" ||
    severity === "moderate" ||
    severity === "high" ||
    severity === "critical"
    ? severity
    : "unknown";
}

function advisoryIsActive(advisory: RegistryAdvisory) {
  return !["resolved", "withdrawn", "dismissed"].includes(advisory.status);
}

function mergeAdvisories(...groups: RegistryAdvisory[][]) {
  return [
    ...new Map(
      groups.flat().map((advisory) => [advisory.id, advisory] as const),
    ).values(),
  ];
}

function registryPackagePath(packageName: string) {
  const match = /^(@[^/]+)\/(.+)$/.exec(packageName);
  if (!match) {
    return encodeURIComponent(packageName);
  }
  return `${encodeURIComponent(match[1] ?? "")}/${encodeURIComponent(
    match[2] ?? "",
  )}`;
}

function upstreamStatus(status: number) {
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return status;
  }
  return 502;
}

function jsonObject(value: string) {
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(String)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function booleanValue(value: unknown) {
  return value === true || value === "true" || value === 1;
}

function numberValue(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
