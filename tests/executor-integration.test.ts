import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  executorErrorAfterResourceCleanup,
  type PgPool,
} from "../packages/db/src/index.js";
import {
  ActionExecutionError,
  type RegisteredActionPackage,
} from "../packages/core/src/index.js";
import { createPostgresTaskWorker } from "../apps/worker/src/services/postgresTaskWorker.js";
import { reconcileWorkerProcesses } from "../apps/worker/src/services/processRecovery.js";
import {
  prepareProcessOwnership,
  getProcessOwnershipScope,
} from "../packages/action-runtime/src/process-ownership.js";
import type { TaskWorkerOptions } from "../apps/worker/src/services/taskTypes.js";
import {
  orchestratePg,
  publishPendingTaskCommandsPg,
} from "../apps/orchestrator/src/postgresOrchestration.js";
import {
  planActionTasks,
  nextReduceTasks,
} from "../apps/orchestrator/src/distributedExecution.js";

const manifest: RegisteredActionPackage["manifest"] = {
  apiVersion: "workflow-actions/v1",
  name: "@test/sum",
  version: "1.0.0",
  runtime: { placements: ["local-workers"] },
  inputs: {},
  outputs: {},
  execution: {
    taskMode: "distributed-workers",
    distribution: {
      mode: "partitioned-reduce",
      inputKey: "values",
      outputKey: "sum",
      preferredItemsPerTask: 2,
      maxParallelism: 16,
    },
  },
};
test("hierarchical reduction preserves source order and the declared concurrency limit", () => {
  const input = { values: Array.from({ length: 32 }, (_, i) => i) };
  const plan = planActionTasks(manifest, input);
  assert.equal(plan.mode, "hierarchical-reduce");
  assert.equal(plan.tasks.length, 16);
  const tasks = plan.tasks.map((task) => ({
    task_kind: task.kind,
    shard_index: task.index!,
    status: "completed",
    output_json: { sum: task.index! },
  }));
  const intermediate = nextReduceTasks(
    manifest,
    input,
    plan.mode,
    plan.groupSize,
    [...tasks].reverse(),
  );
  assert.deepEqual(intermediate[0]?.input.values, [0, 1, 2, 3]);
  assert.equal(
    nextReduceTasks(manifest, input, plan.mode, plan.groupSize, [
      { ...tasks[0]!, status: "running" },
      ...tasks.slice(1),
    ]).length,
    0,
  );
  const serial = planActionTasks(
    {
      ...manifest,
      execution: {
        ...manifest.execution,
        distribution: {
          ...manifest.execution!.distribution!,
          maxParallelism: 1,
        },
      },
    },
    input,
  );
  assert.equal(serial.tasks.length, 1);
});

test("verified resource cleanup supersedes only its provisional warning", () => {
  const warning = { code: "executor_cleanup_required", message: "Room publication cleanup remains unconfirmed." };
  for (const state of ["completed", "partial", "failed", "cancelled", "expired"])
    assert.equal(executorErrorAfterResourceCleanup(warning, { kind: "room-publication", state }), undefined);
  for (const resource of [undefined, null, { state: "cancelled" }, { kind: "other", state: "cancelled" }, { kind: "room-publication", state: "active" }, { kind: "room-publication", state: "unknown" }])
    assert.equal(executorErrorAfterResourceCleanup(warning, resource), warning);
  const failure = { code: "executor_lease_expired", message: "Real failure" };
  assert.equal(executorErrorAfterResourceCleanup(failure, { kind: "room-publication", state: "cancelled" }), failure);
});

test("hosted API startup uses the canonical schema without historical migration replay", async () => {
  const dockerfile = await readFile(new URL("../apps/api/Dockerfile", import.meta.url), "utf8");
  const command = dockerfile.split(/\r?\n/).find((line) => line.startsWith("CMD "))!;
  assert.match(command, /db:studio:init/);
  assert.doesNotMatch(command, /db:migrate|db:pg:migrate/);
});

