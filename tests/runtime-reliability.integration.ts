import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import pg from "pg";
import type {
  ActionManifest,
  RegisteredActionPackage,
} from "@beam-studio/core";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import {
  InMemoryMetricExporter,
  InMemoryTraceExporter,
  Telemetry,
} from "@beam-studio/telemetry";
import { startWorkflowRunPg } from "../apps/api/src/studio/workflow-runs.js";
import {
  ensureTaskWakeupsPg,
  orchestratePg,
  publishPendingTaskCommandsPg,
  recoverExpiredTaskLeasesPg,
} from "../apps/orchestrator/src/postgresOrchestration.js";
import {
  resilientTaskBroker,
  type TaskBrokerOptions,
} from "../apps/orchestrator/src/nats.js";
import {
  applyRemoteExecutionResult,
  createRemoteTaskPreparer,
} from "../apps/orchestrator/src/remoteExecution.js";
import type {
  RemoteExecutionConfig,
  OrchestratorOptions,
  TaskBroker,
} from "../apps/orchestrator/src/types.js";
import {
  connectNats,
  subscribeToTasks,
} from "../apps/worker/src/services/nats.js";
import { createPostgresTaskWorker } from "../apps/worker/src/services/postgresTaskWorker.js";
import type { TaskWorkerOptions } from "../apps/worker/src/services/taskTypes.js";

const { Client } = pg;
const maintenanceUrl =
  process.env.BEAM_TEST_POSTGRES_URL ?? "postgresql:///postgres";
const databaseName = `beam_runtime_reliability_${crypto.randomBytes(6).toString("hex")}`;
const databaseUrl = databaseUrlForName(maintenanceUrl, databaseName);
const subjectRoot = `beam.rr.${crypto.randomBytes(4).toString("hex")}`;
const streamName = `BEAM_RR_${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
const deadLetterSubject = `${subjectRoot}.dead-letter`;
const logger = noopLogger();

let pool: PgPool;

test.before(async () => {
  await createDatabase();
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  pool = createPostgresPool(databaseUrl);
  await ensurePostgresMigrations(pool);
  await seedRegistryWaitWorkflow(pool);
});

test.after(async () => {
  await pool?.end();
  await dropDatabase();
});

test("API commit survives NATS outage, publisher crash, restart, and duplicate completed delivery", async () => {
  const traces = new InMemoryTraceExporter();
  const apiTelemetry = new Telemetry("api", { traceExporter: traces });
  const orchestratorTelemetry = new Telemetry("orchestrator", {
    traceExporter: traces,
  });
  const workerTelemetry = new Telemetry("worker", { traceExporter: traces });
  const apiSpan = apiTelemetry.startSpan("api.workflow.run", {
    correlationId: "pending-wait-run",
  });
  const port = await unusedPort();
  const natsUrl = `nats://127.0.0.1:${port}`;
  const brokerOptions: TaskBrokerOptions = {
    subjectRoot,
    streamName,
    deadLetterSubject,
    logger,
    telemetry: orchestratorTelemetry,
  };
  const broker = resilientTaskBroker(natsUrl, brokerOptions);
  const options = orchestratorOptions(broker, orchestratorTelemetry);
  const runId = await startWorkflowRunPg(
    pool,
    "wf_wait",
    { scenario: "nats-outage" },
    { traceContext: apiSpan.context },
  );
  apiSpan.context.correlationId = runId;
  apiSpan.end();

  await orchestratePg(pool, options);

  const queued = await taskForRun(runId);
  assert.equal(queued.status, "queued");
  const failedPublication = await outboxForTask(String(queued.id), 1);
  assert.equal(failedPublication.state, "pending");
  assert.equal(Number(failedPublication.publish_attempts), 1);
  assert.ok(failedPublication.last_error);

  await pool.query(
    `
    UPDATE execution.command_outbox
    SET state = 'publishing', claimed_by = 'crashed-publisher',
        claim_expires_at = now() - interval '1 second'
    WHERE id = $1
    `,
    [failedPublication.id],
  );

  const nats = await startNatsServer(port);
  const connection = await connectNats(natsUrl, logger);
  const worker = createPostgresTaskWorker(
    pool,
    workerOptions("worker-nats", { telemetry: workerTelemetry }),
  );
  const subscription = await subscribeToTasks(
    connection,
    {
      subjectRoot,
      streamName,
      queueGroup: `rr-workers-${databaseName}`,
      workerId: "worker-nats",
      concurrency: 2,
      ackWaitMs: 1_000,
      maxDeliver: 5,
      redeliveryDelayMs: 50,
      deadLetterSubject,
      logger,
      telemetry: workerTelemetry,
    },
    (message) => worker.processTaskId(message.taskId, message),
  );

  try {
    await publishPendingTaskCommandsPg(pool, options);
    await waitForTaskStatus(String(queued.id), "completed");
    await orchestratePg(pool, options);
    assert.equal(await runStatus(runId), "completed");

    const publication = await outboxForTask(String(queued.id), 1);
    assert.equal(publication.state, "published");
    assert.equal(Number(publication.publish_attempts), 2);

    await broker.publishTask({
      taskId: String(queued.id),
      messageId: `${queued.id}:duplicate-completion`,
      taskKind: "step",
      actionPackageName: "@beam/e2e-wait",
      subject: String(queued.nats_subject),
    });
    await delay(150);
    assert.equal(Number((await task(String(queued.id))).attempts), 1);
    assert.equal(await eventCount(String(queued.id), "TaskCompleted"), 1);
    const durableCorrelation = await pool.query(
      "SELECT DISTINCT correlation_id FROM execution.workflow_events WHERE workflow_run_id = $1",
      [runId],
    );
    assert.deepEqual(
      durableCorrelation.rows.map((row) => row.correlation_id),
      [runId],
    );
    assert.equal(publication.payload_json.correlationId, runId);
    assert.match(
      publication.payload_json.traceparent,
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
    await delay(25);
    const correlated = traces.spans.filter(
      (span) => span.context.correlationId === runId,
    );
    assert.ok(correlated.some((span) => span.service === "api"));
    assert.ok(correlated.some((span) => span.service === "orchestrator"));
    assert.ok(correlated.some((span) => span.service === "worker"));
    assert.equal(
      new Set(correlated.map((span) => span.context.traceId)).size,
      1,
    );
  } finally {
    await subscription.close();
    await connection.close();
    await broker.close();
    await nats.stop();
  }
});

