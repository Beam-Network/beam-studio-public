import { createHash } from "node:crypto";
import {
  assertBuiltinActionAllowed,
  ActionTrustError,
  type ActionExecute,
  type ActionManifest,
  type RegisteredActionPackage,
} from "./actions.js";
import {
  compareActionVersions,
  parseActionVersion,
} from "./action-versions.js";

export class ActionPackageNotFoundError extends Error {
  constructor(name: string, range: string) {
    super(`Action package "${name}" could not be resolved for range "${range}".`);
    this.name = "ActionPackageNotFoundError";
  }
}

export class RemoteActionInstallError extends Error {
  constructor() {
    super("Remote action installation is disabled in workflow V1.");
    this.name = "RemoteActionInstallError";
  }
}

export type RegisterActionPackageInput = {
  source: "builtin";
  manifest: ActionManifest;
  execute: ActionExecute;
};

export class LocalActionRegistry {
  private packages = new Map<string, RegisteredActionPackage[]>();
  private allowedBuiltinPackages: Set<string> | null;

  constructor(options: { allowedBuiltinPackages?: string[] } = {}) {
    this.allowedBuiltinPackages = options.allowedBuiltinPackages
      ? new Set(options.allowedBuiltinPackages)
      : null;
  }

  registerPackage(input: RegisterActionPackageInput) {
    assertBuiltinActionAllowed(input.manifest);
    if (
      this.allowedBuiltinPackages &&
      !this.allowedBuiltinPackages.has(input.manifest.name)
    ) {
      throw new ActionTrustError(
        `Builtin action "${input.manifest.name}" is not present in the first-party catalog.`,
      );
    }
    if (input.manifest.trustLevel === "blocked" || input.manifest.catalog?.maturity === "blocked") {
      throw new ActionTrustError(
        `Action package "${input.manifest.name}" is blocked and cannot be registered.`,
      );
    }
    const checksum = checksumManifest(input.manifest);
    const registered: RegisteredActionPackage = {
      source: input.source,
      manifest: input.manifest,
      checksum,
      execute: input.execute,
    };
    const versions = this.packages.get(input.manifest.name) ?? [];
    const existingIndex = versions.findIndex(
      (candidate) => candidate.manifest.version === input.manifest.version,
    );
    if (existingIndex >= 0) {
      versions[existingIndex] = registered;
    } else {
      versions.push(registered);
    }
    versions.sort((left, right) =>
      compareActionVersions(right.manifest.version, left.manifest.version),
    );
    this.packages.set(input.manifest.name, versions);
    return registered;
  }

  resolvePackage(name: string, range = "*") {
    const versions = this.packages.get(name) ?? [];
    const resolved = versions.find((candidate) =>
      versionSatisfies(candidate.manifest.version, range),
    );
    if (!resolved) {
      throw new ActionPackageNotFoundError(name, range);
    }
    return resolved;
  }

  listPackages() {
    return [...this.packages.values()].flatMap((versions) => versions);
  }

  installRemote() {
    throw new RemoteActionInstallError();
  }
}

export function checksumManifest(manifest: ActionManifest) {
  return createHash("sha256")
    .update(stableJson(manifest))
    .digest("hex");
}

// Must stay byte-for-byte identical to the public registry's stableJson:
// installPublicRegistryPackage rehashes the fetched manifest with this function
// and rejects the install on any mismatch. Dropping undefined keys matters
// because a manifest authored in TypeScript can carry them, while the same
// manifest arriving as JSON cannot.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function versionSatisfies(version: string, range: string) {
  const normalizedRange = range.trim() || "*";
  if (normalizedRange === "*" || normalizedRange === "latest") {
    return true;
  }
  if (normalizedRange === version) {
    return true;
  }

  const parsedVersion = parseActionVersion(version);
  if (!parsedVersion) {
    return false;
  }
  if (normalizedRange.startsWith("^")) {
    const parsedRange = parseActionVersion(normalizedRange.slice(1));
    return (
      Boolean(parsedRange) &&
      parsedVersion.major === parsedRange?.major &&
      compareActionVersions(version, normalizedRange.slice(1)) >= 0
    );
  }
  if (normalizedRange.startsWith("~")) {
    const parsedRange = parseActionVersion(normalizedRange.slice(1));
    return (
      Boolean(parsedRange) &&
      parsedVersion.major === parsedRange?.major &&
      parsedVersion.minor === parsedRange?.minor &&
      compareActionVersions(version, normalizedRange.slice(1)) >= 0
    );
  }
  return false;
}