const source = process.env.BEAM_TEST_POSTGRES_URL;
const database = `workflow_backends_${randomBytes(6).toString("hex")}`;
let pool: PgPool, maintenance: PgPool;
const disconnected: Promise<unknown>[] = [];
let heartbeat: ReturnType<typeof setInterval> | undefined;
before(async () => {
  if (!source) return;
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  maintenance = createPostgresPool(source);
  await maintenance.query(`CREATE DATABASE ${database}`);
  const url = new URL(source);
  url.pathname = `/${database}`;
  pool = createPostgresPool(url.toString());
  pool.on("connect", (client) => {
    disconnected.push(once(client, "end"));
  });
  await ensurePostgresMigrations(pool);
  await pool.query(
    "INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Test')",
  );
  await pool.query(
    "INSERT INTO identity.organizations(id,slug,name) VALUES('other','other','Other')",
  );
  await pool.query(
    "INSERT INTO runtime.worker_runtime_state(worker_id,network_identity,status,heartbeat_at) VALUES('runner','test','active',now())",
  );
  heartbeat = setInterval(() => {
    void pool
      .query(
        "UPDATE runtime.worker_runtime_state SET heartbeat_at=now() WHERE worker_id='runner'",
      )
      .catch(() => {});
  }, 5_000);
  heartbeat.unref();
  await pool.query(
    "INSERT INTO workflow.templates(id,organization_id,name) VALUES('workflow','org','Test')",
  );
  await pool.query(
    "INSERT INTO workflow.steps(id,workflow_template_id,action_package_name,position) VALUES('sum','workflow','@test/sum',0)",
  );
});
after(async () => {
  clearInterval(heartbeat);
  await pool?.end();
  // pg-pool removes idle clients before their sockets finish disconnecting.
  // Wait for those sockets instead of forcibly terminating still-closing
  // connections, which can emit an idle-client error after the tests pass.
  await Promise.all(disconnected);
  if (maintenance) {
    await maintenance.query(`DROP DATABASE ${database}`);
    await maintenance.end();
  }
});

test(
  "Studio target scope is enforced at claim and again before result settlement",
  { skip: !source },
  async () => {
    await fixture("runner-scope", {
      ...manifest,
      execution: { taskMode: "single-worker" },
    });
    await orchestratePg(pool, dispatcher);
    const taskId = (
      await pool.query(
        "SELECT id FROM execution.workflow_tasks WHERE workflow_run_id='runner-scope'",
      )
    ).rows[0].id;
    const worker = runner(async () => {
      await pool.query(
        "UPDATE runtime.worker_runtime_state SET organization_id='other' WHERE worker_id='runner'",
      );
      return { outputs: { sum: 42 } };
    });
    try {
      await pool.query(
        "UPDATE runtime.worker_runtime_state SET organization_id='other',heartbeat_at=now() WHERE worker_id='runner'",
      );
      await worker.processTaskId(taskId);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM execution.executor_assignments WHERE task_id=$1",
            [taskId],
          )
        ).rows[0].n,
        0,
      );
      await pool.query(
        "UPDATE runtime.worker_runtime_state SET organization_id='org' WHERE worker_id='runner'",
      );
      await worker.processTaskId(taskId);
      const task = (
        await pool.query(
          "SELECT status,output_json,error FROM execution.workflow_tasks WHERE id=$1",
          [taskId],
        )
      ).rows[0];
      assert.equal(task.status, "dead_letter");
      assert.deepEqual(task.output_json, {});
      assert.match(task.error, /permitted organization\/project scope/);
    } finally {
      await pool.query(
        "UPDATE runtime.worker_runtime_state SET organization_id=NULL WHERE worker_id='runner'",
      );
    }
  },
);
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const dispatcher = {
  batchSize: 100,
  maxAttempts: 3,
  logger,
  authorizeExecution: async () => {},
  broker: { async publishTask() {} },
};
test("failed room adapters re-enter independent cancellation cleanup even without active multipart sessions", { skip: !source }, async () => {
  const { RoomStorageTransferManager } = await import("../apps/api/src/agent-control/room-storage-transfer-manager.js");
  const manager = new RoomStorageTransferManager(pool, {} as any, {} as any, logger as any);
  manager.stop(); // Exercise the real SQL transition without dispatching provider work.
  for (const status of ["failed", "completed", "partial", "cancelled"]) {
    const id = `terminal-room-${status}`;
    await pool.query(`INSERT INTO studio.room_storage_transfer_jobs
      (id,organization_id,environment_template_key,room_id,channel_id,publication_id,origin_kind,origin_key,request_hash,workflow_step_run_id,api_key_id,source_member_id,source_locator_json,ttl_seconds,status)
      VALUES($1,'org','prod','room','channel',$1,'workflow',$1,'hash',$1,'key','member','{}',300,$2)`, [id,status]);
    await manager.requestCancel(id);
    const observed = await manager.workflowStatus(id);
    assert.equal(observed?.status, status === "failed" ? "cancel_requested" : status);
  }
});

