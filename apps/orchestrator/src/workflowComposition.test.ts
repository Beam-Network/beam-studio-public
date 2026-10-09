import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import {
  captureWorkflowTreePg,
  createPostgresPool,
  enqueueFrozenWorkflowRunPg,
  ensurePostgresMigrations,
  requestWorkflowCancellationPg,
  retryFrozenWorkflowRunPg,
  withPostgresTransaction,
  workflowHasBillingKeySql,
  type PgPool,
} from "@beam-studio/db";
import { orchestratePg, startWorkflowRunPg } from "./postgresOrchestration.js";
import type { OrchestratorOptions } from "./types.js";

test(
  "named references freeze for child inputs and explicit retries while run-again refreshes them",
  { skip: !process.env.BEAM_TEST_POSTGRES_URL && !process.env.DATABASE_URL },
  async () => {
    await definition("refs-child", {
      payload: "${workflow.input.payload}",
      agentId: "${workflow.input.agentId}",
    });
    await definition("refs-parent", "${steps.refs-call.outputs}");
    await call("refs-parent", "refs-child", "refs-call", {
      payload: "${workflow.resources.fixture.value}",
      agentId: "${workflow.agents.source.agentId}",
    });
    await pool.query(
      "INSERT INTO agent_control.agents(id,organization_id,name,public_key) VALUES('refs-agent-a','org','Source','refs-key-a'),('refs-agent-b','org','Replacement','refs-key-b')",
    );
    const update = (agentId: string, value: unknown) =>
      pool.query(
        "UPDATE workflow.templates SET agent_bindings_json=$1::jsonb,resource_bindings_json=$2::jsonb WHERE id='refs-parent'",
        [
          JSON.stringify({ source: { agentId } }),
          JSON.stringify({ fixture: { kind: "data", value } }),
        ],
      );
    const original = {
      version: 1,
      literal: "${steps.child-internals.outputs.private}",
    };
    await update("refs-agent-a", original);
    const runId = await startWorkflowRunPg(pool, "refs-parent");
    const saved = (
      await pool.query(
        "SELECT template_snapshot_json,resolved_steps_json FROM execution.workflow_runs WHERE id=$1",
        [runId],
      )
    ).rows[0];
    assert.equal(
      saved.template_snapshot_json.steps[0].inputBindings.agentId,
      "${workflow.agents.source.agentId}",
    );
    assert.deepEqual(saved.resolved_steps_json[0].inputBindings.agentId, {
      $literal: "refs-agent-a",
    });
    await update("refs-agent-b", { version: 2 });
    // A retry before dispatch retains the originally accepted definition and references.
    await pool.query(
      "UPDATE execution.workflow_runs SET status='failed',error='before dispatch' WHERE id=$1",
      [runId],
    );
    await withPostgresTransaction(pool, (client) =>
      retryFrozenWorkflowRunPg(client, {
        authorizeExecution: async () => {},
        workflowRunId: runId,
        organizationId: "org",
      }),
    );
    const completed = await settle(runId!);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.output_json, {
      payload: original,
      agentId: "refs-agent-a",
    });
    const again = await startWorkflowRunPg(pool, "refs-parent");
    assert.deepEqual((await settle(again!)).output_json, {
      payload: { version: 2 },
      agentId: "refs-agent-b",
    });
    await update("missing-agent", {});
    await assert.rejects(startWorkflowRunPg(pool, "refs-parent"), {
      code: "execution_agent_reference_unavailable",
    });
  },
);

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
const enabled = Boolean(source?.startsWith("postgres"));
let pool: PgPool;
let maintenance: PgPool;
const database = `workflow_composition_${crypto.randomBytes(6).toString("hex")}`;
const options: OrchestratorOptions = {
  authorizeExecution: async () => {},
  batchSize: 100,
  maxAttempts: 3,
  logger: { info() {}, warn() {}, error() {} },
  broker: {
    async publishTask() {
      throw new Error("A workflow call must not occupy an Action Runner.");
    },
  },
};
before(async () => {
  if (!enabled) return;
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  maintenance = createPostgresPool(source);
  await maintenance.query(`CREATE DATABASE ${database}`);
  const url = new URL(source!);
  url.pathname = `/${database}`;
  pool = createPostgresPool(url.toString());
  await ensurePostgresMigrations(pool);
  await ensurePostgresMigrations(pool);
  await pool.query(
    "INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Test'),('other','other','Other')",
  );
});
after(async () => {
  await pool?.end();
  if (maintenance) {
    await maintenance.query(`DROP DATABASE IF EXISTS ${database}`);
    await maintenance.end();
  }
});
async function definition(
  id: string,
  bindings: unknown = {},
  schema: unknown = { type: "object" },
) {
  await pool.query(
    `INSERT INTO workflow.templates(id,organization_id,name,output_contract_json,api_key_id)
    VALUES($1,'org',$1,$2::jsonb,'execution-key')`,
    [id, JSON.stringify({ schema, bindings })],
  );
}

