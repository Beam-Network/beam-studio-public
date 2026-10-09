export type RegistryData = {
  categories?: RegistryCategory[];
  packages?: RegistryPackage[];
};

export type RegistryCategory = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  packageCount: number;
};

export type RegistryPackage = {
  id: string;
  packageName: string;
  scope: string;
  name: string;
  displayName: string;
  description?: string | null;
  category?: string | null;
  categorySlug?: string | null;
  visibility: string;
  status: string;
  trustLevel: string;
  latestVersion?: string | null;
  versionCount: number;
  latestValidationStatus?: string | null;
  latestVersionStatus?: string | null;
  latestManifestChecksum?: string | null;
  latestArtifactChecksum?: string | null;
  latestArtifactReference?: string | null;
  latestSourceRegistry?: string | null;
  latestHippiusBucket?: string | null;
  latestHippiusKey?: string | null;
  latestManifest?: Record<string, unknown> | null;
  versions?: RegistryPackageVersion[];
  advisories?: RegistryAdvisory[];
  vulnerable?: boolean;
  installedVersion?: string | null;
  publicLatestVersion?: string | null;
  installState?: RegistryInstallState;
  installedManifest?: Record<string, unknown> | null;
  availableManifest?: Record<string, unknown> | null;
  installedIdentity?: RegistryActionIdentity | null;
  availableIdentity?: RegistryActionIdentity | null;
  installedStatus?: string | null;
  availableStatus?: string | null;
  permissions?: string[];
  placements?: string[];
  tags?: string[];
  repository?: RegistryRepository | null;
  updatedAt: string;
};

/**
 * How the installed release relates to the Registry's latest one.
 *
 * `identity-conflict` means both carry the same version but different bytes.
 * A version must identify one artifact, and the API refuses to install a second
 * artifact under an installed version, so this is neither "installed" nor
 * something an update can resolve.
 */
export type RegistryInstallState =
  | "not-installed"
  | "installed"
  | "update-available"
  | "identity-conflict";

/** Package-level source repository, as the Registry stores it. */
export type RegistryRepository = {
  url: string;
  directory?: string | null;
};

export type RegistryRepositoryLink = {
  href: string;
  label: string;
  /** Shown as text when it cannot be part of the link. */
  directory: string | null;
};

export type RegistryPackageVersion = {
  version: string;
  manifest: Record<string, unknown>;
  manifestChecksum?: string | null;
  artifactChecksum?: string | null;
  artifactSizeBytes?: number;
  artifactReference?: string | null;
  sourceRegistry?: string | null;
  trustLevel?: string | null;
  validationStatus?: string | null;
  status: string;
  publishedAt?: string | null;
  advisories?: RegistryAdvisory[];
  vulnerable?: boolean;
};

export type RegistryAdvisory = {
  id: string;
  title: string;
  severity: "low" | "moderate" | "high" | "critical" | "unknown";
  status: string;
  summary?: string | null;
  url?: string | null;
  affectedVersions?: string[];
  patchedVersions?: string[];
  cves?: string[];
  blocking?: boolean;
};

export type RegistryActionIdentity = {
  version: string;
  manifestChecksum: string | null;
  artifactChecksum: string | null;
  artifactReference: string | null;
  sourceRegistry: string;
  trustLevel: string;
};

export type RegistryManifestDifference = {
  field: string;
  installed: string;
  available: string;
};

export function registryPackagePath(
  item: Pick<RegistryPackage, "packageName">,
) {
  const parsed = parseScopedPackageName(item.packageName);
  return `/registry/${pathSegment(parsed.scope)}/${pathSegment(parsed.name)}`;
}

export function registryPackageNameFromParams(scope: string, name: string) {
  return `${decodePathSegment(scope)}/${decodePathSegment(name)}`;
}

export function titleCase(value: string) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function shortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export function mergeRegistryPackages(
  localPackages: RegistryPackage[],
  publicPackages: RegistryPackage[],
) {
  const localByName = new Map(
    localPackages.map((item) => [item.packageName, item]),
  );
  const publicByName = new Map(
    publicPackages.map((item) => [item.packageName, item]),
  );
  const names = new Set([...localByName.keys(), ...publicByName.keys()]);
  const merged: RegistryPackage[] = [];
  for (const packageName of names) {
    const local = localByName.get(packageName);
    const publicPackage = publicByName.get(packageName);
    const base = publicPackage ?? local;
    if (!base) {
      continue;
    }
    const installedVersion = local?.latestVersion ?? null;
    const publicLatestVersion = publicPackage?.latestVersion ?? null;
    const installState = registryInstallState(local, publicPackage);
    merged.push({
      ...base,
      advisories: mergeAdvisories(
        local?.advisories ?? [],
        publicPackage?.advisories ?? [],
      ),
      vulnerable: Boolean(local?.vulnerable || publicPackage?.vulnerable),
      installedVersion,
      publicLatestVersion,
      installState,
      installedManifest: local?.latestManifest ?? null,
      availableManifest: publicPackage?.latestManifest ?? null,
      installedIdentity: local ? registryActionIdentity(local) : null,
      availableIdentity: publicPackage
        ? registryActionIdentity(publicPackage)
        : null,
      installedStatus: local?.status ?? null,
      availableStatus: publicPackage?.status ?? null,
    });
  }
  return merged.sort((left, right) =>
    left.packageName.localeCompare(right.packageName),
  );
}