test("canonical schema startup preserves active current room contracts and immutable run snapshots", { skip: !source }, async () => {
  const config = {environmentTemplateKey:"prod",roomId:"room",channelId:"channel",source:{memberId:"source",locator:{type:"agent_path",path:"/fixtures/source.bin"}},targetMemberIds:["destination"],ttlSeconds:300,allowPartial:false};
  await pool.query("INSERT INTO workflow.templates(id,organization_id,name) VALUES('startup-workflow','org','Startup preservation')");
  await pool.query("INSERT INTO workflow.steps(id,workflow_template_id,action_package_name,action_version_range,config_json,position) VALUES('startup-room','startup-workflow','@beam/room-transfer','2.1.0',$1::jsonb,0)",[JSON.stringify(config)]);
  const frozen = [{id:"startup-room",config,resolvedVersion:"2.1.0"}];
  await pool.query("INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status,resolved_steps_json,template_snapshot_json) VALUES('startup-active-room','org','startup-workflow','running',$1::jsonb,$2::jsonb)",[JSON.stringify(frozen),JSON.stringify({steps:frozen})]);
  await ensurePostgresMigrations(pool);
  const definition = (await pool.query("SELECT action_version_range,config_json FROM workflow.steps WHERE id='startup-room'")).rows[0];
  const run = (await pool.query("SELECT status,resolved_steps_json,template_snapshot_json FROM execution.workflow_runs WHERE id='startup-active-room'")).rows[0];
  assert.equal(definition.action_version_range,"2.1.0");
  assert.deepEqual(definition.config_json,config);
  assert.equal(run.status,"running");
  assert.deepEqual(run.resolved_steps_json,frozen);
  assert.deepEqual(run.template_snapshot_json,{steps:frozen});
  await pool.query("UPDATE execution.workflow_runs SET status='cancelled' WHERE id='startup-active-room'");
});

test("cancelled workflows reclaim failed adapter cleanup without reopening successful or unrelated jobs", { skip: !source }, async () => {
  const { claimRoomStorageTransferJobs } = await import("../apps/api/src/agent-control/room-storage-transfer-manager.js");
  // Leave previous transition fixtures leased so this check owns only its candidates.
  await pool.query("UPDATE studio.room_storage_transfer_jobs SET lease_expires_at=now()+interval '5 minutes' WHERE status='cancel_requested'");
  for (const [index, runStatus, jobStatus, leased] of [
    [0,"cancelled","failed",false], [1,"failed","failed",false], [2,"running","failed",false],
    [3,"cancelled","completed",false], [4,"cancelled","partial",false], [5,"cancelled","cancelled",false],
    [6,"cancelled","failed",true],
  ] as const) {
    const id = `adapter-recovery-${index}`;
    await pool.query("INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status) VALUES($1,'org','workflow',$2)",[id,runStatus]);
    await pool.query(`INSERT INTO studio.room_storage_transfer_jobs
      (id,organization_id,environment_template_key,room_id,channel_id,publication_id,origin_kind,origin_key,request_hash,workflow_run_id,api_key_id,source_member_id,source_locator_json,ttl_seconds,status,lease_expires_at)
      VALUES($1,'org','prod','room','channel',$1,'workflow',$1,'hash',$1,'key','member','{}',300,$2,CASE WHEN $3::boolean THEN now()+interval '5 minutes' ELSE NULL END)`,[id,jobStatus,leased]);
  }
  const claimed = await claimRoomStorageTransferJobs(pool,"cleanup-recovery-owner");
  assert.deepEqual(claimed.rows.map(row => row.id),["adapter-recovery-0"]);
  assert.equal(claimed.rows[0]?.status,"cancel_requested");
  assert.equal(claimed.rows[0]?.lease_owner,"cleanup-recovery-owner");
  assert.equal((await claimRoomStorageTransferJobs(pool,"another-owner")).rows.length,0);
});