test(
  "unconfigured automatic workflows do not block schedules or source completion",
  { skip: !enabled },
  async () => {
    await definition("unconfigured-trigger");
    await definition("configured-trigger-source");
    await pool.query(
      "UPDATE workflow.templates SET api_key_id=NULL WHERE id='unconfigured-trigger'",
    );
    await pool.query(
    `INSERT INTO workflow.triggers(id,workflow_template_id,type,name,enabled,config_json) VALUES
    ('unconfigured-schedule','unconfigured-trigger','schedule','Schedule',true,'{"frequency":"every 30 minutes","nextRunAt":"2026-01-01T00:00:00.000Z"}'),
    ('unconfigured-date','unconfigured-trigger','date','Date',true,'{"runAt":"2026-01-01T00:00:00.000Z"}'),
    ('unconfigured-completion','unconfigured-trigger','completion','Completion',true,'{"sourceKind":"workflow","sourceId":"configured-trigger-source"}')`,
    );
    const id = await startWorkflowRunPg(pool, "configured-trigger-source");
    assert.equal((await settle(id)).status, "completed");
    const count = (
      await pool.query(
        "SELECT count(*)::int AS n FROM execution.workflow_runs WHERE workflow_template_id='unconfigured-trigger'",
      )
    ).rows[0].n;
    assert.equal(count, 0);
    await pool.query(
      "UPDATE workflow.triggers SET enabled=false WHERE workflow_template_id='unconfigured-trigger'",
    );
  },
);

test(
  "a Beam Transfer step's credential lets automatic triggers launch without a selected key",
  { skip: !enabled },
  async () => {
    await definition("transfer-key-only");
    await pool.query(
      "UPDATE workflow.templates SET api_key_id=NULL WHERE id='transfer-key-only'",
    );
    const launchable = async () =>
      (
        await pool.query(
          `SELECT ${workflowHasBillingKeySql("w")} AS ok FROM workflow.templates w WHERE w.id='transfer-key-only'`,
        )
      ).rows[0].ok;
    const step = (id: string, position: number, credentialId: string) =>
      pool.query(
        `INSERT INTO workflow.steps(id,workflow_template_id,action_package_name,position,config_json)
        VALUES($1,'transfer-key-only','@beam/transfer',$2,$3::jsonb)`,
        [id, position, JSON.stringify({ credentialId })],
      );

    assert.equal(await launchable(), false);
    await step("transfer-key-a", 0, "beam-key");
    assert.equal(await launchable(), true);
    // Two transfer keys are ambiguous; the launch refuses them, so the scan
    // must not queue a run for them either.
    await step("transfer-key-b", 1, "other-beam-key");
    assert.equal(await launchable(), false);
    await pool.query(
      "UPDATE workflow.steps SET enabled=false WHERE id='transfer-key-b'",
    );
    assert.equal(await launchable(), true);
    await pool.query(
      "UPDATE workflow.steps SET retired_at=now() WHERE workflow_template_id='transfer-key-only'",
    );
  },
);

