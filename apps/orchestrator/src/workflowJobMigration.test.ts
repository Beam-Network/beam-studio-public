import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  migratedJobEdges,
  prepareWorkflowJobCutoverPg,
  recordWorkflowCutoverBackupPg,
  migrateJobsToWorkflowsPg,
  resumeWorkflowJobCutoverPg,
  type PgPool,
} from "@beam-studio/db";
import { orchestratePg, startWorkflowRunPg } from "./postgresOrchestration.js";
import type { OrchestratorOptions } from "./types.js";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
let pool: PgPool, maintenance: PgPool;
const database = `workflow_migration_${crypto.randomBytes(6).toString("hex")}`;
before(async () => {
  if (!source) return;
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  maintenance = createPostgresPool(source);
  await maintenance.query(`CREATE DATABASE ${database}`);
  const url = new URL(source);
  url.pathname = `/${database}`;
  pool = createPostgresPool(url.toString());
  await ensurePostgresMigrations(pool);
  await pool.query(
    readFileSync(
      new URL(
        "../../../packages/db/src/fixtures/pre-workflow-jobs.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
after(async () => {
  await pool?.end();
  if (maintenance) {
    await maintenance.query(`DROP DATABASE IF EXISTS ${database}`);
    await maintenance.end();
  }
});

test("Job dependencies become invocation edges and ignore disabled items", () => {
  const items = [
    { id: "one", workflow_template_id: "a", position: 0 },
    { id: "off", workflow_template_id: "b", position: 1, enabled: false },
    { id: "two", workflow_template_id: "c", position: 2 },
  ];
  const edges = migratedJobEdges({ id: "job", strategy: "sequential" }, items);
  assert.deepEqual(
    edges.map((e) => [e.fromStepId, e.toStepId]),
    [["one", "two"]],
  );
  assert.deepEqual(
    migratedJobEdges({ id: "job", strategy: "parallel" }, items),
    [],
  );
  assert.deepEqual(
    migratedJobEdges(
      {
        id: "job",
        strategy: "custom",
        executionGraph: {
          edges: [
            { from: "a", to: "c" },
            { from: "b", to: "c" },
          ],
        },
      },
      items,
    ),
    edges,
  );
  assert.throws(
    () =>
      migratedJobEdges(
        {
          id: "job",
          strategy: "custom",
          executionGraph: { edges: [{ from: "a", to: "c" }] },
        },
        [...items, { id: "duplicate", workflow_template_id: "a" }],
      ),
    /ambiguous/,
  );
});

test(
  "cutover drains, preserves history and trigger state, rolls back collisions, and is repeatable",
  { skip: !source },
  async () => {
    await pool.query(`
    CREATE TABLE public.beam_api_keys(id text PRIMARY KEY,name text,base_url text,encrypted_api_key text,created_at timestamptz,updated_at timestamptz);
    INSERT INTO public.beam_api_keys VALUES('key-original','Original key','https://example.invalid','encrypted-fixture',now(),now());
    INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Test');
    INSERT INTO identity.users(id,email,display_name) VALUES('scheduler-user','scheduler@example.invalid','Scheduler');
    INSERT INTO workflow.templates(id,organization_id,name,output_contract_json) VALUES
      ('leaf','org','Leaf','{"schema":{"type":"integer"},"bindings":"invalid"}'),
      ('later','org','Later','{"schema":{"type":"object"},"bindings":{}}');
    INSERT INTO job.definitions(id,organization_id,name,strategy,failure_policy,metadata_json,api_key_id)
      VALUES('job','org','Sequential','sequential','continue_on_failure','{"canvas":{"x":50}}','key-original');
    INSERT INTO job.items(id,job_id,workflow_template_id,position,input_json) VALUES
      ('item-a','job','leaf',0,'{"literal":"\${steps.not_a_binding.outputs}"}'),('item-b','job','later',1,'{}');
    INSERT INTO job.triggers(id,job_id,type,name,enabled,config_json,state_json) VALUES
      ('schedule','job','schedule','Schedule',true,'{"overlapPolicy":"queue_new"}','{"runCount":7,"creditsConsumed":11}'),
      ('disabled','job','manual','Disabled',false,'{}','{"marker":"disabled"}');
    INSERT INTO workflow.triggers(id,workflow_template_id,type,name,enabled,config_json) VALUES
      ('completion','later','completion','After Job',true,'{"sourceKind":"job","sourceId":"job","statuses":["completed"]}');
    INSERT INTO execution.job_runs(id,organization_id,job_id,status,strategy,failure_policy,trigger_id,composition_snapshot_json,error,created_at,completed_at,credit_operation_key)
      VALUES('old-job-run','org','job','failed','sequential','continue_on_failure','schedule',
      '{"job":{"id":"job","name":"Original name"},"items":[{"id":"item-a","original":"untouched"}]}','original error','2025-01-01','2025-01-02','job:original-reservation');
    INSERT INTO execution.job_run_items(id,job_run_id,job_item_id,workflow_template_id,position,status,workflow_run_id,workflow_snapshot_json) VALUES
      ('old-item-run','old-job-run','item-a','leaf',0,'failed','old-child','{"original":"child snapshot"}'),
      ('unstarted-item','old-job-run','item-b','later',1,'pending',NULL,'{"original":"never started"}');
    INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status,job_run_id,job_item_id,template_snapshot_json,resolved_steps_json,input_json,output_json,error)
      VALUES('old-child','org','leaf','failed','old-job-run','old-item-run','{"original":"run snapshot"}','[]','{"value":2}','{}','child error'),
      ('draining','org','later','running',NULL,NULL,'{}','[]','{}','{}',NULL);`);
    await assert.rejects(ensurePostgresMigrations(pool), /cutover required/);
    await prepareWorkflowJobCutoverPg(pool);
    await prepareWorkflowJobCutoverPg(pool);
    await assert.rejects(
      pool.query(
        "INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status) VALUES('blocked','org','leaf','queued')",
      ),
      /launches are paused/,
    );
    await assert.rejects(
      pool.query(
        "UPDATE workflow.templates SET name='blocked' WHERE id='leaf'",
      ),
      /authoring is paused/,
    );
    await assert.rejects(migrateJobsToWorkflowsPg(pool), /backup/);
    const backup = {
      path: "isolated-fixture.dump",
      sha256: "a".repeat(64),
      bytes: 123,
    };
    await assert.rejects(
      recordWorkflowCutoverBackupPg(pool, backup),
      /drained/,
    );
    await pool.query(
      "UPDATE execution.workflow_runs SET status='completed' WHERE id='draining'",
    );
    await recordWorkflowCutoverBackupPg(pool, backup);
    // Deliberately inject a collision as an operator to verify the complete transaction rolls back.
    await pool.query(
      "BEGIN; SELECT set_config('beam.workflow_cutover','operator',true); INSERT INTO workflow.templates(id,organization_id,name) VALUES('job','org','Collision'); COMMIT",
    );
    await assert.rejects(migrateJobsToWorkflowsPg(pool), /collide/);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM job.definitions"))
        .rows[0].n,
      1,
    );
    await pool.query(
      "BEGIN; SELECT set_config('beam.workflow_cutover','operator',true); DELETE FROM workflow.templates WHERE id='job'; COMMIT",
    );
    await assert.rejects(migrateJobsToWorkflowsPg(pool), /vault-enabled/);
    const report = await migrateJobsToWorkflowsPg(pool, {
      wrapLegacyBillingKey(value) {
        assert.equal(value, "encrypted-fixture");
        return "wrapped-fixture";
      },
    });
    assert.deepEqual(report, {
      definitions: 1,
      items: 2,
      triggers: 2,
      runs: 1,
      run_items: 2,
      child_links: 1,
      migratedBillingKeys: 1,
    });
    const migratedKey = (
      await pool.query(`SELECT w.api_key_id,w.migration_source_json,c.organization_id,v.encrypted_payload
      FROM workflow.templates w JOIN secrets.credentials c ON c.id=w.api_key_id JOIN secrets.credential_versions v ON v.credential_id=c.id WHERE w.id='job'`)
    ).rows[0];
    assert.match(migratedKey.api_key_id, /^workflow_key_/);
    assert.equal(migratedKey.organization_id, "org");
    assert.equal(migratedKey.encrypted_payload, "wrapped-fixture");
    assert.equal(migratedKey.migration_source_json.api_key_id, "key-original");
    assert.deepEqual(await migrateJobsToWorkflowsPg(pool), report);
    await ensurePostgresMigrations(pool);
    await ensurePostgresMigrations(pool);
    const old = (
      await pool.query(
        "SELECT * FROM execution.workflow_runs WHERE id='old-job-run'",
      )
    ).rows[0];
    assert.equal(old.historical, true);
    assert.equal(old.output_validation, "historical");
    assert.equal(old.output_json, null);
    assert.equal(
      old.historical_snapshot_json.composition_snapshot_json.items[0].original,
      "untouched",
    );
    assert.equal(
      old.template_snapshot_json.workflowTemplate.name,
      "Original name",
    );
    assert.equal(old.credit_operation_key, "job:original-reservation");
    assert.equal(
      new Date(old.created_at).toISOString(),
      "2025-01-01T00:00:00.000Z",
    );
    const child = (
      await pool.query(
        "SELECT * FROM execution.workflow_runs WHERE id='old-child'",
      )
    ).rows[0];
    assert.equal(child.parent_run_id, "old-job-run");
    assert.equal(child.invoking_step_run_id, "old-item-run");
    assert.deepEqual(child.template_snapshot_json, {
      original: "run snapshot",
    });
    assert.equal(child.historical_snapshot_json.job_item_id, "old-item-run");
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM execution.workflow_step_runs WHERE id='unstarted-item'",
        )
      ).rows[0].status,
      "not_reached",
    );
    assert.equal(
      (await pool.query("SELECT to_regclass('job.definitions') AS name"))
        .rows[0].name,
      null,
    );
    await assert.rejects(
      startWorkflowRunPg(pool, "job"),
      /launches are paused/,
    );
    await resumeWorkflowJobCutoverPg(pool);
    await resumeWorkflowJobCutoverPg(pool);
    assert.deepEqual(
      (await pool.query("SELECT state_json FROM workflow.triggers WHERE id='schedule'")).rows[0].state_json,
      { runCount: 7, creditsConsumed: 11 },
    );
    const options: OrchestratorOptions = {
      authorizeExecution: async () => {},
      batchSize: 100,
      maxAttempts: 3,
      logger: { info() {}, warn() {}, error() {} },
      broker: {
        async publishTask() {
          throw new Error("Composition needs no runner");
        },
      },
    };
    await pool.query(
      "UPDATE workflow.templates SET created_by_id='scheduler-user' WHERE id='job'",
    );
    await pool.query(
      `UPDATE workflow.triggers
       SET config_json = config_json || '{"frequency":"every 30 minutes","nextRunAt":"2026-01-01T00:00:00.000Z"}'::jsonb
       WHERE id='schedule'`,
    );
    await orchestratePg(pool, options);
    const scheduledRun = (
      await pool.query(
        "SELECT id,execution_context_json FROM execution.workflow_runs WHERE trigger_id='schedule' AND trigger='schedule' ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0];
    assert.equal(
      scheduledRun.execution_context_json.initiatingPrincipalId,
      "scheduler-user",
    );
    const triggers = (
      await pool.query(
        "SELECT id,enabled,state_json,config_json FROM workflow.triggers ORDER BY id",
      )
    ).rows;
    assert.equal(triggers.find((t) => t.id === "disabled").enabled, false);
    const scheduleState = triggers.find((t) => t.id === "schedule").state_json;
    assert.equal(scheduleState.runCount, 8);
    assert.equal(scheduleState.creditsConsumed, 11);
    assert.equal(scheduleState.lastWorkflowRunId, scheduledRun.id);
    assert.equal(scheduleState.skippedCount, 0);
    assert.equal(scheduleState.status, "active");
    assert.equal(scheduleState.alertState, null);
    assert.ok(Number.isFinite(Date.parse(scheduleState.lastRunAt)));
    assert.ok(Number.isFinite(Date.parse(scheduleState.lastEvaluatedAt)));
    assert.equal(
      triggers.find((t) => t.id === "completion").config_json.sourceKind,
      "workflow",
    );
    await pool.query("UPDATE workflow.triggers SET enabled=false");
    const id = await startWorkflowRunPg(pool, "job");
    for (let i = 0; i < 12; i++) {
      await orchestratePg(pool, options);
      if (
        (
          await pool.query(
            "SELECT status FROM execution.workflow_runs WHERE id=$1",
            [id],
          )
        ).rows[0].status === "failed"
      )
        break;
    }
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM execution.workflow_runs WHERE id=$1",
          [id],
        )
      ).rows[0].status,
      "failed",
    );
    const children = (
      await pool.query(
        "SELECT workflow_template_id,status FROM execution.workflow_runs WHERE parent_run_id=$1 ORDER BY workflow_template_id",
        [id],
      )
    ).rows;
    const first = (
      await pool.query(
        "SELECT input_json FROM execution.workflow_runs WHERE parent_run_id=$1 AND workflow_template_id='leaf'",
        [id],
      )
    ).rows[0];
    assert.deepEqual(first.input_json, {
      literal: "${steps.not_a_binding.outputs}",
    });
    assert.deepEqual(children, [
      { workflow_template_id: "later", status: "completed" },
      { workflow_template_id: "leaf", status: "failed" },
    ]);
  },
);