async function fixture(id: string, frozenManifest = manifest) {
  const step = {
    id: "sum",
    kind: "action",
    enabled: true,
    required: true,
    actionPackage: manifest.name,
    versionRange: "1.0.0",
    resolvedVersion: "1.0.0",
    checksum: "frozen",
    sourceRegistry: "builtin",
    resolvedPlacement: "local-workers",
    executionTarget: { kind: "studio" },
    manifestSnapshot: frozenManifest,
    config: {},
    inputBindings: { values: "${workflow.input.values}" },
  };
  await pool.query(
    `INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status,resolved_steps_json,template_snapshot_json,input_json) VALUES($1,'org','workflow','running',$2::jsonb,$3::jsonb,$4::jsonb)`,
    [
      id,
      JSON.stringify([step]),
      JSON.stringify({
        steps: [step],
        contract: {
          inputSchema: { type: "object" },
          output: {
            schema: { type: "object" },
            bindings: { sum: "${steps.sum.outputs.sum}" },
          },
        },
      }),
      JSON.stringify({ values: Array.from({ length: 32 }, (_, i) => i + 1) }),
    ],
  );
}
function runner(
  execute: RegisteredActionPackage["execute"],
  overrides: Partial<TaskWorkerOptions> = {},
) {
  return createPostgresTaskWorker(pool, {
    workerId: "runner",
    concurrency: 16,
    lockTtlMs: 60_000,
    maxAttempts: 3,
    logger,
    authorizeExecution: async () => {},
    resolveActionPackage: async () => ({
      source: "builtin",
      checksum: "frozen",
      manifest,
      execute,
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
    ...overrides,
  });
}
test(
  "pending member wakeups use saved placement instead of missing or conflicting message metadata",
  { skip: !source },
  async (t) => {
    const originalApi = process.env.BEAM_STUDIO_API_URL;
    process.env.BEAM_STUDIO_API_URL = "http://studio.test";
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: URL) => {
      requests.push(url.pathname);
      return Response.json({}, { status: requests.length === 1 ? 503 : 200 });
    });
    let studioWakeups = 0;
    const memberDispatcher = {
      ...dispatcher,
      broker: {
        async publishTask() {
          studioWakeups++;
        },
      },
    };
    try {
      await fixture("member-dispatch", {
        ...manifest,
        runtime: { placements: ["room-members"] },
        execution: { taskMode: "single-worker" },
      });
      await pool.query(
        `UPDATE execution.workflow_runs SET resolved_steps_json=
          jsonb_set(jsonb_set(resolved_steps_json,'{0,resolvedPlacement}','"room-members"'),
          '{0,executionTarget}','{"kind":"room-member"}') WHERE id='member-dispatch'`,
      );
      await pool.query(
        "INSERT INTO execution.workflow_run_capabilities(workflow_run_id,authorization_token) VALUES('member-dispatch','test-capability')",
      );
      await orchestratePg(pool, memberDispatcher);
      const task = (
        await pool.query(
          "SELECT id FROM execution.workflow_tasks WHERE workflow_run_id='member-dispatch'",
        )
      ).rows[0];
      assert.deepEqual(requests, [
        `/internal/workflow-tasks/${task.id}/room-member/dispatch`,
      ]);
      // Recover the same command even if its transport hint contradicts saved placement.
      await pool.query(
        `UPDATE execution.command_outbox SET available_at=now(),
          payload_json=payload_json || '{"placement":"local-workers"}'::jsonb
          WHERE payload_json->>'taskId'=$1`,
        [task.id],
      );
      await publishPendingTaskCommandsPg(pool, memberDispatcher);
      assert.equal(requests.length, 2);
      assert.equal(requests[1], requests[0]);
      assert.equal(studioWakeups, 0);
      const outbox = (
        await pool.query(
          "SELECT state,last_error FROM execution.command_outbox WHERE payload_json->>'taskId'=$1",
          [task.id],
        )
      ).rows[0];
      assert.equal(outbox.state, "published");
      assert.equal(outbox.last_error, null);
    } finally {
      if (originalApi === undefined) delete process.env.BEAM_STUDIO_API_URL;
      else process.env.BEAM_STUDIO_API_URL = originalApi;
      await pool.query(
        "UPDATE execution.workflow_tasks SET status='cancelled' WHERE workflow_run_id='member-dispatch'",
      );
      await pool.query(
        "UPDATE execution.workflow_runs SET status='cancelled' WHERE id='member-dispatch'",
      );
    }
  },
);