test("two workers race one Registry wait task and only one durable claim commits", async () => {
  const fixture = await insertTaskFixture({ durationMs: 75 });
  const workerOne = createPostgresTaskWorker(
    pool,
    workerOptions("worker-race-a"),
  );
  const workerTwo = createPostgresTaskWorker(
    pool,
    workerOptions("worker-race-b"),
  );

  const results = await Promise.all([
    workerOne.processTaskId(fixture.taskId),
    workerTwo.processTaskId(fixture.taskId),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), [
    "completed",
    "ignored",
  ]);
  const row = await task(fixture.taskId);
  assert.equal(row.status, "completed");
  assert.equal(Number(row.attempts), 1);
  assert.equal(await attemptCount(fixture.taskId), 1);

  assert.deepEqual(await workerTwo.processTaskId(fixture.taskId), {
    status: "ignored",
  });
  assert.equal(Number((await task(fixture.taskId)).attempts), 1);
  assert.equal(await eventCount(fixture.taskId, "TaskCompleted"), 1);
});

test("Orchestrator mode publishes a locked snapshot and commits its result idempotently", async () => {
  const fixture = await insertTaskFixture();
  const orchestratorConfig: RemoteExecutionConfig = {
    enabled: true,
    taskSubject: `${subjectRoot}.orchestrator`,
    resultSubject: `${subjectRoot}.orchestrator.results`,
    ownerId: "orchestrator-integration",
    leaseMs: 60_000,
    sandboxRuntime: "node-legacy",
    artifactUrlBase: "https://registry.test/artifacts",
  };
  const prepare = createRemoteTaskPreparer(pool, orchestratorConfig, logger);
  const publication = await prepare({
    taskId: fixture.taskId,
    messageId: `${fixture.taskId}:1`,
    taskKind: "step",
    actionPackageName: "@beam/e2e-wait",
  });
  assert.ok(publication);
  assert.equal(publication.subject, orchestratorConfig.taskSubject);
  const envelope = publication.payload as {
    type: string;
    task: Record<string, unknown>;
  };
  assert.equal(envelope.type, "workflow_task");
  assert.equal(envelope.task.task_id, fixture.taskId);
  assert.equal(envelope.task.attempt_id, `${fixture.taskId}:1`);
  assert.equal(envelope.task.action_package_name, "@beam/e2e-wait");
  assert.equal(
    envelope.task.sandbox &&
      (envelope.task.sandbox as Record<string, unknown>).runtime,
    "node-legacy",
  );
  assert.equal((await task(fixture.taskId)).status, "running");
  assert.equal(Number((await task(fixture.taskId)).attempts), 1);
  assert.deepEqual(envelope.task.input, {
    config: { durationMs: 25 },
    inputs: {},
  });

  const result = {
    type: "workflow_task_result" as const,
    event_id: `${fixture.taskId}:1`,
    task_id: fixture.taskId,
    attempt_id: `${fixture.taskId}:1`,
    worker_id: "worker-studio-1",
    status: "completed" as const,
    outputs: {
      result: JSON.stringify({ outputs: { waitedMs: 25 } }),
      artifacts: "[]",
    },
  };
  assert.equal(await applyRemoteExecutionResult(pool, result), "completed");
  assert.equal(
    await applyRemoteExecutionResult(pool, result),
    "already_terminal",
  );
  assert.equal((await task(fixture.taskId)).status, "completed");
  const step = await pool.query(
    "SELECT status, output_json FROM execution.workflow_step_runs WHERE id = $1",
    [fixture.stepRunId],
  );
  assert.equal(step.rows[0]?.status, "completed");
  assert.deepEqual(step.rows[0]?.output_json, { waitedMs: 25 });
  assert.equal(await eventCount(fixture.taskId, "TaskCompleted"), 1);
  assert.equal(await eventCount(fixture.taskId, "StepCompleted"), 1);
});

