import {
  credentialSecretReaderPg,
  WorkflowAuthorizationError,
  WorkflowAuthorityUnavailableError,
} from "@beam-studio/db";
import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PgClient, PgPool } from "@beam-studio/db";
import { encryptString, vaultSecretFromEnv } from "@beam-studio/vault";
import {
  ActionExecutionError,
  type RegisteredActionPackage,
} from "@beam-studio/core";
import type {
  WorkflowObjectStorageEndpoint,
  ClaimedWorkflowTask,
} from "./services/taskTypes.js";
import {
  actionTimeoutMs,
  assertRunnerSupportsActionManifest,
  createPostgresTaskWorker as createWorker,
  taskCancellationPollIntervalMs,
  taskLeaseHeartbeatIntervalMs,
  startTaskLeaseHeartbeat,
} from "./services/postgresTaskWorker.js";

test("Runner refuses a pinned Registry v2 manifest before resolving or executing it", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/core/src/workflows/fixtures/registry-v2/v2-single.valid.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.throws(
    () => assertRunnerSupportsActionManifest(manifest),
    /enforced CPU and peak-memory limits/,
  );
  assert.doesNotThrow(() =>
    assertRunnerSupportsActionManifest({
      ...manifest,
      apiVersion: "workflow-actions/v1",
    }),
  );
});

let fixtureDirectory: string;
beforeEach(async () => {
  fixtureDirectory = await mkdtemp(
    path.join(os.tmpdir(), "beam-task-fixture-"),
  );
});
afterEach(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});
function createPostgresTaskWorker(
  ...[pool, options]: Parameters<typeof createWorker>
) {
  return createWorker(pool, {
    actionCacheDir: path.join(fixtureDirectory, "cache"),
    ...options,
  });
}

test("task cancellation polling stays prompt without shortening the lease", () => {
  assert.equal(taskLeaseHeartbeatIntervalMs(15 * 60_000), 5 * 60_000);
  assert.equal(taskCancellationPollIntervalMs(), 1_000);
  assert.equal(taskCancellationPollIntervalMs(10), 25);
});

test("authority outage preserves the existing lease, fresh recovery renews it, and revocation stops it", async () => {
  const controller = new AbortController();
  let checks = 0,
    revoked = false;
  const pool = new MockPgPool({
    directQuery: () => ({ rows: [{ id: "task" }], rowCount: 1 }),
  });
  const task = {
    id: "task",
    attempt: 1,
    workflowRunId: "run",
    workflowStepId: "step",
    claimToken: "claim",
    leaseExpiresAt: new Date(Date.now() + 2_000).toISOString(),
  } as ClaimedWorkflowTask;
  const heartbeat = startTaskLeaseHeartbeat(
    pool as unknown as PgPool,
    task,
    {
      lockTtlMs: 2_000,
      logger: noopLogger(),
      authorizeExecution: async () => {
        checks++;
        if (revoked)
          throw new WorkflowAuthorizationError("execution_target_revoked");
        if (checks === 1) throw new WorkflowAuthorityUnavailableError();
      },
    },
    controller,
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(checks, 1);
    assert.equal(controller.signal.aborted, false);
    assert.equal(pool.clients.length, 0, "outage must not extend the lease");
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    assert.equal(
      controller.signal.aborted,
      false,
      "fresh recovery renews beyond the original deadline",
    );
    assert.ok(
      pool.clients.some((client) =>
        client.queries.some((query) =>
          query.sql.includes(
            "UPDATE execution.executor_assignments SET lease_expires_at",
          ),
        ),
      ),
    );
    revoked = true;
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(controller.signal.aborted, true);
    assert.equal(controller.signal.reason.code, "execution_target_revoked");
  } finally {
    heartbeat.stop();
  }
});

test("persistent authority outage expires the original lease without renewal", async () => {
  const controller = new AbortController();
  const pool = new MockPgPool({
    directQuery: () => ({ rows: [{ id: "task" }], rowCount: 1 }),
  });
  const task = {
    id: "task",
    claimToken: "claim",
    leaseExpiresAt: new Date(Date.now() + 500).toISOString(),
  } as ClaimedWorkflowTask;
  const heartbeat = startTaskLeaseHeartbeat(
    pool as unknown as PgPool,
    task,
    {
      lockTtlMs: 500,
      logger: noopLogger(),
      authorizeExecution: async () => {
        throw new WorkflowAuthorityUnavailableError();
      },
    },
    controller,
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(controller.signal.aborted, true);
    assert.equal(
      controller.signal.reason.message,
      "Workflow task lease expired.",
    );
    assert.equal(pool.clients.length, 0);
  } finally {
    heartbeat.stop();
  }
});