async function call(
  parent: string,
  child: string,
  step: string,
  inputs: unknown = {},
  position = 0,
) {
  await pool.query(
    `INSERT INTO workflow.steps(id,workflow_template_id,kind,called_workflow_id,position,input_bindings_json)
    VALUES($1,$2,'workflow',$3,$4,$5::jsonb)`,
    [step, parent, child, position, JSON.stringify(inputs)],
  );
}
async function settle(id: string) {
  for (let i = 0; i < 15; i++) {
    await orchestratePg(pool, options);
    const row = (
      await pool.query("SELECT * FROM execution.workflow_runs WHERE id=$1", [
        id,
      ])
    ).rows[0];
    if (["completed", "failed", "cancelled"].includes(row.status)) return row;
  }
  assert.fail("Run did not settle after 15 dispatcher ticks");
}
test(
  "frozen child contract composes without runner work and survives concurrent dispatch",
  { skip: !enabled },
  async () => {
    await definition("leaf", { value: "${workflow.input.value}" });
    await definition("parent", "${steps.invoke.outputs}");
    await call("parent", "leaf", "invoke", {
      value: "${workflow.input.value}",
    });
    const id = await startWorkflowRunPg(pool, "parent", { value: 42 });
    await pool.query(
      `UPDATE workflow.templates SET output_contract_json='{"schema":{"type":"string"},"bindings":"changed"}' WHERE id='leaf'`,
    );
    await Promise.all([
      orchestratePg(pool, options),
      orchestratePg(pool, options),
      orchestratePg(pool, options),
    ]);
    const run = await settle(id);
    assert.equal(run.status, "completed");
    assert.equal(run.output_validation, "valid");
    assert.deepEqual(run.output_json, { value: 42 });
    const children = (
      await pool.query(
        "SELECT * FROM execution.workflow_runs WHERE parent_run_id=$1",
        [id],
      )
    ).rows;
    assert.equal(children.length, 1);
    assert.equal(children[0].root_run_id, id);
    assert.deepEqual(children[0].output_json, { value: 42 });
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM execution.command_outbox WHERE aggregate_id=$1 AND command_type='workflow_run.queued'",
          [children[0].id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM execution.workflow_tasks WHERE workflow_run_id=ANY($1::text[])",
          [[id, children[0].id]],
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(
      pool.query(
        "UPDATE execution.workflow_runs SET input_json='{}' WHERE id=$1",
        [id],
      ),
      /immutable/,
    );
    await assert.rejects(
      pool.query(
        "UPDATE workflow.plan_versions SET compiled_plan_json='{}' WHERE id=$1",
        [run.workflow_plan_version_id],
      ),
      /immutable/,
    );
  },
);
test(
  "invalid outputs fail the call and never become business output",
  { skip: !enabled },
  async () => {
    await definition("invalid", "string", { type: "integer" });
    await definition("invalid-parent");
    await call("invalid-parent", "invalid", "bad-call");
    const id = await startWorkflowRunPg(pool, "invalid-parent");
    assert.equal((await settle(id)).status, "failed");
    const child = (
      await pool.query(
        "SELECT * FROM execution.workflow_runs WHERE parent_run_id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(child.output_validation, "invalid");
    assert.equal(child.output_json, null);
    assert.match(child.error, /Workflow output/);
  },
);
test(
  "cycles, inaccessible dependencies and invalid input fail before creating a run",
  { skip: !enabled },
  async () => {
    await definition("cycle-a");
    await definition("cycle-b");
    await call("cycle-a", "cycle-b", "ab");
    await call("cycle-b", "cycle-a", "ba");
    await assert.rejects(startWorkflowRunPg(pool, "cycle-a"), /Recursive/);
    await definition("foreign");
    await definition("foreign-parent");
    await pool.query(
      "UPDATE workflow.templates SET organization_id='other' WHERE id='foreign'",
    );
    await call("foreign-parent", "foreign", "foreign-call");
    await assert.rejects(
      startWorkflowRunPg(pool, "foreign-parent"),
      /unavailable/,
    );
    await definition("typed");
    await pool.query(
      `UPDATE workflow.templates SET input_schema_json='{"type":"object","properties":{"n":{"type":"integer"}},"required":["n"]}' WHERE id='typed'`,
    );
    await assert.rejects(
      startWorkflowRunPg(pool, "typed", { n: "1" }),
      /Workflow input/,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM execution.workflow_runs WHERE workflow_template_id IN ('cycle-a','foreign-parent','typed')",
        )
      ).rows[0].n,
      0,
    );
  },
);
test(
  "duplicate invocation delivery recovers one immutable child and one queue event",
  { skip: !enabled },
  async () => {
    await definition("idempotent");
    await definition("idempotent-caller");
    await call("idempotent-caller", "idempotent", "idempotent-call");
    const parentId = await startWorkflowRunPg(pool, "idempotent-caller");
    await orchestratePg(pool, options);
    const invocation = (
      await pool.query(
        "SELECT id,child_run_id FROM execution.workflow_step_runs WHERE workflow_run_id=$1",
        [parentId],
      )
    ).rows[0];
    const tree = await withPostgresTransaction(pool, (client) =>
      captureWorkflowTreePg(client, {
        organizationId: "org",
        workflowTemplateId: "idempotent",
      }),
    );
    const launch = () =>
      withPostgresTransaction(pool, (client) =>
        enqueueFrozenWorkflowRunPg(client, {
          definition: tree.root,
          definitions: tree.definitions,
          runtimeInput: {},
          trigger: "workflow",
          parentRunId: parentId,
          rootRunId: parentId,
          invokingStepRunId: invocation.id,
          invocationAttempt: 1,
          executionContext: { billing: { apiKeyId: "execution-key" } },
        }),
      );
    const ids = await Promise.all([launch(), launch(), launch()]);
    assert.equal(new Set(ids).size, 1);
    assert.equal(ids[0], invocation.child_run_id);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM execution.workflow_events WHERE workflow_run_id=$1 AND event_type='WorkflowRunQueued'",
          [ids[0]],
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  "failed-only retry freezes definitions and preserves completed children",
  { skip: !enabled },
  async () => {
    await definition("retry-leaf", { version: 1 });
    await definition("retry-parent");
    await call("retry-parent", "retry-leaf", "keep", {}, 0);
    await call("retry-parent", "retry-leaf", "retry", {}, 1);
    await pool.query(
      "INSERT INTO workflow.edges(id,workflow_template_id,from_step_id,to_step_id) VALUES('retry-edge','retry-parent','keep','retry')",
    );
    const runId = await startWorkflowRunPg(pool, "retry-parent");
    for (let tick = 0; tick < 4; tick++) await orchestratePg(pool, options);
    const children = (
      await pool.query(
        `SELECT c.*,s.workflow_step_id FROM execution.workflow_runs c
    JOIN execution.workflow_step_runs s ON s.id=c.invoking_step_run_id WHERE c.parent_run_id=$1`,
        [runId],
      )
    ).rows;
    const successful = children.find((row) => row.workflow_step_id === "keep")!;
    const failed = children.find((row) => row.workflow_step_id === "retry")!;
    await pool.query(
      `UPDATE execution.workflow_runs SET status='failed',error='transient child failure',completed_at=now() WHERE id=$1`,
      [failed.id],
    );
    assert.equal((await settle(runId)).status, "failed");
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM execution.workflow_runs WHERE id=$1",
          [successful.id],
        )
      ).rows[0].status,
      "completed",
    );
    await pool.query(
      `UPDATE workflow.templates SET output_contract_json='{"schema":{"type":"object"},"bindings":{"version":2}}' WHERE id='retry-leaf'`,
    );
    await withPostgresTransaction(pool, (client) =>
      retryFrozenWorkflowRunPg(client, {
        authorizeExecution: async () => {},
        workflowRunId: runId,
        organizationId: "org",
      }),
    );
    assert.equal((await settle(runId)).status, "completed");
    const after = (
      await pool.query(
        "SELECT * FROM execution.workflow_runs WHERE parent_run_id=$1 ORDER BY created_at",
        [runId],
      )
    ).rows;
    assert.equal(after.length, 3);
    assert.equal(
      after.filter(
        (row) => row.invoking_step_run_id === successful.invoking_step_run_id,
      ).length,
      1,
    );
    assert.equal(after[2].invocation_attempt, 2);
    assert.deepEqual(after[2].output_json, { version: 1 });
  },
);