test("Orchestrator preparation rolls back its claim when a strong sandbox artifact is unavailable", async () => {
  const fixture = await insertTaskFixture();
  const prepare = createRemoteTaskPreparer(
    pool,
    {
      enabled: true,
      taskSubject: `${subjectRoot}.orchestrator`,
      resultSubject: `${subjectRoot}.orchestrator.results`,
      ownerId: "orchestrator-integration",
      leaseMs: 60_000,
      sandboxRuntime: "wasi",
    },
    logger,
  );
  await assert.rejects(
    prepare({ taskId: fixture.taskId, taskKind: "step" }),
    /requires a downloadable artifact for wasi/,
  );
  assert.equal((await task(fixture.taskId)).status, "queued");
  assert.equal(Number((await task(fixture.taskId)).attempts), 0);
  assert.equal(await attemptCount(fixture.taskId), 0);
  await pool.query(
    "UPDATE execution.workflow_tasks SET status = 'cancelled' WHERE id = $1",
    [fixture.taskId],
  );
});

test("PostgreSQL polling recreates a missed NATS wake-up", async () => {
  const fixture = await insertTaskFixture();
  await ensureTaskWakeupsPg(pool, orchestratorOptions(noopBroker()));
  await pool.query(
    `
    UPDATE execution.command_outbox
    SET state = 'published', published_at = now() - interval '10 seconds'
    WHERE aggregate_id = $1
    `,
    [`${fixture.taskId}:1`],
  );
  await ensureTaskWakeupsPg(pool, orchestratorOptions(noopBroker()));
  assert.equal((await outboxForTask(fixture.taskId, 1)).state, "pending");

  const published: string[] = [];
  await publishPendingTaskCommandsPg(
    pool,
    orchestratorOptions({
      async publishTask(request) {
        published.push(typeof request === "string" ? request : request.taskId);
      },
    }),
  );
  assert.deepEqual(published, [fixture.taskId]);
  assert.equal((await outboxForTask(fixture.taskId, 1)).state, "published");
});

test("expired leases recover, healthy leases stay owned, and counters advance per claim", async () => {
  const expired = await insertTaskFixture({
    durationMs: 20,
    taskStatus: "running",
    attempts: 1,
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    workerId: "worker-disappeared",
  });
  const healthy = await insertTaskFixture({
    durationMs: 20,
    taskStatus: "running",
    attempts: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    workerId: "worker-healthy",
  });

  await recoverExpiredTaskLeasesPg(pool, orchestratorOptions(noopBroker()));

  assert.equal((await task(expired.taskId)).status, "retry_scheduled");
  assert.equal(Number((await task(expired.taskId)).attempts), 1);
  assert.equal((await task(healthy.taskId)).status, "running");
  assert.equal(
    String((await task(healthy.taskId)).leased_by),
    "worker-healthy",
  );

  const rescuer = createPostgresTaskWorker(
    pool,
    workerOptions("worker-rescuer"),
  );
  assert.equal(
    (await rescuer.processTaskId(expired.taskId)).status,
    "completed",
  );
  assert.equal(Number((await task(expired.taskId)).attempts), 2);
  assert.equal(await attemptCount(expired.taskId), 2);

  const heartbeat = await insertTaskFixture({ durationMs: 350 });
  const liveWorker = createPostgresTaskWorker(
    pool,
    workerOptions("worker-heartbeat", { lockTtlMs: 120 }),
  );
  const liveExecution = liveWorker.processTaskId(heartbeat.taskId);
  await waitForTaskStatus(heartbeat.taskId, "running");
  await delay(220);
  await recoverExpiredTaskLeasesPg(pool, orchestratorOptions(noopBroker()));
  assert.equal((await task(heartbeat.taskId)).status, "running");
  assert.equal(Number((await task(heartbeat.taskId)).attempts), 1);
  assert.equal((await liveExecution).status, "completed");
});