function registryInstallState(
  local: RegistryPackage | undefined,
  publicPackage: RegistryPackage | undefined,
): RegistryInstallState {
  const installedVersion = local?.latestVersion ?? null;
  if (!local || !installedVersion) {
    return "not-installed";
  }
  const publicLatestVersion = publicPackage?.latestVersion ?? null;
  if (!publicPackage || !publicLatestVersion) {
    return "installed";
  }
  const order = compareVersions(publicLatestVersion, installedVersion);
  if (order > 0) {
    return "update-available";
  }
  if (order === 0 && !sameReleaseIdentity(local, publicPackage)) {
    return "identity-conflict";
  }
  return "installed";
}

/**
 * Whether the installed release and the Registry's release are the same bytes.
 *
 * Built-in actions ship inside Studio and record `sha256:<manifest checksum>`
 * as their artifact checksum, so only their manifest is comparable with a
 * published release. A checksum that either side does not report is not
 * evidence of a difference.
 */
function sameReleaseIdentity(
  local: RegistryPackage,
  publicPackage: RegistryPackage,
) {
  const differs = (left?: string | null, right?: string | null) => {
    const installed = normalizedChecksum(left);
    const available = normalizedChecksum(right);
    return Boolean(installed && available && installed !== available);
  };
  if (
    differs(local.latestManifestChecksum, publicPackage.latestManifestChecksum)
  ) {
    return false;
  }
  if (local.latestSourceRegistry === "builtin") {
    return true;
  }
  return !differs(
    local.latestArtifactChecksum,
    publicPackage.latestArtifactChecksum,
  );
}

function normalizedChecksum(value?: string | null) {
  return (value ?? "")
    .trim()
    .replace(/^sha256[:-]/i, "")
    .toLowerCase();
}

export function compareVersions(left: string, right: string) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) {
    return left.localeCompare(right);
  }
  return (
    leftParts.major - rightParts.major ||
    leftParts.minor - rightParts.minor ||
    leftParts.patch - rightParts.patch ||
    left.localeCompare(right)
  );
}

/**
 * A link to the package's source, or null. Only `https:` URLs without
 * credentials are linked, so a hostile value such as `javascript:` never
 * reaches an href. A directory is appended as `/tree/HEAD/<directory>` for
 * GitHub, whose layout is known; elsewhere it is shown next to the link.
 */
export function registryRepositoryLink(
  repository: RegistryRepository | null | undefined,
): RegistryRepositoryLink | null {
  if (!repository || typeof repository.url !== "string") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(repository.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return null;
  }
  const directory = repositoryDirectory(repository.directory);
  const path = url.pathname.replace(/\/+$/, "");
  const label = `${url.host}${path}`;
  if (directory && url.hostname === "github.com") {
    const repositoryPath = path.replace(/\.git$/, "");
    const tree = directory.split("/").map(encodeURIComponent).join("/");
    return {
      href: `${url.origin}${repositoryPath}/tree/HEAD/${tree}`,
      label: `${url.host}${repositoryPath}/${directory}`,
      directory: null,
    };
  }
  return { href: url.toString(), label, directory };
}

function repositoryDirectory(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const directory = value.trim().replace(/\/+$/, "");
  if (
    !directory ||
    directory.length > 512 ||
    directory.startsWith("/") ||
    directory.split(/[\\/]/).some((part) => part === ".." || part === "")
  ) {
    return null;
  }
  return directory;
}