test(
  "explicit scheduled retries get a new clock while preserving frozen intent and enforcing the new deadline",
  { skip: !enabled },
  async () => {
    await definition("retry-clock", { value: "frozen" });
    const runId = await startWorkflowRunPg(pool, "retry-clock");
    const before = (
      await pool.query(
        `UPDATE execution.workflow_runs SET status='failed',
      trigger='schedule',trigger_event_json='{"maxRunDurationSeconds":60}',
      started_at=now()-interval '2 hours',completed_at=now()-interval '1 hour'
      WHERE id=$1 RETURNING *`,
        [runId],
      )
    ).rows[0];
    await withPostgresTransaction(pool, (client) =>
      retryFrozenWorkflowRunPg(client, {
        workflowRunId: runId,
        organizationId: "org",
        authorizeExecution: async () => {},
      }),
    );
    const retried = (
      await pool.query("SELECT * FROM execution.workflow_runs WHERE id=$1", [
        runId,
      ])
    ).rows[0];
    assert.equal(retried.status, "running");
    assert.ok(Date.now() - new Date(retried.started_at).getTime() < 10_000);
    for (const key of [
      "created_at",
      "template_snapshot_json",
      "execution_context_json",
      "resolved_steps_json",
      "workflow_plan_version_id",
      "trigger_event_json",
    ]) {
      assert.deepEqual(retried[key], before[key], key);
    }
    const event = (
      await pool.query(
        "SELECT payload_json FROM execution.workflow_events WHERE workflow_run_id=$1 AND event_type='WorkflowRunRetried'",
        [runId],
      )
    ).rows[0].payload_json;
    assert.equal(
      event.previousStartedAt,
      new Date(before.started_at).toISOString(),
    );
    assert.equal(
      event.previousCompletedAt,
      new Date(before.completed_at).toISOString(),
    );
    await assert.rejects(
      withPostgresTransaction(pool, (client) =>
        retryFrozenWorkflowRunPg(client, {
          workflowRunId: runId,
          organizationId: "org",
          authorizeExecution: async () => {},
        }),
      ),
      /Only failed or cancelled/,
    );
    assert.equal((await settle(runId)).status, "completed");
    // The frozen limit remains effective against this retry's clock.
    await pool.query(
      "UPDATE execution.workflow_runs SET status='running',started_at=now()-interval '61 seconds',completed_at=NULL WHERE id=$1",
      [runId],
    );
    const expired = await settle(runId);
    assert.equal(expired.status, "cancelled");
    assert.equal(expired.error, "schedule max run duration exceeded");
  },
);