test("PostgreSQL loss after claim is recovered from the durable lease", async () => {
  const fixture = await insertTaskFixture({ durationMs: 300 });
  const outage = transientOutagePool(pool);
  const worker = createPostgresTaskWorker(
    outage.pool,
    workerOptions("worker-postgres-outage", { lockTtlMs: 120 }),
  );
  const execution = worker.processTaskId(fixture.taskId);
  await waitForTaskStatus(fixture.taskId, "running");
  outage.setUnavailable(true);

  await assert.rejects(
    execution,
    /PostgreSQL unavailable for failure injection/,
  );
  outage.setUnavailable(false);
  await delay(150);
  await recoverExpiredTaskLeasesPg(pool, orchestratorOptions(noopBroker()));

  assert.equal((await task(fixture.taskId)).status, "retry_scheduled");
  assert.equal(Number((await task(fixture.taskId)).attempts), 1);
  const rescuer = createPostgresTaskWorker(
    pool,
    workerOptions("worker-after-postgres-outage"),
  );
  assert.equal(
    (await rescuer.processTaskId(fixture.taskId)).status,
    "completed",
  );
  assert.equal(Number((await task(fixture.taskId)).attempts), 2);
  assert.equal(await eventCount(fixture.taskId, "TaskCompleted"), 1);
});

test("max attempts create one durable dead-letter outcome", async () => {
  const fixture = await insertTaskFixture({
    taskStatus: "running",
    attempts: 2,
    maxAttempts: 2,
    leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    workerId: "worker-gone-final",
  });
  const options = orchestratorOptions(noopBroker());

  await recoverExpiredTaskLeasesPg(pool, options);
  await recoverExpiredTaskLeasesPg(pool, options);

  assert.equal((await task(fixture.taskId)).status, "dead_letter");
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM execution.workflow_task_dead_letters WHERE workflow_task_id = $1",
    [fixture.taskId],
  );
  assert.equal(Number(result.rows[0]?.count), 1);
  assert.equal(await runStatus(fixture.runId), "failed");
});

test("worker failures schedule one retry per claim and dead-letter exactly once", async () => {
  const metricExporter = new InMemoryMetricExporter();
  const telemetry = new Telemetry("worker", { metricExporter });
  const fixture = await insertTaskFixture({ maxAttempts: 2 });
  const worker = createPostgresTaskWorker(
    pool,
    workerOptions("worker-failing", {
      resolveActionPackage: async () => failingRegistryWaitAction(),
      telemetry,
    }),
  );

  const first = await worker.processTaskId(fixture.taskId);
  assert.equal(first.status, "retry");
  assert.equal((await task(fixture.taskId)).status, "retry_scheduled");
  assert.equal(Number((await task(fixture.taskId)).attempts), 1);
  assert.equal(await eventCount(fixture.taskId, "TaskRetryScheduled"), 1);

  await delay(25);
  await ensureTaskWakeupsPg(pool, orchestratorOptions(noopBroker()));
  const retryWakeup = await outboxForTask(fixture.taskId, 2);
  assert.equal(retryWakeup.state, "pending");
  assert.equal(retryWakeup.payload_json.messageId, `${fixture.taskId}:2`);

  const sibling = await insertRunningSiblingTask(fixture.runId);

  const second = await worker.processTaskId(fixture.taskId);
  assert.equal(second.status, "dead_letter");
  assert.equal((await task(fixture.taskId)).status, "dead_letter");
  assert.equal(Number((await task(fixture.taskId)).attempts), 2);
  assert.equal(await attemptCount(fixture.taskId), 2);
  assert.equal(await eventCount(fixture.taskId, "TaskDeadLettered"), 1);
  const points = telemetry.metrics.snapshot();
  assert.equal(
    points.find((point) => point.name === "beam_workflow_task_retries_total")
      ?.value,
    1,
  );
  assert.equal(
    points.find(
      (point) => point.name === "beam_workflow_task_dead_letters_total",
    )?.value,
    1,
  );
  assert.equal(await deadLetterCount(fixture.taskId), 1);
  assert.equal(await runStatus(fixture.runId), "failed");
  assert.equal((await task(sibling.taskId)).status, "cancelled");
  assert.equal(await stepRunStatus(sibling.stepRunId), "cancelled");
  assert.equal(await latestAttemptStatus(sibling.taskId), "cancelled");

  assert.equal((await worker.processTaskId(fixture.taskId)).status, "ignored");
  assert.equal(await deadLetterCount(fixture.taskId), 1);
  assert.equal(await eventCount(fixture.taskId, "TaskDeadLettered"), 1);
});