test(
  "persisted remote placement remains gated independently of wakeup metadata",
  { skip: !source },
  async () => {
    await fixture("remote-dispatch", {
      ...manifest,
      runtime: { placements: ["custom"] },
      execution: { taskMode: "single-worker" },
    });
    await pool.query(
      `UPDATE execution.workflow_runs SET resolved_steps_json=
        jsonb_set(jsonb_set(resolved_steps_json,'{0,resolvedPlacement}','"custom"'),
        '{0,executionTarget}','{"kind":"remote-transport"}') WHERE id='remote-dispatch'`,
    );
    let wakeups = 0;
    const remoteDispatcher = {
      ...dispatcher,
      broker: {
        async publishTask() {
          wakeups++;
        },
      },
    };
    await orchestratePg(pool, remoteDispatcher);
    const task = (
      await pool.query(
        "SELECT id FROM execution.workflow_tasks WHERE workflow_run_id='remote-dispatch'",
      )
    ).rows[0];
    const outbox = (
      await pool.query(
        "SELECT state,last_error FROM execution.command_outbox WHERE payload_json->>'taskId'=$1",
        [task.id],
      )
    ).rows[0];
    assert.equal(wakeups, 0);
    assert.equal(outbox.state, "pending");
    assert.match(outbox.last_error, /Remote action transport is disabled/);
    await pool.query(
      "UPDATE execution.command_outbox SET available_at=now() WHERE payload_json->>'taskId'=$1",
      [task.id],
    );
    await publishPendingTaskCommandsPg(pool, {
      ...remoteDispatcher,
      remoteExecutionEnabled: true,
    });
    assert.equal(wakeups, 1);
    await pool.query(
      "UPDATE execution.workflow_tasks SET status='cancelled' WHERE workflow_run_id='remote-dispatch'",
    );
    await pool.query(
      "UPDATE execution.workflow_runs SET status='cancelled' WHERE id='remote-dispatch'",
    );
  },
);