test(
  "terminal room retry rejects without changing publication, tasks, attempts or billing",
  { skip: !enabled },
  async () => {
    for (const variant of ["cancelled", "expired"]) {
      await definition(`room-retry-${variant}`);
      const runId = await startWorkflowRunPg(pool, `room-retry-${variant}`);
      assert.ok(runId);
      const stepId = `room-retry-step-${variant}`;
      const state =
        variant === "cancelled"
          ? {
              publicationId: "terminal-publication",
              publishRequested: true,
              beamStatus: "cancelled",
              cancellationStatus: "confirmed",
            }
          : {
              publicationId: "terminal-publication",
              beamStatus: "in_progress",
              expiresAt: "2020-01-01T00:00:00Z",
            };
      await pool.query(
        `UPDATE execution.workflow_runs SET status='failed',error='room stopped',completed_at=now() WHERE id=$1`,
        [runId],
      );
      await pool.query(
        `INSERT INTO workflow.steps(id,workflow_template_id,action_package_name,position)
          VALUES($1,$2,'@beam/room-transfer',0)`,
        [stepId, `room-retry-${variant}`],
      );
      await pool.query(
        `INSERT INTO execution.workflow_step_runs
          (id,workflow_run_id,workflow_step_id,action_package_name,resolved_version,
            checksum,source_registry,resolved_placement,status,state_json)
          VALUES($1,$2,$1,'@beam/room-transfer','2.1.0','fixture-checksum','registry','local-workers','failed',$3::jsonb)`,
        [stepId, runId, JSON.stringify(state)],
      );
      await pool.query(
        `INSERT INTO execution.workflow_tasks
          (id,organization_id,workflow_run_id,workflow_step_run_id,workflow_step_id,
            action_package_name,task_kind,status,attempts,input_checksum)
          VALUES($1,'org',$2,$3,$3,'@beam/room-transfer','step','dead_letter',1,'fixture-input')`,
        [`room-task-${variant}`, runId, stepId],
      );
      const snapshot = async () =>
        (
          await pool.query(
            `SELECT to_jsonb(r) AS run,
          (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM execution.workflow_step_runs s WHERE s.workflow_run_id=r.id) AS steps,
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM execution.workflow_tasks t WHERE t.workflow_run_id=r.id) AS tasks,
          (SELECT count(*) FROM execution.workflow_events e WHERE e.workflow_run_id=r.id) AS events
          FROM execution.workflow_runs r WHERE r.id=$1`,
            [runId],
          )
        ).rows[0];
      const before = await snapshot();
      await assert.rejects(
        () =>
          withPostgresTransaction(pool, (client) =>
            retryFrozenWorkflowRunPg(client, {
              workflowRunId: runId,
              organizationId: "org",
              authorizeExecution: async () => {},
            }),
          ),
        (error: any) =>
          error.statusCode === 409 &&
          error.code === "room_transfer_retry_unavailable" &&
          /Run the workflow again/.test(error.message),
      );
      assert.deepEqual(await snapshot(), before);
      await assert.rejects(
        () =>
          withPostgresTransaction(pool, (client) =>
            retryFrozenWorkflowRunPg(client, {
              workflowRunId: runId,
              organizationId: "other",
              authorizeExecution: async () => {},
            }),
          ),
        /Workflow run not found/,
      );
      // A transient reconnect still reuses its original publication and frozen step.
      const activeState = {
        publicationId: "active-publication",
        beamStatus: "in_progress",
        expiresAt: "2030-01-01T00:00:00Z",
      };
      await pool.query(
        "UPDATE execution.workflow_step_runs SET state_json=$2::jsonb WHERE id=$1",
        [stepId, JSON.stringify(activeState)],
      );
      await withPostgresTransaction(pool, (client) =>
        retryFrozenWorkflowRunPg(client, {
          workflowRunId: runId,
          organizationId: "org",
          authorizeExecution: async () => {},
        }),
      );
      const retried = await snapshot();
      assert.equal(retried.run.status, "running");
      assert.equal(retried.steps[0].attempt, 2);
      assert.deepEqual(retried.steps[0].state_json, activeState);
      assert.equal(retried.tasks[0].status, "retry_scheduled");
      assert.equal(retried.tasks[0].attempts, 1);
      // This fixture exercises retry settlement, without dispatching a provider job.
      await pool.query(
        "UPDATE execution.workflow_runs SET status='failed' WHERE id=$1",
        [runId],
      );
      await pool.query(
        "UPDATE execution.workflow_tasks SET status='dead_letter' WHERE workflow_run_id=$1",
        [runId],
      );
      await pool.query(
        "UPDATE execution.workflow_step_runs SET status='failed' WHERE workflow_run_id=$1",
        [runId],
      );
    }
  },
);