test("cancellation before claim and during Registry wait execution is deterministic", async () => {
  const beforeClaim = await insertTaskFixture({ taskStatus: "queued" });
  await pool.query(
    "UPDATE execution.workflow_runs SET status = 'cancel_requested' WHERE id = $1",
    [beforeClaim.runId],
  );
  const options = orchestratorOptions(noopBroker());
  await orchestratePg(pool, options);
  assert.equal((await task(beforeClaim.taskId)).status, "cancelled");
  assert.equal(await runStatus(beforeClaim.runId), "cancelled");
  assert.equal(
    (
      await createPostgresTaskWorker(
        pool,
        workerOptions("worker-too-late"),
      ).processTaskId(beforeClaim.taskId)
    ).status,
    "ignored",
  );

  const duringWait = await insertTaskFixture({ durationMs: 5_000 });
  const worker = createPostgresTaskWorker(
    pool,
    workerOptions("worker-cancelled", { lockTtlMs: 150 }),
  );
  const execution = worker.processTaskId(duringWait.taskId);
  await waitForTaskStatus(duringWait.taskId, "running");
  await pool.query(
    "UPDATE execution.workflow_runs SET status = 'cancel_requested' WHERE id = $1",
    [duringWait.runId],
  );
  await orchestratePg(pool, options);

  assert.equal((await execution).status, "terminal");
  assert.equal((await task(duringWait.taskId)).status, "cancelled");
  assert.equal(await runStatus(duringWait.runId), "cancelled");
  assert.equal(await eventCount(duringWait.taskId, "TaskCompleted"), 0);
});

async function seedRegistryWaitWorkflow(database: PgPool) {
  const manifest = waitManifest();
  await database.query(
    `
    INSERT INTO identity.organizations (id, slug, name)
    VALUES ('org_rr', 'runtime-reliability', 'Runtime Reliability')
    `,
  );
  await database.query(
    `
    INSERT INTO actions.scopes (id, name, status)
    VALUES ('scope_rr', '@beam', 'active')
    `,
  );
  await database.query(
    `
    INSERT INTO actions.packages (
      id, scope_id, name, package_name, display_name, visibility,
      status, trust_level, latest_version, metadata_json
    )
    VALUES ('pkg_wait', 'scope_rr', 'e2e-wait', '@beam/e2e-wait',
      'E2E Wait', 'unlisted', 'active', 'verified', '1.0.0',
      '{"source":"test-registry"}'::jsonb)
    `,
  );
  await database.query(
    `
    INSERT INTO actions.package_versions (
      id, package_id, version, manifest_json, manifest_checksum,
      artifact_checksum, media_type, provenance_json, validation_status, status
    )
    VALUES ('pkg_wait_v1', 'pkg_wait', '1.0.0', $1::jsonb, 'wait-manifest',
      'sha256:wait-artifact', 'application/javascript',
      '{"source":"test-registry"}'::jsonb, 'verified', 'active')
    `,
    [JSON.stringify(manifest)],
  );
  await database.query(
    `
    INSERT INTO actions.dist_tags (id, package_id, tag, version_id)
    VALUES ('pkg_wait_latest', 'pkg_wait', 'latest', 'pkg_wait_v1')
    `,
  );
  await database.query(
    `
    INSERT INTO workflow.templates (id, organization_id, name, status, enabled)
    VALUES ('wf_wait', 'org_rr', 'Registry wait reliability', 'active', true)
    `,
  );
  await database.query(
    `
    INSERT INTO workflow.steps (
      id, workflow_template_id, action_package_name, action_version_range,
      position, config_json, input_bindings_json, required
    )
    VALUES
      ('step_wait', 'wf_wait', '@beam/e2e-wait', 'latest', 0,
        '{"durationMs":25}'::jsonb, '{}'::jsonb, true),
      ('step_wait_sibling', 'wf_wait', '@beam/e2e-wait', 'latest', 1,
        '{"durationMs":30000}'::jsonb, '{}'::jsonb, true)
    `,
  );
  await database.query(
    `
    INSERT INTO runtime.worker_runtime_state (
      worker_id, organization_id, network_identity, status, heartbeat_at
    )
    VALUES ('worker-available', 'org_rr', 'integration', 'active', now())
    `,
  );
}