export function registryPackageStates(item: RegistryPackage) {
  const states: Array<{
    id: string;
    label: string;
    tone: "neutral" | "success" | "warning" | "danger";
  }> = [];
  if (item.installState === "installed") {
    states.push({ id: "installed", label: "Installed", tone: "success" });
  } else if (item.installState === "update-available") {
    states.push({
      id: "update-available",
      label: "Update available",
      tone: "warning",
    });
  } else if (item.installState === "identity-conflict") {
    states.push({
      id: "identity-conflict",
      label: "Differs from Registry",
      tone: "warning",
    });
  } else {
    states.push({ id: "available", label: "Available", tone: "neutral" });
  }
  if (
    item.status === "blocked" ||
    item.latestVersionStatus === "blocked" ||
    item.latestVersionStatus === "yanked" ||
    item.trustLevel === "blocked" ||
    item.latestValidationStatus === "blocked" ||
    item.latestValidationStatus === "rejected"
  ) {
    states.push({ id: "blocked", label: "Blocked", tone: "danger" });
  } else if (
    item.status === "deprecated" ||
    item.latestVersionStatus === "deprecated"
  ) {
    states.push({
      id: "deprecated",
      label: "Deprecated",
      tone: "warning",
    });
  }
  if (item.vulnerable) {
    states.push({
      id: "vulnerable",
      label: "Vulnerable",
      tone: "danger",
    });
  } else if (item.advisories?.length) {
    states.push({
      id: "advisory",
      label: `${item.advisories.length} advisor${item.advisories.length === 1 ? "y" : "ies"}`,
      tone: "warning",
    });
  }
  return states;
}

/** Whether the Registry offers something this Studio can install. */
export function registryInstallable(item: RegistryPackage) {
  return (
    (item.installState === "not-installed" ||
      item.installState === "update-available") &&
    !registryInstallBlockedReason(item)
  );
}

/**
 * Explains an identity conflict. The installed release stays usable; only
 * installing the Registry's release under the same version is refused.
 */
export function registryIdentityConflictMessage(item: RegistryPackage) {
  return item.installState === "identity-conflict"
    ? `The Registry publishes different contents under the installed version ${item.installedVersion}. Studio keeps using the installed release; the publisher has to release the change under a new version.`
    : null;
}

export function registryInstallBlockedReason(item: RegistryPackage) {
  if (item.status === "blocked" || item.trustLevel === "blocked") {
    return "The Registry has blocked this package.";
  }
  if (
    item.latestVersionStatus === "blocked" ||
    item.latestVersionStatus === "yanked"
  ) {
    return `The Registry marked this version as ${item.latestVersionStatus}.`;
  }
  if (
    item.latestValidationStatus === "blocked" ||
    item.latestValidationStatus === "rejected"
  ) {
    return "The available version did not pass Registry validation.";
  }
  const blocking = item.advisories?.filter((advisory) => advisory.blocking);
  if (blocking?.length) {
    return `Installation is blocked by ${blocking.length} security advisory${blocking.length === 1 ? "" : "ies"}.`;
  }
  return null;
}

export function compareRegistryManifests(item: RegistryPackage) {
  if (!item.installedManifest || !item.availableManifest) {
    return [];
  }
  const installed = item.installedManifest;
  const available = item.availableManifest;
  const fields: Array<[string, unknown, unknown]> = [
    ["Version", item.installedVersion, item.publicLatestVersion],
    [
      "Manifest checksum",
      item.installedIdentity?.manifestChecksum,
      item.availableIdentity?.manifestChecksum,
    ],
    [
      "Artifact checksum",
      item.installedIdentity?.artifactChecksum,
      item.availableIdentity?.artifactChecksum,
    ],
    [
      "Trust",
      item.installedIdentity?.trustLevel,
      item.availableIdentity?.trustLevel,
    ],
    ["Permissions", installed.permissions, available.permissions],
    [
      "Placements",
      recordValue(installed.runtime).placements,
      recordValue(available.runtime).placements,
    ],
    ["Execution", installed.execution, available.execution],
    ["Configuration schema", installed.configSchema, available.configSchema],
    ["Inputs", installed.inputs, available.inputs],
    ["Outputs", installed.outputs, available.outputs],
  ];
  return fields.flatMap(([field, previous, next]) => {
    const previousText = displayValue(previous);
    const nextText = displayValue(next);
    return previousText === nextText
      ? []
      : [{ field, installed: previousText, available: nextText }];
  });
}

function registryActionIdentity(item: RegistryPackage): RegistryActionIdentity {
  return {
    version: item.latestVersion ?? "unknown",
    manifestChecksum: item.latestManifestChecksum ?? null,
    artifactChecksum: item.latestArtifactChecksum ?? null,
    artifactReference: item.latestArtifactReference ?? null,
    sourceRegistry: item.latestSourceRegistry ?? "local-registry",
    trustLevel: item.trustLevel,
  };
}

function mergeAdvisories(left: RegistryAdvisory[], right: RegistryAdvisory[]) {
  return [
    ...new Map(
      [...left, ...right].map((advisory) => [advisory.id, advisory] as const),
    ).values(),
  ];
}

function parseVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
      }
    : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function displayValue(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function parseScopedPackageName(packageName: string) {
  const [scope, ...nameParts] = packageName.split("/");
  return {
    scope: scope || "unscoped",
    name: nameParts.join("/") || packageName,
  };
}

function pathSegment(value: string) {
  return encodeURIComponent(value).replace("%40", "@");
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