test(
  "concurrent dispatchers produce one distributed plan and one reduction per group",
  { skip: !source },
  async () => {
    await fixture("distributed");
    const worker = runner(async ({ inputs }) => ({
      outputs: { sum: (inputs.values as number[]).reduce((a, b) => a + b, 0) },
    }));
    for (let i = 0; i < 5; i++) {
      const ticks = await Promise.allSettled([
        orchestratePg(pool, dispatcher),
        orchestratePg(pool, dispatcher),
      ]);
      for (const tick of ticks)
        if (tick.status === "rejected") throw tick.reason;
      const tasks = (
        await pool.query(
          "SELECT id FROM execution.workflow_tasks WHERE workflow_run_id='distributed' AND status='queued' ORDER BY shard_index",
        )
      ).rows;
      for (const task of tasks) await worker.processTaskId(task.id);
    }
    const run = (
      await pool.query(
        "SELECT * FROM execution.workflow_runs WHERE id='distributed'",
      )
    ).rows[0];
    assert.equal(run.status, "completed", run.error);
    assert.deepEqual(run.output_json, { sum: 528 });
    const counts = (
      await pool.query(
        "SELECT task_kind,count(*)::int AS n FROM execution.workflow_tasks WHERE workflow_run_id='distributed' GROUP BY task_kind ORDER BY task_kind",
      )
    ).rows;
    assert.deepEqual(counts, [
      { task_kind: "step-intermediate-reduce", n: 4 },
      { task_kind: "step-reduce", n: 1 },
      { task_kind: "step-shard", n: 16 },
    ]);
  },
);
test(
  "a blocked authorization renewal cannot extend execution beyond its local lease",
  { skip: !source },
  async () => {
    await fixture("lease-loss", {
      ...manifest,
      execution: { taskMode: "single-worker" },
    });
    await orchestratePg(pool, dispatcher);
    const task = (
      await pool.query(
        "SELECT id FROM execution.workflow_tasks WHERE workflow_run_id='lease-loss'",
      )
    ).rows[0];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let renewals = 0;
    const started = Date.now();
    try {
      const outcome = await runner(
        async (_, context) => {
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else
              context.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          await assert.rejects(
            () => context.state.patch({ stale: true }),
            /claim expired or cancelled/,
          );
          return { outputs: { sum: 999999 } }; // A late value must not revive the invocation.
        },
        {
          lockTtlMs: 3000,
          authorizeExecution: async (_, request) => {
            if (request.phase === "lease_renewal") {
              renewals++;
              await blocked;
            }
          },
        },
      ).processTaskId(task.id);
      assert.notEqual(outcome.status, "completed");
      assert.ok(renewals > 0);
      assert.ok(Date.now() - started < 10_000);
    } finally {
      release();
    }
    await orchestratePg(pool, dispatcher);
    const stored = (
      await pool.query("SELECT * FROM execution.workflow_tasks WHERE id=$1", [
        task.id,
      ])
    ).rows[0];
    assert.equal(stored.status, "retry_scheduled");
    assert.deepEqual(stored.output_json, {});
    const assignment = (
      await pool.query(
        "SELECT * FROM execution.executor_assignments WHERE task_id=$1",
        [task.id],
      )
    ).rows[0];
    assert.ok(assignment.executor_stopped_at);
    assert.ok(assignment.cleanup_confirmed_at);
    // Keep this intentionally retryable fixture from being picked up by following tests.
    await pool.query(
      "UPDATE execution.workflow_runs SET status='cancel_requested' WHERE id='lease-loss'",
    );
    await orchestratePg(pool, dispatcher);
  },
);
test(
  "cancellation waits for Runner termination and independent room cleanup evidence",
  { skip: !source },
  async () => {
    await fixture("cleanup", {
      ...manifest,
      execution: { taskMode: "single-worker" },
    });
    await orchestratePg(pool, dispatcher);
    const task = (
      await pool.query(
        "SELECT * FROM execution.workflow_tasks WHERE workflow_run_id='cleanup'",
      )
    ).rows[0];
    let began!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const stopping = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const executing = runner(async (_, context) => {
      // This business state is deliberately misleading and cannot certify cleanup.
      await context.state.patch({
        cancellationStatus: "confirmed",
        beamStatus: "completed",
      });
      await pool.query(
        'UPDATE execution.workflow_step_runs SET resource_execution_json=\'{"kind":"room-publication","state":"active"}\' WHERE id=$1',
        [task.workflow_step_run_id],
      );
      began();
      await stopping;
      return { outputs: { sum: 1 } };
    }).processTaskId(task.id);
    await started;
    await pool.query(
      "UPDATE execution.workflow_runs SET status='cancel_requested' WHERE id='cleanup'",
    );
    await orchestratePg(pool, dispatcher);
    let record = (
      await pool.query(
        "SELECT * FROM execution.executor_assignments WHERE task_id=$1",
        [task.id],
      )
    ).rows[0];
    assert.ok(record.cancel_requested_at);
    assert.equal(record.cleanup_confirmed_at, null);
    finish();
    await executing;
    await orchestratePg(pool, dispatcher);
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM execution.workflow_runs WHERE id='cleanup'",
        )
      ).rows[0].status,
      "cancel_requested",
    );
    // Reproduce the provisional warning left by a stopped Runner while resource cleanup is pending.
    await pool.query(
      `UPDATE execution.executor_assignments SET error_json='{"code":"executor_cleanup_required","message":"Room publication cleanup remains unconfirmed."}' WHERE task_id=$1`,
      [task.id],
    );
    await pool.query(
      'UPDATE execution.workflow_step_runs SET resource_execution_json=\'{"kind":"room-publication","state":"cancelled"}\' WHERE id=$1',
      [task.workflow_step_run_id],
    );
    await orchestratePg(pool, dispatcher);
    record = (
      await pool.query(
        "SELECT * FROM execution.executor_assignments WHERE task_id=$1",
        [task.id],
      )
    ).rows[0];
    assert.ok(record.cleanup_confirmed_at);
    assert.equal(record.error_json, null);
    const terminalTask = (await pool.query("SELECT error FROM execution.workflow_tasks WHERE id=$1", [task.id])).rows[0];
    const terminalStep = (await pool.query("SELECT error FROM execution.workflow_step_runs WHERE id=$1", [task.workflow_step_run_id])).rows[0];
    assert.equal(terminalTask.error, null);
    assert.equal(terminalStep.error, null);
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM execution.workflow_runs WHERE id='cleanup'",
        )
      ).rows[0].status,
      "cancelled",
    );
  },
);
test("cleanup warning correction requires independently verified process and room cleanup", { skip: !source }, async () => {
  const task = (await pool.query("SELECT * FROM execution.workflow_tasks WHERE workflow_run_id='cleanup'")).rows[0];
  const assignment = (await pool.query("SELECT * FROM execution.executor_assignments WHERE task_id=$1", [task.id])).rows[0];
  const sql = await readFile(new URL("../packages/db/src/postgres-migrations/0029_verified_room_cleanup.sql", import.meta.url), "utf8");
  const warning = "Room publication cleanup remains unconfirmed.";
  await pool.query("UPDATE execution.workflow_tasks SET error=$2 WHERE id=$1", [task.id, warning]);
  await pool.query("UPDATE execution.workflow_step_runs SET error=$2,resource_execution_json=$3::jsonb WHERE id=$1", [task.workflow_step_run_id, warning, JSON.stringify({ kind: "room-publication", state: "active" })]);
  await pool.query(sql);
  assert.equal((await pool.query("SELECT error FROM execution.workflow_tasks WHERE id=$1", [task.id])).rows[0].error, warning);
  await pool.query("UPDATE execution.workflow_step_runs SET resource_execution_json=$2::jsonb WHERE id=$1", [task.workflow_step_run_id, JSON.stringify({ kind: "room-publication", state: "cancelled" })]);
  await pool.query("UPDATE execution.executor_assignments SET cleanup_confirmed_at=NULL WHERE id=$1", [assignment.id]);
  await pool.query(sql);
  assert.equal((await pool.query("SELECT error FROM execution.workflow_tasks WHERE id=$1", [task.id])).rows[0].error, warning);
  await pool.query("UPDATE execution.executor_assignments SET cleanup_confirmed_at=$2,executor_stopped_at=NULL WHERE id=$1", [assignment.id, assignment.cleanup_confirmed_at]);
  await pool.query(sql);
  assert.equal((await pool.query("SELECT error FROM execution.workflow_tasks WHERE id=$1", [task.id])).rows[0].error, warning);
  await pool.query("UPDATE execution.executor_assignments SET executor_stopped_at=$2 WHERE id=$1", [assignment.id, assignment.executor_stopped_at]);
  await pool.query(sql);
  assert.equal((await pool.query("SELECT error FROM execution.workflow_tasks WHERE id=$1", [task.id])).rows[0].error, "Execution cancelled.");
  assert.equal((await pool.query("SELECT error FROM execution.workflow_step_runs WHERE id=$1", [task.workflow_step_run_id])).rows[0].error, "Execution cancelled.");
});