test(
  "recursive cancellation settles descendants before the parent",
  { skip: !enabled },
  async () => {
    await definition("cancel-leaf");
    await definition("cancel-parent");
    await call("cancel-parent", "cancel-leaf", "cancel-call");
    const runId = await startWorkflowRunPg(pool, "cancel-parent");
    await orchestratePg(pool, options);
    await withPostgresTransaction(pool, (client) =>
      requestWorkflowCancellationPg(client, runId, "org"),
    );
    const cancelled = await settle(runId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error, "cancellation requested");
    assert.equal(cancelled.output_json, null);
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM execution.workflow_runs WHERE parent_run_id=$1",
          [runId],
        )
      ).rows[0].status,
      "cancelled",
    );
  },
);

test(
  "authorization cancellation preserves its reason in the run and terminal event",
  { skip: !enabled },
  async () => {
    await definition("denied-run");
    const runId = await startWorkflowRunPg(pool, "denied-run");
    const reason =
      "execution_credential_revoked: The execution credential was revoked.";
    await withPostgresTransaction(pool, (client) =>
      requestWorkflowCancellationPg(client, runId, "org", reason),
    );
    const cancelled = await settle(runId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error, reason);
    const event = (
      await pool.query(
        "SELECT payload_json FROM execution.workflow_events WHERE workflow_run_id=$1 AND event_type='WorkflowCancelled'",
        [runId],
      )
    ).rows[0];
    assert.equal(event.payload_json.error, reason);
  },
);

