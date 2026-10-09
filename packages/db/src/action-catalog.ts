import type { ActionManifest } from "@beam-studio/core";
import { pgMany, type PgClient, type PgPool } from "./postgres.js";
type Row = Record<string, unknown>;

export type ResolvedActionPackageVersion = {
  packageVersionId: string;
  packageName: string;
  version: string;
  manifest: ActionManifest;
  manifestChecksum: string;
  artifactChecksum: string;
  artifactSizeBytes: number;
  mediaType: string;
  sourceRegistry: string;
  trustLevel: string;
  artifactReference: string;
  hippiusBucket: string | null;
  hippiusKey: string | null;
  hippiusEndpoint: string | null;
  registryArtifactUrl: string | null;
  provenance: Row;
};

// Embedded in the definition-closure query so graph, tags and artifacts share one MVCC snapshot.
export const actionCatalogSelectSql = `SELECT
  pv.id AS package_version_id,p.package_name,p.trust_level,p.metadata_json AS package_metadata_json,
  pv.version,pv.manifest_json,pv.manifest_checksum,pv.artifact_checksum,pv.artifact_size_bytes,
  pv.hippius_bucket,pv.hippius_key,pv.hippius_endpoint,pv.media_type,pv.provenance_json,pv.published_at,
  COALESCE((SELECT jsonb_agg(dt.tag ORDER BY dt.tag) FROM actions.dist_tags dt WHERE dt.package_id=p.id AND dt.version_id=pv.id),'[]') AS tags
  FROM actions.packages p JOIN actions.package_versions pv ON pv.package_id=p.id`;

/**
 * With an organization, a private Registry package installed by another
 * organization does not resolve; instance-wide packages always do.
 */
export async function resolveActionPackageVersionPg(
  client: PgClient | PgPool,
  packageName: string,
  range = "latest",
  organizationId?: string | null,
): Promise<ResolvedActionPackageVersion> {
  const rows = await pgMany<Row>(
    client,
    organizationId === undefined
      ? `${actionCatalogSelectSql} WHERE p.package_name=$1 AND pv.status IN ('active','deprecated')`
      : `${actionCatalogSelectSql} WHERE p.package_name=$1 AND pv.status IN ('active','deprecated')
        AND (p.organization_id IS NULL OR p.organization_id=$2)`,
    organizationId === undefined
      ? [packageName]
      : [packageName, organizationId?.trim() ?? ""],
  );
  return resolveActionPackageVersionFromRows(rows, packageName, range);
}

export function resolveActionPackageVersionFromRows(
  catalog: Row[],
  packageName: string,
  range = "latest",
): ResolvedActionPackageVersion {
  const normalizedRange = range.trim() || "latest";
  const rows = catalog.filter((row) => row.package_name === packageName);
  const tag = normalizedRange === "*" ? "latest" : normalizedRange;
  const tagged = rows.find(
    (row) => Array.isArray(row.tags) && row.tags.includes(tag),
  );
  const row =
    tagged ??
    rows
      .filter((row) => versionSatisfies(String(row.version), normalizedRange))
      .sort((left, right) =>
        compareVersions(String(right.version), String(left.version)),
      )[0];
  if (!row)
    throw new Error(
      `Action package "${packageName}" could not be resolved for range "${range}".`,
    );
  return resolvedActionFromRow(row);
}

function resolvedActionFromRow(row: Row): ResolvedActionPackageVersion {
  const provenance = objectValue(row.provenance_json);
  const packageMetadata = objectValue(row.package_metadata_json);
  const sourceRegistry = String(
    provenance.source ?? packageMetadata.source ?? "local-registry",
  );
  const artifactReference = resolvedArtifactReference({
    artifactChecksum: row.artifact_checksum,
    hippiusBucket: row.hippius_bucket,
    hippiusKey: row.hippius_key,
    packageName: row.package_name,
    provenance,
    sourceRegistry,
    version: row.version,
  });
  return {
    packageVersionId: String(row.package_version_id),
    packageName: String(row.package_name),
    version: String(row.version),
    manifest: objectValue(row.manifest_json) as ActionManifest,
    manifestChecksum: String(row.manifest_checksum),
    artifactChecksum: String(row.artifact_checksum),
    artifactSizeBytes: Number(row.artifact_size_bytes ?? 0),
    mediaType: String(row.media_type ?? "application/javascript"),
    sourceRegistry,
    trustLevel: String(
      provenance.registryTrustLevel ?? row.trust_level ?? "external",
    ),
    artifactReference,
    hippiusBucket: row.hippius_bucket ? String(row.hippius_bucket) : null,
    hippiusKey: row.hippius_key ? String(row.hippius_key) : null,
    hippiusEndpoint: row.hippius_endpoint ? String(row.hippius_endpoint) : null,
    registryArtifactUrl: provenance.registryArtifactUrl
      ? String(provenance.registryArtifactUrl)
      : null,
    provenance,
  };
}

function resolvedArtifactReference(input: {
  artifactChecksum: unknown;
  hippiusBucket: unknown;
  hippiusKey: unknown;
  packageName: unknown;
  provenance: Row;
  sourceRegistry: string;
  version: unknown;
}) {
  const registryReference =
    input.provenance.artifactReference ?? input.provenance.registryArtifactUrl;
  if (registryReference) {
    return String(registryReference);
  }
  if (input.hippiusBucket && input.hippiusKey) {
    return `s3://${String(input.hippiusBucket)}/${String(input.hippiusKey).replace(/^\/+/, "")}`;
  }
  return `${input.sourceRegistry}:${String(input.packageName)}@${String(input.version)}#${String(input.artifactChecksum)}`;
}

export function versionSatisfies(version: string, range: string) {
  if (range === "*" || range === "latest" || range === version) {
    return true;
  }
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) {
    return false;
  }
  if (range.startsWith("^")) {
    const parsedRange = parseVersion(range.slice(1));
    return (
      Boolean(parsedRange) &&
      parsedVersion.major === parsedRange?.major &&
      compareVersions(version, range.slice(1)) >= 0
    );
  }
  if (range.startsWith("~")) {
    const parsedRange = parseVersion(range.slice(1));
    return (
      Boolean(parsedRange) &&
      parsedVersion.major === parsedRange?.major &&
      parsedVersion.minor === parsedRange?.minor &&
      compareVersions(version, range.slice(1)) >= 0
    );
  }
  return false;
}

function compareVersions(left: string, right: string) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }
  return (
    parsedLeft.major - parsedRight.major ||
    parsedLeft.minor - parsedRight.minor ||
    parsedLeft.patch - parsedRight.patch
  );
}

function parseVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function objectValue(value: unknown): Row {
  if (!value) {
    return {};
  }
  if (typeof value !== "string") {
    return typeof value === "object" && !Array.isArray(value)
      ? (value as Row)
      : {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Row)
      : {};
  } catch {
    return {};
  }
}
