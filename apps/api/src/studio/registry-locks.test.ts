import assert from "node:assert/strict";
import test from "node:test";
import type { ActionManifest } from "@beam-studio/core";
import type { PgClient, PgPool } from "@beam-studio/db";
import {
  createTraceContext,
  formatTraceparent,
} from "@beam-studio/telemetry";
import type { ResolvedActionPackageVersion } from "@beam-studio/db";
import { RegistryClientError } from "./registry-client.js";
import {
  assertPublicVersionIdentityAvailablePg,
  diffWorkflowActionLocks,
  listHistoryBackedWorkflowStepIdsPg,
  workflowActionLockConfirmationError,
  workflowActionLockFromResolved,
} from "./store.js";
import { startWorkflowRunPg } from "./workflow-runs.js";

const waitManifest: ActionManifest = {
  name: "@beam/wait",
  version: "1.2.3",
  displayName: "Wait",
  apiVersion: "workflow-actions/v1",
  runtime: { placements: ["local-workers"] },
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["milliseconds"],
    properties: { milliseconds: { type: "integer" } },
  },
  permissions: [],
  trustLevel: "verified",
  catalog: {
    category: "Workflow",
    maturity: "stable",
    owner: "Beam",
    tags: ["wait"],
    changelog: [],
  },
};

const resolvedWait: ResolvedActionPackageVersion = {
  packageVersionId: "act_ver_wait_1_2_3",
  packageName: "@beam/wait",
  version: "1.2.3",
  manifest: waitManifest,
  manifestChecksum: "manifest-wait-1.2.3",
  artifactChecksum: `sha256:${"b".repeat(64)}`,
  artifactSizeBytes: 4096,
  mediaType: "application/vnd.beam.action+gzip",
  sourceRegistry: "public-registry",
  trustLevel: "verified",
  artifactReference:
    "https://registry.test/v1/packages/%40beam/wait/versions/1.2.3/artifact",
  hippiusBucket: null,
  hippiusKey: null,
  hippiusEndpoint: null,
  registryArtifactUrl:
    "https://registry.test/v1/packages/%40beam/wait/versions/1.2.3/artifact",
  provenance: { source: "public-registry" },
};

test("workflow lock snapshots preserve exact wait action identity", () => {
  const lock = workflowActionLockFromResolved({
    actionPackageName: "@beam/wait",
    createdAt: "2026-08-06T12:00:00.000Z",
    lockId: "wfl_step_wait",
    resolved: resolvedWait,
    versionRange: "^1.2.0",
    workflowTemplateId: "wft_wait",
  });

  assert.deepEqual(lock, {
    id: "wfl_step_wait",
    workflowTemplateId: "wft_wait",
    actionPackageName: "@beam/wait",
    versionRange: "^1.2.0",
    resolvedVersion: "1.2.3",
    packageVersionId: "act_ver_wait_1_2_3",
    manifestChecksum: "manifest-wait-1.2.3",
    artifactChecksum: `sha256:${"b".repeat(64)}`,
    artifactReference:
      "https://registry.test/v1/packages/%40beam/wait/versions/1.2.3/artifact",
    sourceRegistry: "public-registry",
    trustLevel: "verified",
    createdAt: "2026-08-06T12:00:00.000Z",
  });
});

test("installed wait versions cannot be overwritten with different checksums", async () => {
  const client = {
    query: async () => ({
      rows: [
        {
          manifest_checksum: "manifest-wait-1.2.3",
          artifact_checksum: `sha256:${"b".repeat(64)}`,
        },
      ],
      rowCount: 1,
    }),
  } as unknown as PgClient;

  await assert.doesNotReject(
    assertPublicVersionIdentityAvailablePg(client, {
      packageName: "@beam/wait",
      version: "1.2.3",
      manifestChecksum: "manifest-wait-1.2.3",
      artifactChecksum: `sha256:${"b".repeat(64)}`,
    }),
  );
  await assert.rejects(
    assertPublicVersionIdentityAvailablePg(client, {
      packageName: "@beam/wait",
      version: "1.2.3",
      manifestChecksum: "different-manifest",
      artifactChecksum: `sha256:${"c".repeat(64)}`,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RegistryClientError);
      assert.equal(error.code, "registry_version_identity_conflict");
      assert.equal(error.statusCode, 409);
      assert.match(error.action, /Do not replace the installed bytes/);
      return true;
    },
  );
});

test("workflow lock comparison warns before wait identity updates and removals", () => {
  const current = workflowActionLockFromResolved({
    actionPackageName: "@beam/wait",
    createdAt: "2026-08-06T12:00:00.000Z",
    lockId: "wfl_step_wait",
    resolved: { ...resolvedWait, version: "1.2.2" },
    versionRange: "^1.2.0",
    workflowTemplateId: "wft_wait",
  });
  const next = workflowActionLockFromResolved({
    actionPackageName: "@beam/wait",
    createdAt: current.createdAt,
    lockId: current.id,
    resolved: resolvedWait,
    versionRange: "^1.2.0",
    workflowTemplateId: "wft_wait",
  });
  const changes = diffWorkflowActionLocks([current], [next]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, "update");
  assert.equal(changes[0]?.previous.resolvedVersion, "1.2.2");
  assert.equal(changes[0]?.next?.resolvedVersion, "1.2.3");
  assert.equal(
    changes[0]?.next?.artifactChecksum,
    resolvedWait.artifactChecksum,
  );

  const confirmation = workflowActionLockConfirmationError(changes);
  assert.equal(confirmation.code, "workflow_action_lock_confirmation_required");
  assert.equal(confirmation.statusCode, 409);
  assert.deepEqual(confirmation.details.lockChanges, changes);

  const removal = diffWorkflowActionLocks([current], []);
  assert.equal(removal[0]?.kind, "remove");
  assert.equal(removal[0]?.next, null);
});