test(
  "missing input binding fails a nullable child input rather than fabricating null",
  { skip: !enabled },
  async () => {
    await definition("nullable");
    await definition("missing-binding");
    await call("missing-binding", "nullable", "missing-call", {
      value: "${workflow.input.absent}",
    });
    const runId = await startWorkflowRunPg(pool, "missing-binding");
    assert.equal((await settle(runId)).status, "failed");
    const step = (
      await pool.query(
        "SELECT * FROM execution.workflow_step_runs WHERE workflow_run_id=$1",
        [runId],
      )
    ).rows[0];
    assert.match(step.error, /Unresolved workflow binding/);
    assert.equal(step.child_run_id, null);
  },
);

test(
  "fan-out workflow calls expose scalar public results in deterministic order",
  { skip: !enabled },
  async () => {
    await definition("scalar-child", "${workflow.input.value}", {
      type: "integer",
    });
    await definition("fan-parent", "${steps.join.outputs.values}", {
      type: "array",
      items: { type: "integer" },
    });
    await call("fan-parent", "scalar-child", "fan-call", {
      value: "${graph.fan.item}",
    });
    await pool.query(
      `UPDATE workflow.templates SET graph_version='workflow-graph/v2',graph_json=$1::jsonb WHERE id='fan-parent'`,
      [
        JSON.stringify({
          version: "workflow-graph/v2",
          edges: [],
          controls: [
            {
              id: "fan",
              kind: "fan-out",
              items: [3, 1, 2],
              concurrency: 2,
              fanInId: "join",
              body: {
                stepIds: ["fan-call"],
                entryStepId: "fan-call",
                outputStepId: "fan-call",
                edges: [],
              },
            },
          ],
        }),
      ],
    );
    const runId = await startWorkflowRunPg(pool, "fan-parent");
    const run = await settle(runId);
    assert.equal(run.status, "completed", run.error);
    assert.deepEqual(run.output_json, [3, 1, 2]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM execution.workflow_runs WHERE parent_run_id=$1",
          [runId],
        )
      ).rows[0].n,
      3,
    );
  },
);

test(
  "workflow call depth is bounded at sixteen definitions",
  { skip: !enabled },
  async () => {
    for (let depth = 0; depth < 17; depth++) await definition(`depth-${depth}`);
    for (let depth = 0; depth < 16; depth++)
      await call(`depth-${depth}`, `depth-${depth + 1}`, `depth-call-${depth}`);
    await assert.rejects(
      startWorkflowRunPg(pool, "depth-0"),
      /depth exceeds 16/,
    );
    await assert.doesNotReject(startWorkflowRunPg(pool, "depth-1"));
  },
);

test(
  "composed dynamic expansion rejects save and launch without snapshot side effects",
  { skip: !enabled },
  async () => {
    await definition("budget-leaf");
    await definition("budget-child");
    await definition("budget-parent");
    await call("budget-child", "budget-leaf", "budget-child-call");
    await call("budget-parent", "budget-child", "budget-parent-call");
    const graph = (stepId: string, count: number) => ({
      version: "workflow-graph/v2",
      edges: [],
      controls: [
        {
          id: `${stepId}-loop`,
          kind: "loop",
          iterations: count,
          body: {
            stepIds: [stepId],
            entryStepId: stepId,
            outputStepId: stepId,
            edges: [],
          },
        },
      ],
    });
    await pool.query(
      "UPDATE workflow.templates SET graph_version='workflow-graph/v2',graph_json=$2::jsonb WHERE id=$1",
      ["budget-child", JSON.stringify(graph("budget-child-call", 1000))],
    );
    await pool.query(
      "UPDATE workflow.templates SET graph_version='workflow-graph/v2',graph_json=$2::jsonb WHERE id=$1",
      ["budget-parent", JSON.stringify(graph("budget-parent-call", 100))],
    );
    await assert.rejects(
      startWorkflowRunPg(pool, "budget-parent"),
      /expansion limit/,
    );
    await assert.rejects(
      withPostgresTransaction(pool, (client) =>
        captureWorkflowTreePg(client, {
          organizationId: "org",
          workflowTemplateId: "budget-parent",
          validateOnly: true,
        }),
      ),
      /expansion limit/,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM workflow.plan_versions WHERE workflow_template_id IN ('budget-parent','budget-child','budget-leaf')",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM execution.workflow_runs WHERE workflow_template_id='budget-parent'",
        )
      ).rows[0].n,
      0,
    );
    await pool.query(
      "UPDATE workflow.templates SET graph_json=$2::jsonb WHERE id=$1",
      ["budget-parent", JSON.stringify(graph("budget-parent-call", 99))],
    );
    const run = await startWorkflowRunPg(pool, "budget-parent");
    assert.ok(run);
    await pool.query(
      "UPDATE execution.workflow_runs SET status='cancelled' WHERE id=$1",
      [run],
    );
  },
);

