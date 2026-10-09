import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import {
  readWorkflowArtifactContent,
  type ContentDependencies,
} from "./workflow-artifact-content.js";

const bytes = Buffer.from("accepted counter bytes", "utf8");
const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const scope = {
  organizationId: "organization_a",
  projectId: "project_a",
  runId: "run_a",
  artifactId: "artifact_a",
};
const mediaType = "application/vnd.beam.term-counts.v1+json";
const entry = {
  artifactId: scope.artifactId,
  port: "counts",
  index: 0,
  sha256,
  sizeBytes: bytes.length,
  mediaType,
};
const artifact = {
  workflow_run_id: scope.runId,
  organization_id: scope.organizationId,
  project_id: scope.projectId,
  manifest_id: "manifest_a",
  manifest_status: "accepted",
  task_id: "task_a",
  workflow_step_run_id: "step_run_a",
  assignment_id: "assignment_a",
  attempt: 1,
  artifact_id: scope.artifactId,
  sha256,
  size_bytes: bytes.length,
  media_type: mediaType,
  artifacts_json: [entry],
  result_json: {
    artifactManifest: { publicationId: "assignment_a", artifacts: [entry] },
    artifacts: [{
      id: scope.artifactId,
      mediaType,
      uri: `data:${mediaType};base64,${bytes.toString("base64")}`,
      metadata: {
        port: "counts",
        sha256,
        bytes: bytes.length,
        workflowRunId: scope.runId,
        stepRunId: "step_run_a",
        taskId: "task_a",
        assignmentId: "assignment_a",
        attempt: 1,
      },
    }],
  },
};
const pool = {} as PgPool;
function dependencies(first: object | null = artifact, second?: object | null) {
  let calls = 0;
  const deps = {
    findAcceptedArtifact: async () => (++calls === 1 ? first : second === undefined ? first : second),
  } as ContentDependencies;
  return { deps, calls: () => calls };
}

test("serves only currently accepted, scoped and digest-verified result bytes", async () => {
  const { deps, calls } = dependencies();
  assert.deepEqual(await readWorkflowArtifactContent(pool, scope, deps), {
    status: "ok", bytes, mediaType, sha256,
  });
  assert.equal(calls(), 2);
});

test("organization-scoped artifacts require an exact null project match", async () => {
  const orgScope = { ...scope, projectId: null };
  const orgArtifact = { ...artifact, project_id: null };
  assert.deepEqual(
    await readWorkflowArtifactContent(pool, orgScope, dependencies(orgArtifact).deps),
    { status: "ok", bytes, mediaType, sha256 },
  );
  assert.deepEqual(
    await readWorkflowArtifactContent(pool, orgScope, dependencies().deps),
    { status: "not_found" },
  );
  assert.deepEqual(
    await readWorkflowArtifactContent(pool, scope, dependencies(orgArtifact).deps),
    { status: "not_found" },
  );
});

test("database selection uses null-safe exact project equality", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const scopedPool = {
    query: async (sql: string, values: unknown[]) => {
      statements.push({ sql, values });
      return { rows: [{ ...artifact, project_id: null }] };
    },
  } as unknown as PgPool;
  assert.equal(
    (await readWorkflowArtifactContent(
      scopedPool, { ...scope, projectId: null },
    )).status,
    "ok",
  );
  assert.equal(statements.length, 2);
  for (const statement of statements) {
    assert.match(statement.sql, /r\.project_id IS NOT DISTINCT FROM \$3::text/);
    assert.deepEqual(statement.values, [
      scope.runId, scope.organizationId, null, scope.artifactId,
    ]);
  }
});

test("organization, project, run and artifact mismatches return 404", async () => {
  for (const field of ["organizationId", "projectId", "runId", "artifactId"] as const) {
    const { deps } = dependencies();
    assert.deepEqual(
      await readWorkflowArtifactContent(pool, { ...scope, [field]: "other" }, deps),
      { status: "not_found" },
    );
  }
  assert.deepEqual(
    await readWorkflowArtifactContent(pool, scope, dependencies(null).deps),
    { status: "not_found" },
  );
});

test("unavailable or changed manifest cannot reveal retained bytes", async () => {
  for (const [first, second] of [
    [{ ...artifact, manifest_status: "unavailable" }, undefined],
    [artifact, { ...artifact, manifest_status: "unavailable" }],
    [artifact, null],
    [artifact, { ...artifact, manifest_id: "another_manifest" }],
  ] as const) {
    assert.deepEqual(
      await readWorkflowArtifactContent(pool, scope, dependencies(first, second).deps),
      { status: "unavailable" },
    );
  }
});

test("mismatched, malformed, oversized and missing result bytes fail closed", async () => {
  const result = artifact.result_json;
  const output = result.artifacts[0]!;
  for (const changed of [
    { ...artifact, size_bytes: 32 * 1024 + 1 },
    { ...artifact, artifacts_json: [{ ...entry, sha256: `sha256:${"0".repeat(64)}` }] },
    { ...artifact, result_json: { ...result, artifacts: [] } },
    { ...artifact, result_json: { ...result, artifactManifest: { publicationId: "other", artifacts: [entry] } } },
    { ...artifact, result_json: { ...result, artifacts: [{ ...output, uri: `data:${mediaType};base64,###` }] } },
    { ...artifact, result_json: { ...result, artifacts: [{ ...output, uri: `data:${mediaType};base64,${Buffer.from("wrong").toString("base64")}` }] } },
    { ...artifact, result_json: { ...result, artifacts: [{ ...output, metadata: { ...output.metadata, taskId: "other" } }] } },
  ]) {
    assert.deepEqual(
      await readWorkflowArtifactContent(pool, scope, dependencies(changed).deps),
      { status: "unavailable" },
    );
  }
});