test("history-backed workflow step lookup covers execution references", async () => {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      assert.deepEqual(values, [["step_a", "step_b", "step_c"]]);
      for (const table of [
        "execution.workflow_dynamic_instances",
        "execution.workflow_step_runs",
        "execution.workflow_tasks",
        "execution.execution_plans",
        "execution.execution_plan_nodes",
      ]) {
        assert.match(sql, new RegExp(table.replace(".", "\\.")));
      }
      return {
        rows: [{ workflow_step_id: "step_a" }, { workflow_step_id: "step_c" }],
        rowCount: 2,
      };
    },
  } as unknown as PgClient;

  assert.deepEqual(
    await listHistoryBackedWorkflowStepIdsPg(client, [
      "step_a",
      "step_b",
      "step_c",
    ]),
    ["step_a", "step_c"],
  );
});

test("queued wait run snapshot retains the lock identity returned by resolution", async () => {
  let resolvedSteps: Array<Record<string, unknown>> = [];
  let stepConfig: Record<string, unknown> = { milliseconds: 25 };
  let insertedRuns = 0;
  let runMetadata: Record<string, unknown> = {};
  let eventCorrelationId: unknown;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT organization_id FROM workflow.templates")) {
        return {
          rows: [
            {
              id: "wft_wait",
              organization_id: "org_test",
              name: "Wait workflow",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("has_active_runner")) {
        return { rows: [{ has_active_runner: true }], rowCount: 1 };
      }
      if (sql.includes("WITH RECURSIVE reachable")) {
        return {
          rows: [
            {
              id: "wft_wait",
              organization_id: "org_test",
              name: "Wait workflow",
              enabled: true,
              api_key_id: "execution-key",
              graph_version: "workflow-graph/v1",
              input_schema_json: { type: "object" },
              output_contract_json: {
                schema: { type: "object" },
                bindings: {},
              },
              steps: [
                {
                  id: "step_wait",
                  kind: "action",
                  workflow_template_id: "wft_wait",
                  action_package_name: "@beam/wait",
                  action_version_range: "^1.2.0",
                  position: 0,
                  enabled: true,
                  config_json: stepConfig,
                  input_bindings_json: {},
                  placement: "local-workers",
                  required: true,
                },
              ],
              edges: [],
              triggers: [],
              trigger_edges: [],
              decisions: [],
              decision_edges: [],
              action_locks: [],
              action_catalog: [
            {
              package_version_id: resolvedWait.packageVersionId,
              package_name: resolvedWait.packageName,
              trust_level: resolvedWait.trustLevel,
              package_metadata_json: { source: "public-registry" },
              version: resolvedWait.version,
              manifest_json: resolvedWait.manifest,
              manifest_checksum: resolvedWait.manifestChecksum,
              artifact_checksum: resolvedWait.artifactChecksum,
              artifact_size_bytes: resolvedWait.artifactSizeBytes,
              hippius_bucket: resolvedWait.hippiusBucket,
              hippius_key: resolvedWait.hippiusKey,
              hippius_endpoint: resolvedWait.hippiusEndpoint,
              media_type: resolvedWait.mediaType,
              provenance_json: {
                source: resolvedWait.sourceRegistry,
                registryTrustLevel: resolvedWait.trustLevel,
                registryArtifactUrl: resolvedWait.artifactReference,
              },
              published_at: "2026-08-06T12:00:00.000Z",
            },
          ],
            },
          ],
          rowCount: 1,
        };
      }
      if (
        sql.includes("FROM workflow.edges") ||
        sql.includes("FROM workflow.triggers") ||
        sql.includes("FROM workflow.trigger_edges") ||
        sql.includes("JOIN actions.dist_tags")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO execution.workflow_runs")) {
        insertedRuns += 1;
        resolvedSteps = JSON.parse(String(values[9] ?? "[]")) as Array<
          Record<string, unknown>
        >;
        runMetadata = JSON.parse(String(values[11] ?? "{}")) as Record<
          string,
          unknown
        >;
        return { rows: [{ id: values[0] }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO execution.workflow_events")) {
        eventCorrelationId = values[3];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as PgPool;

  const traceContext = createTraceContext("api-request");
  const workflowRunId = await startWorkflowRunPg(
    pool,
    "wft_wait",
    { requestedBy: "contract-test" },
    { traceContext },
  );
  const waitStep = resolvedSteps[0];
  assert.ok(waitStep);
  assert.equal(waitStep.actionPackage, "@beam/wait");
  assert.equal(waitStep.resolvedVersion, resolvedWait.version);
  assert.equal(waitStep.manifestChecksum, resolvedWait.manifestChecksum);
  assert.equal(waitStep.artifactChecksum, resolvedWait.artifactChecksum);
  assert.equal(waitStep.artifactReference, resolvedWait.artifactReference);
  assert.equal(waitStep.sourceRegistry, resolvedWait.sourceRegistry);
  assert.equal(waitStep.trustLevel, resolvedWait.trustLevel);
  assert.deepEqual(waitStep.manifestSnapshot, waitManifest);
  assert.deepEqual(runMetadata, {
    observability: {
      correlationId: workflowRunId,
      traceparent: formatTraceparent(traceContext),
    },
  });
  assert.equal(eventCorrelationId, workflowRunId);
  assert.equal(insertedRuns, 1);

  stepConfig = { environment: "dev" };
  await assert.rejects(
    startWorkflowRunPg(pool, "wft_wait"),
    /config\.milliseconds is required.*config\.environment is not allowed/,
  );
  assert.equal(insertedRuns, 1);
});