test(
  "a failed child reaches a notification call and only explicit handling absorbs failure",
  { skip: !enabled },
  async () => {
    await definition("notify-leaf", { error: "${workflow.input.error}" });
    await definition("fail-leaf", "invalid", { type: "number" });
    await definition("recovery-parent", "${steps.notify.outputs}");
    await call("recovery-parent", "fail-leaf", "failure", {}, 0);
    await call(
      "recovery-parent",
      "notify-leaf",
      "notify",
      { error: "${steps.failure.error}" },
      1,
    );
    await pool.query(
      "UPDATE workflow.templates SET graph_version='workflow-graph/v2' WHERE id='recovery-parent'",
    );
    await pool.query(
      `INSERT INTO workflow.decisions(id,workflow_template_id,name,handle_failure) VALUES('recover','recovery-parent','Recover',true)`,
    );
    await pool.query(
      `INSERT INTO workflow.decision_edges(id,workflow_template_id,from_step_id,to_decision_id) VALUES('failure-recover','recovery-parent','failure','recover')`,
    );
    await pool.query(
      `INSERT INTO workflow.decision_edges(id,workflow_template_id,from_decision_id,to_step_id,branch) VALUES('recover-notify','recovery-parent','recover','notify','false')`,
    );
    const id = await startWorkflowRunPg(pool, "recovery-parent");
    const run = await settle(id);
    assert.equal(run.status, "completed", run.error);
    assert.match(run.output_json.error, /Workflow output/);
    await pool.query(
      "UPDATE workflow.decisions SET handle_failure=false WHERE id='recover'",
    );
    const unhandled = await startWorkflowRunPg(pool, "recovery-parent");
    assert.equal((await settle(unhandled)).status, "failed");
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM execution.workflow_step_runs WHERE workflow_run_id=$1 AND workflow_step_id='notify'",
          [unhandled],
        )
      ).rows[0].status,
      "completed",
    );
  },
);

test(
  "loop calls retain scalar child outputs and do not repeat earlier iterations",
  { skip: !enabled },
  async () => {
    await definition("loop-leaf", "${workflow.input.iteration}", {
      type: "integer",
    });
    await definition("loop-parent", "${steps.loop.outputs.values}", {
      type: "array",
      items: { type: "integer" },
    });
    await call("loop-parent", "loop-leaf", "loop-call", {
      iteration: "${graph.loop.iteration}",
    });
    await pool.query(
      `UPDATE workflow.templates SET graph_version='workflow-graph/v2',graph_json=$1::jsonb WHERE id='loop-parent'`,
      [
        JSON.stringify({
          version: "workflow-graph/v2",
          edges: [],
          controls: [
            {
              id: "loop",
              kind: "loop",
              iterations: 2,
              body: {
                stepIds: ["loop-call"],
                entryStepId: "loop-call",
                outputStepId: "loop-call",
                edges: [],
              },
            },
          ],
        }),
      ],
    );
    const id = await startWorkflowRunPg(pool, "loop-parent");
    assert.deepEqual((await settle(id)).output_json, [1, 2]);
    await orchestratePg(pool, options);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM execution.workflow_runs WHERE parent_run_id=$1",
          [id],
        )
      ).rows[0].n,
      2,
    );
  },
);