async function insertTaskFixture(
  input: {
    durationMs?: number;
    taskStatus?: "queued" | "running";
    attempts?: number;
    maxAttempts?: number;
    leaseExpiresAt?: string;
    workerId?: string;
  } = {},
) {
  const suffix = crypto.randomBytes(6).toString("hex");
  const runId = `run_${suffix}`;
  const stepRunId = `step_run_${suffix}`;
  const taskId = `task_${suffix}`;
  const durationMs = input.durationMs ?? 25;
  const taskStatus = input.taskStatus ?? "queued";
  const attempts = input.attempts ?? 0;
  const maxAttempts = input.maxAttempts ?? 3;
  const snapshot = [
    {
      id: "step_wait",
      actionPackage: "@beam/e2e-wait",
      versionRange: "latest",
      resolvedVersion: "1.0.0",
      checksum: "wait-manifest",
      manifestChecksum: "wait-manifest",
      artifactChecksum: "sha256:wait-artifact",
      mediaType: "application/javascript",
      sourceRegistry: "test-registry",
      manifestSnapshot: waitManifest(),
      resolvedPlacement: "local-workers",
      config: { durationMs },
      inputBindings: {},
      required: true,
      enabled: true,
      position: 0,
    },
  ];
  await pool.query(
    `
    INSERT INTO execution.workflow_runs (
      id, organization_id, workflow_template_id, status, trigger,
      trigger_event_json, template_snapshot_json, resolved_steps_json,
      input_json, output_json, metadata_json, queued_at
    )
    VALUES ($1, 'org_rr', 'wf_wait', 'running', 'api', '{}'::jsonb,
      '{}'::jsonb, $2::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now())
    `,
    [runId, JSON.stringify(snapshot)],
  );
  await pool.query(
    `
    INSERT INTO execution.workflow_step_runs (
      id, workflow_run_id, workflow_step_id, action_package_name,
      resolved_version, checksum, source_registry, resolved_placement,
      status, attempt, input_json, output_json, metadata_json, state_json
    )
    VALUES ($1, $2, 'step_wait', '@beam/e2e-wait', '1.0.0', 'wait-manifest',
      'test-registry', 'local-workers', $3, 1, '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, '{}'::jsonb)
    `,
    [stepRunId, runId, taskStatus === "running" ? "running" : "queued"],
  );
  const claimToken = taskStatus === "running" ? `claim_${suffix}` : null;
  await pool.query(
    `
    INSERT INTO execution.workflow_tasks (
      id, organization_id, workflow_run_id, workflow_step_run_id,
      workflow_step_id, action_package_name, task_kind, status,
      scheduled_at, attempt_count, attempts, max_attempts, input_checksum,
      input_json, output_json, metadata_json, retry_policy_json,
      placement_explanation_json, nats_subject, leased_by, locked_by,
      lease_expires_at, lock_expires_at, claim_token
    )
    VALUES ($1, 'org_rr', $2, $3, 'step_wait', '@beam/e2e-wait', 'step', $4,
      now(), $5, $5, $6, $7, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $8::jsonb, '{}'::jsonb, $9, $10, $10, $11, $11, $12)
    `,
    [
      taskId,
      runId,
      stepRunId,
      taskStatus,
      attempts,
      maxAttempts,
      `checksum_${suffix}`,
      JSON.stringify({ maxAttempts, baseDelayMs: 10, maxDelayMs: 20 }),
      `${subjectRoot}.general`,
      input.workerId ?? null,
      input.leaseExpiresAt ?? null,
      claimToken,
    ],
  );
  if (taskStatus === "running") {
    await pool.query(
      `
      INSERT INTO execution.workflow_task_attempts (
        id, workflow_task_id, attempt_number, worker_id, status, started_at,
        metadata_json, created_at
      )
      VALUES ($1, $2, $3, $4, 'running', now(), $5::jsonb, now())
      `,
      [
        `attempt_${suffix}`,
        taskId,
        attempts,
        input.workerId ?? null,
        JSON.stringify({ claimToken }),
      ],
    );
  }
  return { runId, stepRunId, taskId };
}