test(
  "process recovery fences unfinished preparation and requires durable native evidence",
  { skip: !source },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "beam-worker-process-evidence-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const owner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await once(owner, "spawn");
    const ownership = await prepareProcessOwnership(
      directory,
      "owner-crash",
      owner.pid!,
    );
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
    for (const state of ["preparing", "ready", "missing", "foreign"] as const) {
      const runId = `ownership-${state}`;
      await fixture(runId, {
        ...manifest,
        execution: { taskMode: "single-worker" },
      });
      await orchestratePg(pool, dispatcher);
      const task = (
        await pool.query(
          "SELECT * FROM execution.workflow_tasks WHERE workflow_run_id=$1",
          [runId],
        )
      ).rows[0];
      await pool.query(
        "UPDATE execution.workflow_tasks SET status='running',attempt_count=1,attempts=1,claim_token='crashed-claim' WHERE id=$1",
        [task.id],
      );
      await pool.query(
        `INSERT INTO execution.executor_assignments(id,organization_id,workflow_run_id,workflow_step_run_id,task_id,attempt,backend,executor_id,declared_target_json,state,lease_expires_at)
      VALUES($1,'org',$2,$3,$4,1,'studio','crashed-runner-identity','{"kind":"studio"}','running',now()-interval '1 minute')`,
        [runId, runId, task.workflow_step_run_id, task.id],
      );
      await pool.query(
        `INSERT INTO execution.executor_process_ownership(assignment_id,state,record_path,record_nonce,owner_scope) VALUES($1,$2,$3,$4,$5)`,
        [
          runId,
          state === "preparing" ? "preparing" : "ready",
          state === "missing"
            ? path.join(directory, "absent.json")
            : ownership.path,
          ownership.nonce,
          state === "foreign"
            ? "another-machine"
            : await getProcessOwnershipScope(),
        ],
      );
      await reconcileWorkerProcesses(pool);
      const assignment = (
        await pool.query(
          "SELECT executor_stopped_at,cleanup_confirmed_at,progress_json FROM execution.executor_assignments WHERE id=$1",
          [runId],
        )
      ).rows[0];
      assert.equal(
        Boolean(assignment.executor_stopped_at),
        state !== "missing" && state !== "foreign",
      );
      assert.equal(
        assignment.cleanup_confirmed_at,
        null,
        "Process recovery must leave resource/outcome settlement to the Dispatcher",
      );
      if (state === "missing")
        assert.equal(
          assignment.progress_json.reconciliation.code,
          "process_evidence_unavailable",
        );
      else {
        assert.equal(
          (
            await pool.query(
              "UPDATE execution.executor_process_ownership SET state='ready' WHERE assignment_id=$1 AND state='preparing'",
              [runId],
            )
          ).rowCount,
          0,
        );
      }
    }
  },
);

test(
  "a terminal action failure leaves run finalization to the dispatcher",
  { skip: !source },
  async () => {
    await fixture("failure", {
      ...manifest,
      execution: { taskMode: "single-worker" },
    });
    await orchestratePg(pool, dispatcher);
    const task = (
      await pool.query(
        "SELECT id FROM execution.workflow_tasks WHERE workflow_run_id='failure'",
      )
    ).rows[0];
    await runner(async () => {
      throw new ActionExecutionError("Failed action", { retryable: false });
    }).processTaskId(task.id);
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM execution.workflow_runs WHERE id='failure'",
        )
      ).rows[0].status,
      "running",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM execution.workflow_step_runs WHERE workflow_run_id='failure'",
        )
      ).rows[0].status,
      "failed",
    );
    await orchestratePg(pool, dispatcher);
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM execution.workflow_runs WHERE id='failure'",
        )
      ).rows[0].status,
      "failed",
    );
  },
);