test("action timeout precedence limits extended runtimes to trusted allowlisted Beam actions", () => {
  const transferManifest = {
    name: "@beam/transfer",
    version: "1.2.2",
    apiVersion: "workflow-actions/v1" as const,
    runtime: { placements: ["local-workers" as const] },
    execution: {
      isolation: "trusted-node" as const,
      defaultTimeoutSeconds: 3_900,
    },
    inputs: {},
    outputs: {},
    trustLevel: "verified" as const,
  };
  const allowed = { trustedNodeActionPackages: ["@beam/transfer"] };

  assert.equal(
    actionTimeoutMs(
      { timeoutSeconds: 120, sourceRegistry: "public-registry" },
      transferManifest,
      allowed,
    ),
    120_000,
  );
  assert.equal(
    actionTimeoutMs(
      { timeoutSeconds: null, sourceRegistry: "public-registry" },
      transferManifest,
      allowed,
    ),
    3_900_000,
  );
  assert.equal(
    actionTimeoutMs(
      { timeoutSeconds: null, sourceRegistry: "other-registry" },
      transferManifest,
      allowed,
    ),
    300_000,
  );
  assert.equal(
    actionTimeoutMs(
      { timeoutSeconds: null, sourceRegistry: "public-registry" },
      { ...transferManifest, name: "@example/action" },
      allowed,
    ),
    300_000,
  );
});

