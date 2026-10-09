import assert from "node:assert/strict";
import test from "node:test";
import type { ActionManifest } from "@beam-studio/core";
import {
  resolveActionPackageVersionFromRows,
  versionSatisfies,
} from "@beam-studio/db";
import {
  resolvedStepIdentity,
  workflowStepFromSnapshot,
} from "./postgresOrchestration.js";

const manifest: ActionManifest = {
  apiVersion: "workflow-actions/v1",
  name: "@e2e/registry-smoke",
  version: "0.1.1",
  displayName: "Registry Worker Smoke",
  description: "Remote action regression fixture.",
  author: "Beam E2E",
  trustLevel: "external",
  runtime: {
    placements: ["local-workers"],
  },
  execution: {
    taskMode: "single-worker",
    supportedPlacements: ["local-workers"],
  },
  configSchema: { type: "object" },
  inputs: {},
  outputs: {},
  permissions: [],
};

test("preserves remote action metadata from a workflow run snapshot", () => {
  const step = workflowStepFromSnapshot(
    {
      id: "step_remote",
      actionPackage: manifest.name,
      versionRange: "^0.1.0",
      resolvedVersion: manifest.version,
      checksum: "manifest-sha",
      manifestChecksum: "manifest-sha",
      artifactChecksum: `sha256:${"a".repeat(64)}`,
      artifactSizeBytes: 1544,
      mediaType: "application/gzip",
      sourceRegistry: "public-registry",
      manifestSnapshot: manifest,
      registryArtifactUrl: "https://registry.test/artifact",
      hippiusBucket: "registry-bucket",
      hippiusKey: "blobs/action.tgz",
      hippiusEndpoint: "https://s3.hippius.com",
      config: { count: 21 },
      inputBindings: {},
      resolvedPlacement: "local-workers",
    },
    0,
  );

  assert.equal(step.sourceRegistry, "public-registry");
  assert.equal(step.resolvedVersion, "0.1.1");
  assert.equal(step.artifactChecksum, `sha256:${"a".repeat(64)}`);
  assert.equal(step.hippiusKey, "blobs/action.tgz");
  assert.deepEqual(step.manifestSnapshot, manifest);
  assert.deepEqual(resolvedStepIdentity(step), {
    version: "0.1.1",
    checksum: "manifest-sha",
    sourceRegistry: "public-registry",
  });
});

test("resolves the newest installed version satisfying a caret range", () => {
  const versions = [versionRow("0.1.0"), versionRow("0.1.1")];
  const resolved = resolveActionPackageVersionFromRows(
    versions,
    manifest.name,
    "^0.1.0",
  );

  assert.equal(resolved.version, "0.1.1");
  assert.equal(resolved.sourceRegistry, "public-registry");
  assert.equal(resolved.artifactChecksum, `sha256:${"1".repeat(64)}`);
});

test("semver range checks keep pinned and incompatible versions out", () => {
  assert.equal(versionSatisfies("0.1.1", "^0.1.0"), true);
  assert.equal(versionSatisfies("0.2.0", "~0.1.0"), false);
  assert.equal(versionSatisfies("1.0.0", "^0.1.0"), false);
  assert.equal(versionSatisfies("0.1.1", "0.1.0"), false);
});

function versionRow(version: string) {
  return {
    package_name: manifest.name,
    package_metadata_json: { source: "public-registry" },
    version,
    manifest_json: { ...manifest, version },
    manifest_checksum: `manifest-${version}`,
    artifact_checksum: `sha256:${(version === "0.1.1" ? "1" : "0").repeat(64)}`,
    artifact_size_bytes: 1544,
    hippius_bucket: "registry-bucket",
    hippius_key: `blobs/${version}.tgz`,
    hippius_endpoint: "https://s3.hippius.com",
    media_type: "application/gzip",
    provenance_json: {
      source: "public-registry",
      registryArtifactUrl: `https://registry.test/${version}.tgz`,
    },
    published_at: version,
  };
}