async function insertRunningSiblingTask(runId: string) {
  const suffix = crypto.randomBytes(6).toString("hex");
  const stepRunId = `step_run_sibling_${suffix}`;
  const taskId = `task_sibling_${suffix}`;
  const claimToken = `claim_sibling_${suffix}`;
  await pool.query(
    `
    INSERT INTO execution.workflow_step_runs (
      id, workflow_run_id, workflow_step_id, action_package_name,
      resolved_version, checksum, source_registry, resolved_placement,
      status, attempt, input_json, output_json, metadata_json, state_json
    )
    VALUES ($1, $2, 'step_wait_sibling', '@beam/e2e-wait', '1.0.0',
      'wait-manifest', 'test-registry', 'local-workers', 'running', 1,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
    `,
    [stepRunId, runId],
  );
  await pool.query(
    `
    INSERT INTO execution.workflow_tasks (
      id, organization_id, workflow_run_id, workflow_step_run_id,
      workflow_step_id, action_package_name, task_kind, status,
      scheduled_at, attempt_count, attempts, max_attempts, input_checksum,
      input_json, output_json, metadata_json, retry_policy_json,
      placement_explanation_json, nats_subject, leased_by, locked_by,
      lease_expires_at, lock_expires_at, claim_token
    )
    VALUES ($1, 'org_rr', $2, $3, 'step_wait_sibling', '@beam/e2e-wait',
      'step', 'running', now(), 1, 1, 3, $4, '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, '{"maxAttempts":3}'::jsonb, '{}'::jsonb, $5,
      'worker-sibling', 'worker-sibling', now() + interval '1 minute',
      now() + interval '1 minute', $6)
    `,
    [
      taskId,
      runId,
      stepRunId,
      `checksum_sibling_${suffix}`,
      `${subjectRoot}.general`,
      claimToken,
    ],
  );
  await pool.query(
    `
    INSERT INTO execution.workflow_task_attempts (
      id, workflow_task_id, attempt_number, worker_id, status, started_at,
      metadata_json, created_at
    )
    VALUES ($1, $2, 1, 'worker-sibling', 'running', now(), $3::jsonb, now())
    `,
    [`attempt_sibling_${suffix}`, taskId, JSON.stringify({ claimToken })],
  );
  return { stepRunId, taskId };
}

function workerOptions(
  workerId: string,
  overrides: Partial<TaskWorkerOptions> = {},
): TaskWorkerOptions {
  return {
    workerId,
    concurrency: 2,
    lockTtlMs: 600,
    maxAttempts: 3,
    logger,
    resolveActionPackage: async () => registryWaitAction(),
    async downloadObject() {
      throw new Error(
        "The reliability suite only permits the Registry wait action.",
      );
    },
    async uploadObject() {
      throw new Error(
        "The reliability suite only permits the Registry wait action.",
      );
    },
    async deleteObject() {
      throw new Error(
        "The reliability suite only permits the Registry wait action.",
      );
    },
    ...overrides,
  };
}

function registryWaitAction(): RegisteredActionPackage {
  return {
    source: "remote",
    manifest: waitManifest(),
    checksum: "wait-manifest",
    async execute({ config }, context) {
      const durationMs = Number(config.durationMs ?? 25);
      await abortableDelay(durationMs, context.signal);
      return { outputs: { waitedMs: durationMs } };
    },
  };
}

function failingRegistryWaitAction(): RegisteredActionPackage {
  return {
    ...registryWaitAction(),
    async execute(_input, context) {
      await abortableDelay(5, context.signal);
      throw new Error("intentional Registry wait failure");
    },
  };
}

function waitManifest(): ActionManifest {
  return {
    name: "@beam/e2e-wait",
    version: "1.0.0",
    displayName: "E2E Wait",
    description: "Waits without contacting an external service.",
    apiVersion: "workflow-actions/v1",
    runtime: {
      placements: ["local-workers"],
      defaultPlacement: "local-workers",
    },
    execution: { taskMode: "single-worker" },
    configSchema: {
      type: "object",
      properties: { durationMs: { type: "number" } },
      required: ["durationMs"],
      additionalProperties: false,
    },
    inputs: {},
    outputs: { waitedMs: { type: "number" } },
    permissions: [],
    trustLevel: "verified",
  };
}