test("credential reads reuse an audited version across retries without storing plaintext", async () => {
  const secret = vaultSecretFromEnv();
  const versions = {
    cv_one: encryptString(JSON.stringify({ token: "first-secret" }), secret),
    cv_two: encryptString(JSON.stringify({ token: "rotated-secret" }), secret),
  };
  let latestVersionId: keyof typeof versions = "cv_one";
  let auditedVersionId: string | null = null;
  const auditSnapshots: unknown[] = [];
  const clientOptions = () => ({
    query(sql: string, values?: unknown[]) {
      if (sql.includes("INSERT INTO actions.credential_requirements")) {
        return { rows: [{ id: "acr_source" }], rowCount: 1 };
      }
      if (sql.includes("FROM execution.workflow_step_credential_uses")) {
        return {
          rows: auditedVersionId
            ? [{ credential_version_id: auditedVersionId }]
            : [],
          rowCount: auditedVersionId ? 1 : 0,
        };
      }
      if (sql.includes("FROM secrets.credentials c")) {
        const selected = String(
          values?.[2] ?? latestVersionId,
        ) as keyof typeof versions;
        return {
          rows: [
            {
              credential_version_id: selected,
              credential_version: selected === "cv_one" ? 1 : 2,
              encrypted_payload: versions[selected],
              credential_type: "s3-compatible",
              credential_provider: "r2",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO execution.workflow_step_credential_uses")) {
        auditedVersionId ??= String(values?.[4]);
        auditSnapshots.push(JSON.parse(String(values?.[7])));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  });
  const pool = new MockPgPool({ clients: [clientOptions(), clientOptions()] });
  const context = {
    organizationId: "org-one",
    workflowRunId: "wfr-one",
    workflowStepRunId: "wsr-one",
    packageName: "@beam/transfer",
    packageVersion: "1.2.2",
    manifest: {
      name: "@beam/transfer",
      version: "1.2.2",
      apiVersion: "workflow-actions/v1" as const,
      runtime: { placements: ["local-workers" as const] },
      inputs: {},
      outputs: {},
      catalog: {
        category: "transfer",
        maturity: "stable" as const,
        owner: "Beam",
        tags: [],
        changelog: [],
        credentialRequirements: [
          {
            key: "source-credentials",
            displayName: "Source credentials",
            required: true,
            cardinality: "many" as const,
            configPaths: ["inputs.sourceEndpoints[*].credentialId"],
          },
        ],
      },
    },
    config: {},
    inputs: {
      sourceEndpoints: [{ credentialId: "cred-source" }],
    },
  };

  const first = await credentialSecretReaderPg(
    pool as unknown as PgPool,
    context,
  )("cred-source");
  latestVersionId = "cv_two";
  const retried = await credentialSecretReaderPg(
    pool as unknown as PgPool,
    context,
  )("cred-source");

  assert.equal(first, JSON.stringify({ token: "first-secret" }));
  assert.equal(retried, first);
  assert.equal(auditedVersionId, "cv_one");
  assert.deepEqual(auditSnapshots, [
    { credentialType: "s3-compatible", provider: "r2", version: 1 },
    { credentialType: "s3-compatible", provider: "r2", version: 1 },
  ]);
  assert.equal(JSON.stringify(auditSnapshots).includes("first-secret"), false);
});

test("PostgreSQL task worker ignores notifications for unclaimable tasks", async () => {
  const pool = new MockPgPool();
  const worker = createPostgresTaskWorker(pool as unknown as PgPool, {
    authorizeExecution: async () => {},
    workerId: "worker-one",
    concurrency: 3,
    lockTtlMs: 60_000,
    maxAttempts: 3,
    logger: noopLogger(),
    async downloadObject() {
      return {};
    },
    async uploadObject() {
      return {};
    },
    async deleteObject() {
      return {};
    },
  });

  const result = await worker.processTaskId("task-one");

  assert.deepEqual(result, { status: "ignored" });
  assert.equal(pool.clients.length, 1);
  assert.equal(pool.directQueries.length, 0);

  const queries = pool.clients[0]?.queries ?? [];
  assert.equal(queries[0]?.sql, "BEGIN");
  const claim = queries.find((query) =>
    query.sql.includes("UPDATE execution.workflow_tasks"),
  );
  assert.match(claim?.sql ?? "", /UPDATE execution\.workflow_tasks/);
  assert.match(claim?.sql ?? "", /status IN \('queued', 'retry_scheduled'\)/);
  assert.match(
    claim?.sql ?? "",
    /target_worker_id IS NULL OR target_worker_id = \$2/,
  );
  assert.deepEqual(claim?.values?.slice(0, 2), ["task-one", "worker-one"]);
  assert.equal(queries.at(-1)?.sql, "COMMIT");
  assert.equal(pool.clients[0]?.released, true);
});

test("PostgreSQL task worker executes an action with config, inputs, and declared permissions", async () => {
  const downloadedEndpoints: WorkflowObjectStorageEndpoint[] = [];
  let completedOutputs: Record<string, unknown> | null = null;
  const taskRow = workflowTaskRow({
    input_json: {
      endpoint: {
        provider: "s3",
        bucket: "source-bucket",
        objectKey: "folder/file.txt",
        credentialId: "cred_s3",
      },
    },
  });
  const pool = new MockPgPool({
    clients: [
      {
        query(sql) {
          if (
            sql.includes(
              "UPDATE execution.workflow_tasks SET status = 'running'",
            )
          ) {
            return { rows: [taskRow], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      {
        query(sql, values) {
          if (sql.includes("UPDATE execution.workflow_tasks SET status=$2")) {
            completedOutputs = JSON.parse(
              String(values?.[2] ?? "{}"),
            ) as Record<string, unknown>;
            return { rows: [{ id: "task-one" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
    ],
    directQuery(sql) {
      if (sql.includes("FROM execution.workflow_step_runs")) {
        return {
          rows: [{ id: "wsr-one", state_json: "{}" }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM execution.workflow_runs")) {
        return {
          rows: [
            {
              id: "run-one",
              status: "running",
              resolved_steps_json: JSON.stringify([
                {
                  id: "step-download",
                  actionPackage: "@beam/download",
                  resolvedVersion: "1.0.0",
                  config: { mediaType: "text/plain" },
                },
              ]),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  });
  const worker = createPostgresTaskWorker(pool as unknown as PgPool, {
    authorizeExecution: async () => {},
    workerId: "worker-one",
    concurrency: 3,
    lockTtlMs: 60_000,
    maxAttempts: 3,
    logger: noopLogger(),
    async downloadObject(endpoint) {
      downloadedEndpoints.push(endpoint);
      return {
        content: "hello",
        bytes: 5,
        mediaType: "text/plain",
      };
    },
    async uploadObject() {
      return {};
    },
    async deleteObject() {
      return {};
    },
  });

  const result = await worker.processTaskId("task-one");

  assert.deepEqual(result, { status: "completed" });
  assert.deepEqual(downloadedEndpoints, [
    {
      name: undefined,
      provider: "s3",
      bucket: "source-bucket",
      objectKey: "folder/file.txt",
      sourceType: "file",
      region: undefined,
      endpointUrl: undefined,
      credentialId: "cred_s3",
    },
  ]);
  assert.deepEqual(completedOutputs, {
    content: "hello",
    uri: "memory://downloads/file.txt",
    bytes: 5,
  });
});

test("PostgreSQL task worker exposes object storage delete with declared permission", async () => {
  const deletedEndpoints: WorkflowObjectStorageEndpoint[] = [];
  let completedOutputs: Record<string, unknown> | null = null;
  const taskRow = workflowTaskRow({
    action_package_name: "@beam/object-storage-delete",
    workflow_step_id: "step-delete",
    workflow_step_run_id: "wsr-delete",
    input_json: {
      endpoint: {
        provider: "r2",
        bucket: "beam-bucx-15",
        objectKey: "r2-1tb/scheduled/lane-7/object-a.bin",
        credentialId: "cred_ben_r2",
      },
    },
  });
  const pool = new MockPgPool({
    clients: [
      {
        query(sql) {
          if (
            sql.includes(
              "UPDATE execution.workflow_tasks SET status = 'running'",
            )
          ) {
            return { rows: [taskRow], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      {
        query(sql, values) {
          if (sql.includes("UPDATE execution.workflow_tasks SET status=$2")) {
            completedOutputs = JSON.parse(
              String(values?.[2] ?? "{}"),
            ) as Record<string, unknown>;
            return { rows: [{ id: "task-one" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
    ],
    directQuery(sql) {
      if (sql.includes("FROM execution.workflow_step_runs")) {
        return {
          rows: [{ id: "wsr-delete", state_json: "{}" }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM execution.workflow_runs")) {
        return {
          rows: [
            {
              id: "run-one",
              status: "running",
              resolved_steps_json: JSON.stringify([
                {
                  id: "step-delete",
                  actionPackage: "@beam/object-storage-delete",
                  resolvedVersion: "1.0.0",
                  config: {},
                },
              ]),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  });
  const actionPackage: RegisteredActionPackage = {
    source: "builtin",
    checksum: "sha256:test",
    manifest: {
      name: "@beam/object-storage-delete",
      version: "1.0.0",
      apiVersion: "workflow-actions/v1",
      runtime: { placements: ["local-workers"] },
      inputs: {},
      outputs: {},
      permissions: ["storage:delete"],
    },
    async execute({ inputs }, context) {
      const objectStorage = context.beam.objectStorage as {
        delete(endpoint: WorkflowObjectStorageEndpoint): Promise<{
          uri?: string;
        }>;
      };
      const endpoint = inputs.endpoint as WorkflowObjectStorageEndpoint;
      const result = await objectStorage.delete(endpoint);
      return { outputs: { uri: result.uri ?? "" } };
    },
  };
  const worker = createPostgresTaskWorker(pool as unknown as PgPool, {
    authorizeExecution: async () => {},
    workerId: "worker-one",
    concurrency: 1,
    lockTtlMs: 60_000,
    maxAttempts: 3,
    logger: noopLogger(),
    resolveActionPackage: async () => actionPackage,
    async downloadObject() {
      return {};
    },
    async uploadObject() {
      return {};
    },
    async deleteObject(endpoint) {
      deletedEndpoints.push(endpoint);
      return { uri: `s3://${endpoint.bucket}/${endpoint.objectKey}` };
    },
  });

  const result = await worker.processTaskId("task-one");

  assert.deepEqual(result, { status: "completed" });
  assert.deepEqual(deletedEndpoints, [
    {
      provider: "r2",
      bucket: "beam-bucx-15",
      objectKey: "r2-1tb/scheduled/lane-7/object-a.bin",
      credentialId: "cred_ben_r2",
    },
  ]);
  assert.deepEqual(completedOutputs, {
    uri: "s3://beam-bucx-15/r2-1tb/scheduled/lane-7/object-a.bin",
  });
});

for (const scenario of [
  "recovery",
  "revocation",
  "configuration",
  "expiry",
  "cancellation",
] as const) {
  test(`prelaunch authority: ${scenario}`, async () => {
    const name = "@beam/custom";
    let dispatchChecks = 0,
      executions = 0,
      resolutions = 0;
    const manifest = {
      name,
      version: "1.0.0",
      apiVersion: "workflow-actions/v1" as const,
      runtime: { placements: ["local-workers" as const] },
      inputs: {},
      outputs: {},
    };
    const leaseMs = scenario === "expiry" ? 500 : 5_000;
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const taskRow = workflowTaskRow({
      action_package_name: name,
      lease_expires_at: leaseExpiresAt,
    });
    const pool = new MockPgPool({
      clients: [
        {
          query(sql) {
            return {
              rows: sql.includes(
                "UPDATE execution.workflow_tasks SET status = 'running'",
              )
                ? [taskRow]
                : [],
              rowCount: 1,
            };
          },
        },
        {
          query() {
            return { rows: [{ id: "task-one" }], rowCount: 1 };
          },
        },
      ],
      directQuery(sql) {
        if (
          scenario === "cancellation" &&
          dispatchChecks > 0 &&
          sql.startsWith("SELECT id FROM execution.workflow_tasks")
        )
          return { rows: [], rowCount: 0 };
        if (sql.includes("FROM execution.workflow_step_runs"))
          return { rows: [{ id: "wsr-one", state_json: {} }], rowCount: 1 };
        if (sql.includes("FROM execution.workflow_runs"))
          return {
            rows: [
              {
                id: "run-one",
                status: "running",
                resolved_steps_json: [
                  {
                    id: "step-download",
                    actionPackage: name,
                    resolvedVersion: "1.0.0",
                    manifestSnapshot: manifest,
                    config: {},
                  },
                ],
              },
            ],
            rowCount: 1,
          };
        return { rows: [{ id: "task-one" }], rowCount: 1 };
      },
    });
    const worker = createPostgresTaskWorker(pool as unknown as PgPool, {
      workerId: "worker-one",
      concurrency: 1,
      lockTtlMs: leaseMs,
      cancellationPollIntervalMs: 25,
      maxAttempts: 3,
      logger: noopLogger(),
      authorizeExecution: async (_pool, input) => {
        if (input.phase === "resource") return;
        if (input.phase === "lease_renewal")
          throw new WorkflowAuthorityUnavailableError();
        dispatchChecks++;
        if (scenario === "revocation")
          throw new WorkflowAuthorizationError("execution_target_revoked");
        if (scenario === "configuration")
          throw new WorkflowAuthorizationError(
            "execution_authority_configuration_invalid",
          );
        if (scenario !== "recovery" || dispatchChecks < 3)
          throw new WorkflowAuthorityUnavailableError();
      },
      resolveActionPackage: async () => {
        resolutions++;
        assert.equal(dispatchChecks, 3, "resolution requires fresh authority");
        return {
          source: "builtin",
          checksum: "sha256:test",
          manifest,
          execute: async () => {
            executions++;
            return { outputs: {} };
          },
        };
      },
      async downloadObject() {
        return {};
      },
      async uploadObject() {
        return {};
      },
      async deleteObject() {
        return {};
      },
    });
    const result = await worker.processTaskId("task-one");
    const recovered = scenario === "recovery";
    assert.equal(executions, recovered ? 1 : 0);
    assert.equal(resolutions, recovered ? 1 : 0);
    assert.equal(result.status === "completed", recovered);
    if (scenario === "expiry")
      assert.ok(
        Date.now() >= Date.parse(leaseExpiresAt),
        "persistent outage waits until the existing lease expires",
      );
    if (scenario === "cancellation")
      assert.ok(
        pool.directQueries.some((query) =>
          query.sql.startsWith("SELECT id FROM execution.workflow_tasks"),
        ),
        "the existing cancellation fence must stop the wait",
      );
    if (["revocation", "configuration", "cancellation"].includes(scenario))
      assert.equal(dispatchChecks, 1, "denial or cancellation must not retry");
    const queries = pool.clients.flatMap((client) => client.queries);
    assert.equal(
      queries.filter((query) =>
        query.sql.includes(
          "UPDATE execution.workflow_tasks SET status = 'running'",
        ),
      ).length,
      1,
      "prelaunch recovery retains the same business attempt",
    );
    assert.equal(
      queries.some((query) =>
        query.sql.includes(
          "UPDATE execution.executor_assignments SET lease_expires_at",
        ),
      ),
      false,
      "unavailable authority cannot renew the claim",
    );
  });
}

for (const scenario of [
  "room recovery",
  "room revocation",
  "generic unchanged",
] as const) {
  test(`result commit authority: ${scenario}`, async () => {
    const name =
      scenario === "generic unchanged" ? "@beam/custom" : "@beam/room-transfer";
    let authorizationCalls = 0,
      executions = 0;
    const manifest = {
      name,
      version: "2.1.2",
      apiVersion: "workflow-actions/v1" as const,
      runtime: { placements: ["local-workers" as const] },
      execution: { isolation: "trusted-node" as const },
      trustLevel: "verified" as const,
      inputs: {},
      outputs: {},
    };
    const taskRow = workflowTaskRow({ action_package_name: name });
    const pool = new MockPgPool({
      clients: [
        {
          query(sql) {
            return {
              rows: sql.includes(
                "UPDATE execution.workflow_tasks SET status = 'running'",
              )
                ? [taskRow]
                : [],
              rowCount: 1,
            };
          },
        },
        {
          query() {
            return { rows: [{ id: "task-one" }], rowCount: 1 };
          },
        },
      ],
      directQuery(sql) {
        if (sql.includes("FROM execution.workflow_step_runs"))
          return { rows: [{ id: "wsr-one", state_json: {} }], rowCount: 1 };
        if (sql.includes("FROM execution.workflow_runs"))
          return {
            rows: [
              {
                id: "run-one",
                status: "running",
                resolved_steps_json: [
                  {
                    id: "step-download",
                    actionPackage: name,
                    resolvedVersion: "2.1.2",
                    sourceRegistry: "public-registry",
                    manifestSnapshot: manifest,
                    config: {},
                  },
                ],
              },
            ],
            rowCount: 1,
          };
        return { rows: [{ id: "task-one" }], rowCount: 1 };
      },
    });
    const worker = createPostgresTaskWorker(pool as unknown as PgPool, {
      workerId: "worker-one",
      concurrency: 1,
      lockTtlMs: 60_000,
      maxAttempts: 3,
      trustedNodeActionPackages: [name],
      logger: noopLogger(),
      authorizeExecution: async (_pool, input) => {
        if (input.phase !== "resource") return;
        authorizationCalls++;
        if (scenario === "room revocation")
          throw new WorkflowAuthorizationError("execution_target_revoked");
        if (authorizationCalls < 3)
          throw new WorkflowAuthorityUnavailableError();
      },
      resolveActionPackage: async () => ({
        source: "builtin",
        checksum: "sha256:test",
        manifest,
        execute: async () => {
          executions++;
          return { outputs: { receipts: 3 } };
        },
      }),
      async downloadObject() {
        return {};
      },
      async uploadObject() {
        return {};
      },
      async deleteObject() {
        return {};
      },
    });
    const result = await worker.processTaskId("task-one");
    assert.equal(
      executions,
      1,
      "authorization recovery must not repeat delivery",
    );
    assert.equal(authorizationCalls, scenario === "room recovery" ? 3 : 1);
    if (scenario === "room recovery")
      assert.deepEqual(result, { status: "completed" });
    else assert.notEqual(result.status, "completed");
  });
}

test("PostgreSQL task worker uses frozen Beam deployment defaults", async () => {
  let actionConfig: Record<string, unknown> | undefined;
  const taskRow = workflowTaskRow({
    action_package_name: "@beam/transfer",
    workflow_step_id: "step-transfer",
    workflow_step_run_id: "wsr-transfer",
  });
  const pool = new MockPgPool({
    clients: [
      {
        query(sql) {
          if (
            sql.includes(
              "UPDATE execution.workflow_tasks SET status = 'running'",
            )
          ) {
            return { rows: [taskRow], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      {
        query(sql) {
          if (sql.includes("UPDATE execution.workflow_tasks SET status=$2")) {
            return { rows: [{ id: "task-one" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
    ],
    directQuery(sql) {
      if (sql.includes("FROM execution.workflow_step_runs")) {
        return {
          rows: [{ id: "wsr-transfer", state_json: "{}" }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM execution.workflow_runs")) {
        return {
          rows: [
            {
              id: "run-one",
              status: "running",
              execution_context_json: {
                environment: "dev",
                beam: {
                  defaults: {
                    natsUrl: "nats://127.0.0.1:4222",
                    environment: "dev",
                  },
                  credentials: {},
                  knownCredentialIds: [],
                },
              },
              resolved_steps_json: JSON.stringify([
                {
                  id: "step-transfer",
                  actionPackage: "@beam/transfer",
                  resolvedVersion: "1.2.18",
                  sourceRegistry: "public-registry",
                  config: { apiKey: "fixture-beam-api-key" },
                },
              ]),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  });
  const actionPackage: RegisteredActionPackage = {
    source: "remote",
    checksum: "sha256:test",
    manifest: {
      name: "@beam/transfer",
      version: "1.2.18",
      apiVersion: "workflow-actions/v1",
      runtime: { placements: ["local-workers"] },
      configSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          natsUrl: { type: "string" },
          environment: { type: "string" },
        },
      },
      inputs: {},
      outputs: {},
    },
    execute(input) {
      actionConfig = input.config;
      return { outputs: { transferId: "transfer-one" } };
    },
  };
  const worker = createPostgresTaskWorker(pool as unknown as PgPool, {
    authorizeExecution: async () => {},
    workerId: "worker-one",
    concurrency: 1,
    lockTtlMs: 60_000,
    maxAttempts: 3,
    logger: noopLogger(),
    trustedNodeActionPackages: ["@beam/transfer"],
    resolveActionPackage: async () => actionPackage,
    async downloadObject() {
      return {};
    },
    async uploadObject() {
      return {};
    },
    async deleteObject() {
      return {};
    },
  });

  const result = await worker.processTaskId("task-one");

  assert.deepEqual(result, { status: "completed" });
  assert.ok(actionConfig);
  assert.equal(actionConfig.natsUrl, "nats://127.0.0.1:4222");
  assert.equal(actionConfig.environment, "dev");
});

test("PostgreSQL task worker uses frozen PROD credential metadata despite current metadata changes", async () => {
  let actionConfig: Record<string, unknown> | undefined;
  const taskRow = workflowTaskRow({
    action_package_name: "@beam/transfer",
    workflow_step_id: "step-transfer",
    workflow_step_run_id: "wsr-transfer",
  });
  const pool = new MockPgPool({
    clients: [
      {
        query(sql) {
          if (
            sql.includes(
              "UPDATE execution.workflow_tasks SET status = 'running'",
            )
          ) {
            return { rows: [taskRow], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      {
        query(sql) {
          if (sql.includes("UPDATE execution.workflow_tasks SET status=$2")) {
            return { rows: [{ id: "task-one" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
    ],
    directQuery(sql) {
      if (sql.includes("FROM execution.workflow_step_runs")) {
        return {
          rows: [{ id: "wsr-transfer", state_json: "{}" }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM execution.workflow_runs")) {
        return {
          rows: [
            {
              id: "run-one",
              organization_id: "org-one",
              status: "running",
              execution_context_json: {
                environment: "prod",
                beam: {
                  defaults: {
                    baseUrl: "http://127.0.0.1:8000",
                    natsUrl: "nats://127.0.0.1:4222",
                    environment: "dev",
                  },
                  credentials: {
                    "cred-prod": {
                      baseUrl: "https://beamcore.b1m.ai",
                      natsUrl: "tls://orch-gateway.b1m.ai:4222",
                      environment: "prod",
                    },
                  },
                  knownCredentialIds: ["cred-prod"],
                },
              },
              resolved_steps_json: JSON.stringify([
                {
                  id: "step-transfer",
                  actionPackage: "@beam/transfer",
                  resolvedVersion: "1.2.18",
                  sourceRegistry: "public-registry",
                  config: { credentialId: "cred-prod" },
                },
              ]),
            },
          ],
          rowCount: 1,
        };
      }
      assert.doesNotMatch(
        sql,
        /FROM secrets.credentials|JOIN secrets.credentials/,
      );
      return { rows: [], rowCount: 1 };
    },
  });
  const actionPackage: RegisteredActionPackage = {
    source: "remote",
    checksum: "sha256:test",
    manifest: {
      name: "@beam/transfer",
      version: "1.2.18",
      apiVersion: "workflow-actions/v1",
      runtime: { placements: ["local-workers"] },
      configSchema: {
        type: "object",
        additionalProperties: true,
        properties: {
          baseUrl: { type: "string" },
          natsUrl: { type: "string" },
          environment: { type: "string" },
        },
      },
      inputs: {},
      outputs: {},
    },
    execute(input) {
      actionConfig = input.config;
      return { outputs: { transferId: "transfer-one" } };
    },
  };
  const worker = createPostgresTaskWorker(pool as unknown as PgPool, {
    authorizeExecution: async () => {},
    workerId: "worker-one",
    concurrency: 1,
    lockTtlMs: 60_000,
    maxAttempts: 3,
    logger: noopLogger(),
    trustedNodeActionPackages: ["@beam/transfer"],
    resolveActionPackage: async () => actionPackage,
    async downloadObject() {
      return {};
    },
    async uploadObject() {
      return {};
    },
    async deleteObject() {
      return {};
    },
  });

  const result = await worker.processTaskId("task-one");

  assert.deepEqual(result, { status: "completed" });
  assert.ok(actionConfig);
  assert.equal(actionConfig.baseUrl, "https://beamcore.b1m.ai");
  assert.equal(actionConfig.natsUrl, "tls://orch-gateway.b1m.ai:4222");
  assert.equal(actionConfig.environment, "prod");
});

test("PostgreSQL task worker immediately dead-letters non-retryable action errors", async () => {
  const { pool, result } = await runFailingAction(false);

  assert.deepEqual(result, { status: "dead_letter" });
  const queries = pool.clients[1]?.queries ?? [];
  const taskUpdate = queries.find((query) =>
    query.sql.includes("UPDATE execution.workflow_tasks SET status=$2"),
  );
  assert.equal(taskUpdate?.values?.[6], false);
  const deadLetter = queries.find((query) =>
    query.sql.includes("INSERT INTO execution.workflow_task_dead_letters"),
  );
  assert.equal(deadLetter?.values?.[4], "non_retryable");
  assert.deepEqual(workflowEventTypes(queries), ["TaskDeadLettered"]);
});

test("PostgreSQL task worker keeps unflagged action errors retryable", async () => {
  const { pool, result } = await runFailingAction();

  assert.equal(result.status, "retry");
  const queries = pool.clients[1]?.queries ?? [];
  const taskUpdate = queries.find((query) =>
    query.sql.includes("UPDATE execution.workflow_tasks SET status=$2"),
  );
  assert.equal(taskUpdate?.values?.[6], true);
  assert.equal(
    queries.some((query) =>
      query.sql.includes("INSERT INTO execution.workflow_task_dead_letters"),
    ),
    false,
  );
  assert.deepEqual(workflowEventTypes(queries), ["TaskRetryScheduled"]);
});

async function runFailingAction(retryable?: boolean) {
  const taskRow = workflowTaskRow({
    action_package_name: "@example/fail",
    workflow_step_id: "step-fail",
  });
  const pool = new MockPgPool({
    clients: [
      {
        query(sql) {
          if (
            sql.includes(
              "UPDATE execution.workflow_tasks SET status = 'running'",
            )
          ) {
            return { rows: [taskRow], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      {
        query(sql, values) {
          if (sql.includes("SET status = CASE")) {
            return {
              rows: [
                {
                  status: values?.[5] ? "retry_scheduled" : "dead_letter",
                  organization_id: "org-one",
                },
              ],
              rowCount: 1,
            };
          }
          if (sql.includes("UPDATE execution.workflow_runs")) {
            const completedAt = new Date().toISOString();
            return {
              rows: [{ started_at: completedAt, completed_at: completedAt }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 1 };
        },
      },
    ],
    directQuery(sql) {
      if (sql.includes("FROM execution.workflow_step_runs")) {
        return {
          rows: [{ id: "wsr-one", state_json: "{}" }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM execution.workflow_runs")) {
        return {
          rows: [
            {
              id: "run-one",
              organization_id: "org-one",
              status: "running",
              resolved_steps_json: JSON.stringify([
                {
                  id: "step-fail",
                  actionPackage: "@example/fail",
                  resolvedVersion: "1.0.0",
                  config: {},
                },
              ]),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  });
  const actionPackage: RegisteredActionPackage = {
    source: "builtin",
    checksum: "sha256:test",
    manifest: {
      name: "@example/fail",
      version: "1.0.0",
      apiVersion: "workflow-actions/v1",
      runtime: { placements: ["local-workers"] },
      inputs: {},
      outputs: {},
    },
    execute() {
      throw new ActionExecutionError("expected action failure", {
        retryable,
      });
    },
  };
  const worker = createPostgresTaskWorker(pool as unknown as PgPool, {
    authorizeExecution: async () => {},
    workerId: "worker-one",
    concurrency: 1,
    lockTtlMs: 60_000,
    maxAttempts: 3,
    logger: noopLogger(),
    resolveActionPackage: async () => actionPackage,
    async downloadObject() {
      return {};
    },
    async uploadObject() {
      return {};
    },
    async deleteObject() {
      return {};
    },
  });

  return { pool, result: await worker.processTaskId("task-one") };
}

function workflowEventTypes(
  queries: Array<{ sql: string; values?: unknown[] }>,
) {
  return queries
    .filter((query) =>
      query.sql.includes("INSERT INTO execution.workflow_events"),
    )
    .map((query) => String(query.values?.[5]));
}

class MockPgPool {
  readonly clients: MockPgClient[] = [];
  readonly directQueries: Array<{ sql: string; values?: unknown[] }> = [];

  constructor(private readonly options: MockPgPoolOptions = {}) {}

  async connect() {
    const client = new MockPgClient(
      this.options.clients?.[this.clients.length],
    );
    this.clients.push(client);
    return client as unknown as PgClient;
  }

  async query(sql: string, values?: unknown[]) {
    const compactSql = compact(sql);
    this.directQueries.push({ sql: compactSql, values });
    return (
      this.options.directQuery?.(compactSql, values) ?? {
        rows: [],
        rowCount: 0,
      }
    );
  }
}

class MockPgClient {
  readonly queries: Array<{ sql: string; values?: unknown[] }> = [];
  released = false;

  constructor(private readonly options: MockPgClientOptions = {}) {}

  async query(sql: string, values?: unknown[]) {
    const compactSql = compact(sql);
    this.queries.push({ sql: compactSql, values });
    if (compactSql.includes("SELECT r.id FROM execution.workflow_runs r"))
      return { rows: [{ id: "run-one" }], rowCount: 1 };
    if (
      compactSql.includes(
        "SELECT generation FROM execution.workflow_run_authority",
      )
    )
      return { rows: [{ generation: "1" }], rowCount: 1 };
    if (compactSql.includes("to_jsonb(a) AS assignment")) {
      return {
        rows: [
          {
            ...workflowTaskRow(),
            database_now: new Date().toISOString(),
            executor_scope_authorized: true,
            current_authority_generation: "1",
            authority_lease_valid: true,
            run_status: "running",
            step_status: "running",
            resolved_steps_json: [],
            attempt_count: 1,
            lease_expires_at: new Date(Date.now() + 60000).toISOString(),
            resource_execution: {},
            assignment: {
              id: "assignment-one",
              authority_generation: "1",
              lease_expires_at: new Date(Date.now() + 60000).toISOString(),
            },
          },
        ],
        rowCount: 1,
      };
    }
    return (
      this.options.query?.(compactSql, values) ?? { rows: [], rowCount: 0 }
    );
  }

  release() {
    this.released = true;
  }
}

function compact(sql: string) {
  return sql.trim().replace(/\s+/g, " ");
}

type MockPgPoolOptions = {
  clients?: MockPgClientOptions[];
  directQuery?: (
    sql: string,
    values: unknown[] | undefined,
  ) => { rows: Array<Record<string, unknown>>; rowCount: number };
};

type MockPgClientOptions = {
  query?: (
    sql: string,
    values: unknown[] | undefined,
  ) => { rows: Array<Record<string, unknown>>; rowCount: number };
};

test("a Registry action launches from the signed URL Studio grants at dispatch, not the run's URL", async () => {
  const plainUrl =
    "https://api.b1m.ai/registry/v1/packages/%40acme/tool/versions/1.0.0/artifact";
  const signedUrl = `https://api.b1m.ai/registry/v1/artifacts/sha256/${"e".repeat(64)}?exp=1&sig=s`;
  let launches = 0;
  const launch = async (sourceRegistry: string, grant: string | null) => {
    // Each launch owns its own process record, as distinct tasks do.
    const taskId = `task-signed-${++launches}`;
    const requests: Array<{ phase: string; artifactUrl?: boolean }> = [];
    const resolvedUrls: Array<string | null | undefined> = [];
    const pool = new MockPgPool({
      clients: [
        {
          query(sql) {
            if (
              sql.includes(
                "UPDATE execution.workflow_tasks SET status = 'running'",
              )
            )
              return {
                rows: [
                  workflowTaskRow({
                    id: taskId,
                    action_package_name: "@acme/tool",
                    workflow_step_id: "step-one",
                  }),
                ],
                rowCount: 1,
              };
            return { rows: [], rowCount: 1 };
          },
        },
        {
          query(sql) {
            if (sql.includes("UPDATE execution.workflow_tasks SET status=$2"))
              return { rows: [{ id: taskId }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
          },
        },
      ],
      directQuery(sql) {
        if (sql.includes("FROM execution.workflow_step_runs"))
          return { rows: [{ id: "wsr-one", state_json: "{}" }], rowCount: 1 };
        if (sql.includes("FROM execution.workflow_runs"))
          return {
            rows: [
              {
                id: "run-one",
                status: "running",
                resolved_steps_json: JSON.stringify([
                  {
                    id: "step-one",
                    actionPackage: "@acme/tool",
                    resolvedVersion: "1.0.0",
                    sourceRegistry,
                    artifactChecksum: `sha256:${"e".repeat(64)}`,
                    registryArtifactUrl: plainUrl,
                    config: {},
                  },
                ]),
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 1 };
      },
    });
    const worker = createWorker(pool as unknown as PgPool, {
      authorizeExecution: async (_pool, input) => {
        requests.push({ phase: input.phase, artifactUrl: input.artifactUrl });
        return input.phase === "dispatch" ? { artifactUrl: grant } : undefined;
      },
      workerId: "worker-one",
      concurrency: 1,
      lockTtlMs: 60_000,
      maxAttempts: 3,
      logger: noopLogger(),
      async downloadObject() {
        return {};
      },
      async uploadObject() {
        return {};
      },
      async deleteObject() {
        return {};
      },
      resolveActionPackage: async (step) => {
        resolvedUrls.push(
          (step as { registryArtifactUrl?: string | null }).registryArtifactUrl,
        );
        return {
          source: "remote",
          checksum: "sha256:test",
          manifest: {
            name: "@acme/tool",
            version: "1.0.0",
            apiVersion: "workflow-actions/v1",
            runtime: { placements: ["local-workers"] },
            inputs: {},
            outputs: {},
            permissions: [],
          },
          async execute() {
            return { outputs: {} };
          },
        } as RegisteredActionPackage;
      },
    });
    // Only the launch inputs matter here; execution itself is covered above.
    await worker.processTaskId(taskId);
    return { requests, resolvedUrls };
  };

  const registry = await launch("public-registry", signedUrl);
  assert.deepEqual(registry.requests[0], {
    phase: "dispatch",
    artifactUrl: true,
  });
  assert.deepEqual(registry.resolvedUrls, [signedUrl]);

  // An older Registry grants no URL: the run's own URL is used unchanged.
  assert.deepEqual((await launch("public-registry", null)).resolvedUrls, [
    plainUrl,
  ]);
  // Non-Registry actions never ask Studio to sign.
  const local = await launch("local-registry", null);
  assert.deepEqual(local.requests[0], {
    phase: "dispatch",
    artifactUrl: false,
  });
});

function workflowTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: "org-one",
    id: "task-one",
    workflow_run_id: "run-one",
    workflow_step_run_id: "wsr-one",
    workflow_step_id: "step-download",
    action_package_name: "@beam/download",
    task_kind: "step",
    shard_index: null,
    shard_count: null,
    input_json: {},
    attempts: 1,
    max_attempts: 3,
    retry_policy_json: {},
    ...overrides,
  };
}

function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
