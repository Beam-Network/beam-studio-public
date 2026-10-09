import assert from "node:assert/strict";
import test from "node:test";
import type { ActionManifest } from "@beam-studio/core";
import { resolveActionPackageVersionFromRows } from "@beam-studio/db";

const transferManifest: ActionManifest = {
  apiVersion: "workflow-actions/v1",
  name: "@beam/transfer",
  version: "1.2.0",
  trustLevel: "builtin",
  runtime: { placements: ["local-workers"] },
  permissions: [],
  inputs: {},
  outputs: {},
};

test("resolves the highest compatible version after an older version is reseeded", async () => {
  const resolved = resolveActionPackageVersionFromRows(
    [versionRow("1.0.0", "builtin-seed"), versionRow("1.2.0", "public-registry")],
    "@beam/transfer",
    "^1.0.0",
  );

  assert.equal(resolved.version, "1.2.0");
  assert.equal(resolved.sourceRegistry, "public-registry");
  assert.match(resolved.artifactChecksum, /^sha256:/);
  assert.equal(
    resolved.registryArtifactUrl,
    "https://registry.test/1.2.0.tgz",
  );
});

function versionRow(version: string, source: string) {
  const digest = version === "1.2.0" ? "2" : "0";
  return {
    package_version_id: `version-${version}`,
    package_name: transferManifest.name,
    trust_level: "builtin",
    package_metadata_json: { source },
    version,
    manifest_json: { ...transferManifest, version },
    manifest_checksum: `manifest-${version}`,
    artifact_checksum: `sha256:${digest.repeat(64)}`,
    artifact_size_bytes: 4096,
    hippius_bucket: source === "public-registry" ? "registry-bucket" : null,
    hippius_key:
      source === "public-registry" ? `blobs/${version}.tgz` : null,
    hippius_endpoint:
      source === "public-registry" ? "https://s3.hippius.com" : null,
    media_type: "application/gzip",
    provenance_json: {
      source,
      ...(source === "public-registry"
        ? { registryArtifactUrl: `https://registry.test/${version}.tgz` }
        : {}),
    },
    published_at:
      version === "1.0.0"
        ? "2026-08-14T00:00:00.000Z"
        : "2026-08-08T00:00:00.000Z",
  };
}