function orchestratorOptions(
  broker: TaskBroker,
  telemetry?: Telemetry,
): OrchestratorOptions {
  return {
    batchSize: 100,
    maxAttempts: 3,
    taskSubjectRoot: subjectRoot,
    logger,
    broker,
    telemetry,
  };
}

function noopBroker(): TaskBroker {
  return { async publishTask() {} };
}

function transientOutagePool(delegate: PgPool) {
  let unavailable = false;
  return {
    pool: {
      connect() {
        if (unavailable) {
          return Promise.reject(
            new Error("PostgreSQL unavailable for failure injection"),
          );
        }
        return delegate.connect();
      },
      query(...args: Parameters<PgPool["query"]>) {
        if (unavailable) {
          return Promise.reject(
            new Error("PostgreSQL unavailable for failure injection"),
          );
        }
        return delegate.query(...args);
      },
    } as PgPool,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
  };
}

async function taskForRun(runId: string) {
  const result = await pool.query(
    "SELECT * FROM execution.workflow_tasks WHERE workflow_run_id = $1 ORDER BY created_at LIMIT 1",
    [runId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

async function task(taskId: string) {
  const result = await pool.query(
    "SELECT * FROM execution.workflow_tasks WHERE id = $1",
    [taskId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

async function stepRunStatus(stepRunId: string) {
  const result = await pool.query(
    "SELECT status FROM execution.workflow_step_runs WHERE id = $1",
    [stepRunId],
  );
  assert.ok(result.rows[0]);
  return String(result.rows[0].status);
}

async function latestAttemptStatus(taskId: string) {
  const result = await pool.query(
    "SELECT status FROM execution.workflow_task_attempts WHERE workflow_task_id = $1 ORDER BY attempt_number DESC LIMIT 1",
    [taskId],
  );
  assert.ok(result.rows[0]);
  return String(result.rows[0].status);
}

async function outboxForTask(taskId: string, attempt: number) {
  const result = await pool.query(
    `
    SELECT * FROM execution.command_outbox
    WHERE command_type = 'workflow_task.wakeup' AND aggregate_id = $1
    `,
    [`${taskId}:${attempt}`],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

async function runStatus(runId: string) {
  const result = await pool.query(
    "SELECT status FROM execution.workflow_runs WHERE id = $1",
    [runId],
  );
  return String(result.rows[0]?.status);
}

async function attemptCount(taskId: string) {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM execution.workflow_task_attempts WHERE workflow_task_id = $1",
    [taskId],
  );
  return Number(result.rows[0]?.count);
}

async function eventCount(taskId: string, eventType: string) {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM execution.workflow_events
    WHERE workflow_task_id = $1 AND event_type = $2
    `,
    [taskId, eventType],
  );
  return Number(result.rows[0]?.count);
}

async function deadLetterCount(taskId: string) {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS count FROM execution.workflow_task_dead_letters WHERE workflow_task_id = $1",
    [taskId],
  );
  return Number(result.rows[0]?.count);
}

async function waitForTaskStatus(taskId: string, expected: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await task(taskId)).status === expected) {
      return;
    }
    await delay(20);
  }
  assert.equal((await task(taskId)).status, expected);
}

async function createDatabase() {
  const client = new Client({ connectionString: maintenanceUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase() {
  const client = new Client({ connectionString: maintenanceUrl });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
    );
  } finally {
    await client.end();
  }
}

function databaseUrlForName(url: string, name: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function quoteIdentifier(value: string) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function startNatsServer(port: number) {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), "beam-rr-nats-"));
  const output: Buffer[] = [];
  const child = spawn(
    "nats-server",
    ["-js", "-p", String(port), "-sd", storageDir],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => output.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => output.push(Buffer.from(chunk)));
  await waitForPort(port, child, output);
  return {
    async stop() {
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

async function waitForPort(
  port: number,
  child: ChildProcess,
  output: Buffer[],
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `nats-server exited early:\n${Buffer.concat(output).toString()}`,
      );
    }
    if (await canConnect(port)) {
      return;
    }
    await delay(25);
  }
  throw new Error(
    `nats-server did not listen:\n${Buffer.concat(output).toString()}`,
  );
}

function canConnect(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
