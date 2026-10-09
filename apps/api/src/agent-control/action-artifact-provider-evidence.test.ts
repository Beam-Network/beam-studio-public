import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { providerArtifactAttestation } from "./action-artifact-provider-evidence.js";

const bytes = Buffer.from("bounded artifact");
const input = {
  provider: {
    bucket: "bucket",
    key: "object",
    access_key_id: "key",
    secret_access_key: "secret",
  },
  artifactId: "artifact",
  memberId: "storage-member",
  locator: "transfer",
  sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  bytes,
  versionId: "version-1",
  etag: '"etag"',
  requiredUntil: "2030-01-02T00:00:00.000Z",
};
const observed = {
  versionId: "version-1",
  etag: '"etag"',
  readback: bytes,
  retentionMode: "COMPLIANCE",
  retainedUntil: new Date("2030-01-03T00:00:00.000Z"),
};

test("provider proof pins readback bytes, version, and compliance retention", () => {
  assert.equal(
    providerArtifactAttestation(input, observed)?.versionId,
    "version-1",
  );
  for (const change of [
    { readback: Buffer.from("different") },
    { versionId: "version-2" },
    { etag: '"other"' },
    { retentionMode: "GOVERNANCE" },
    { retainedUntil: new Date("2030-01-01T00:00:00.000Z") },
  ]) {
    assert.equal(
      providerArtifactAttestation(input, { ...observed, ...change }),
      null,
    );
  }
});
