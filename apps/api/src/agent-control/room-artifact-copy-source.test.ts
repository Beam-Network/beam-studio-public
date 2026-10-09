import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artifactCopyCommandSource,
  artifactCopyOriginKey,
  assertArtifactCopyInspection,
  expectedActionArtifactId,
  parseArtifactCopySourceLocator,
} from "./room-artifact-copy-source.js";

const locator = {
  type: "artifact_copy" as const,
  assignmentId: "assignment",
  attempt: 2,
  port: "output",
  index: 0,
  artifactId: "artifact",
  copyId: "copy",
  sha256: `sha256:${"a".repeat(64)}`,
  sizeBytes: 4,
  retentionObligationId: "hold:0",
  requiredUntil: new Date(Date.now() + 86_400_000).toISOString(),
  storageMemberIds: ["storage"],
};

test("artifact copy commands carry only a scoped CopyID and frozen hold", () => {
  assert.equal(
    expectedActionArtifactId({
      assignmentId: "assignment",
      attempt: 2,
      port: "output",
      index: 0,
      sha256: locator.sha256,
    }),
    "7168584aeee1f83116aaaa07b54830fdfb94a82e4b790198f8497a62641f618f",
  );
  assert.deepEqual(artifactCopyCommandSource(locator), {
    assignment_id: "assignment",
    attempt: 2,
    artifact_id: "artifact",
    copy_id: "copy",
    sha256: locator.sha256,
    size_bytes: 4,
    retention_obligation_id: "hold:0",
    required_until: locator.requiredUntil,
  });
  assert.deepEqual(parseArtifactCopySourceLocator(locator), locator);
  assert.throws(() =>
    parseArtifactCopySourceLocator({ ...locator, copyId: "" }),
  );
  const key = artifactCopyOriginKey({
    assignmentId: locator.assignmentId,
    attempt: locator.attempt,
    port: "output",
    index: 0,
    recoveryGeneration: 0,
  });
  assert.notEqual(
    key,
    artifactCopyOriginKey({
      assignmentId: locator.assignmentId,
      attempt: locator.attempt,
      port: "output",
      index: 1,
      recoveryGeneration: 0,
    }),
  );
  assert.notEqual(
    key,
    artifactCopyOriginKey({
      assignmentId: locator.assignmentId,
      attempt: locator.attempt,
      port: "output",
      index: 0,
      recoveryGeneration: 1,
    }),
  );
});

test("inspection must prove the exact copy bytes and retention deadline", () => {
  const source = {
    kind: "output",
    artifact_id: locator.artifactId,
    copy_id: locator.copyId,
    sha256: locator.sha256,
    retained_until: locator.requiredUntil,
    inspected_at: new Date().toISOString(),
    file: { size_bytes: locator.sizeBytes, identity: "immutable-file" },
  };
  assert.doesNotThrow(() => assertArtifactCopyInspection(locator, { source }));
  for (const changed of [
    { ...source, copy_id: "other" },
    { ...source, sha256: `sha256:${"b".repeat(64)}` },
    { ...source, file: { ...source.file, size_bytes: 5 } },
    { ...source, retained_until: new Date(Date.now() - 1000).toISOString() },
  ])
    assert.throws(
      () => assertArtifactCopyInspection(locator, { source: changed }),
      /frozen artifact identity/,
    );
});
