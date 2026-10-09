import assert from "node:assert/strict";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";

export const testDatabaseUrl =
  process.env.G7_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;

export async function seedDynamicRun(pool: PgPool, fixtureKey?: string) {
  await pool.query(
    `INSERT INTO identity.organizations (id, slug, name)
     VALUES ('org_g7_api', 'org-g7-api', 'G7 API')`,
  );
  await pool.query(
    `INSERT INTO workflow.templates (id, organization_id, name, graph_version)
     VALUES ('wft_g7_api', 'org_g7_api', 'G7 API', 'workflow-graph/v2')`,
  );
  await pool.query(
    `INSERT INTO workflow.steps (
       id, workflow_template_id, action_package_name, action_version_range, position
     ) VALUES ('wait_api', 'wft_g7_api', '@beam/wait', '1.0.0', 0)`,
  );
  for (const runId of ["wfr_retry", "wfr_cancel"]) {
    await pool.query(
      `INSERT INTO execution.workflow_runs (
         id, organization_id, workflow_template_id, status, trigger, template_snapshot_json
       ) VALUES ($1, 'org_g7_api', 'wft_g7_api', $2, 'test', $3::jsonb)`,
      [
        runId,
        runId === "wfr_retry" ? "failed" : "running",
        JSON.stringify(
          fixtureKey ? { steps: [{ config: { objectKey: fixtureKey } }] } : {},
        ),
      ],
    );
  }
  await pool.query(
    `INSERT INTO execution.workflow_dynamic_regions (
       id, workflow_run_id, control_id, control_path, kind, status,
       instance_count, completed_count, failed_count, concurrency_limit
     ) VALUES
       ('region_retry', 'wfr_retry', 'parallel_retry', 'parallel_retry', 'fan-out', 'failed', 3, 2, 1, 2),
       ('region_cancel', 'wfr_cancel', 'parallel_cancel', 'parallel_cancel', 'fan-out', 'running', 2, 0, 0, 2),
       ('region_unrelated', 'wfr_cancel', 'parallel_unrelated', 'parallel_unrelated', 'fan-out', 'running', 1, 0, 0, 1)`,
  );
  await pool.query(
    `INSERT INTO execution.workflow_dynamic_instances (
       id, workflow_run_id, dynamic_region_id, workflow_step_id, control_path,
       instance_index, status, current_attempt, output_json
     ) VALUES
       ('dyn_retry_0', 'wfr_retry', 'region_retry', 'wait_api', 'parallel_retry', 0, 'completed', 1, '{"value":0}'::jsonb),
       ('dyn_retry_1', 'wfr_retry', 'region_retry', 'wait_api', 'parallel_retry', 1, 'failed', 1, '{}'::jsonb),
       ('dyn_retry_2', 'wfr_retry', 'region_retry', 'wait_api', 'parallel_retry', 2, 'completed', 1, '{"value":2}'::jsonb),
       ('dyn_cancel_0', 'wfr_cancel', 'region_cancel', 'wait_api', 'parallel_cancel', 0, 'running', 1, '{}'::jsonb),
       ('dyn_cancel_1', 'wfr_cancel', 'region_cancel', 'wait_api', 'parallel_cancel', 1, 'pending', 1, '{}'::jsonb),
       ('dyn_unrelated', 'wfr_cancel', 'region_unrelated', 'wait_api', 'parallel_unrelated', 0, 'pending', 1, '{}'::jsonb)`,
  );
  for (const [index, status] of [
    [0, "completed"],
    [1, "failed"],
    [2, "completed"],
  ] as const) {
    await insertStepRunAndTask(pool, {
      dynamicInstanceId: `dyn_retry_${index}`,
      runId: "wfr_retry",
      stepRunId: `wsr_retry_${index}`,
      taskId: `task_retry_${index}`,
      status,
    });
  }
  await insertStepRunAndTask(pool, {
    dynamicInstanceId: "dyn_cancel_0",
    runId: "wfr_cancel",
    stepRunId: "wsr_cancel_0",
    taskId: "task_cancel_0",
    status: "running",
  });
}

async function insertStepRunAndTask(
  pool: PgPool,
  input: {
    dynamicInstanceId: string;
    runId: string;
    stepRunId: string;
    taskId: string;
    status: string;
  },
) {
  await pool.query(
    `INSERT INTO execution.workflow_step_runs (
       id, workflow_run_id, workflow_step_id, dynamic_instance_id,
       action_package_name, resolved_version, checksum, source_registry,
       resolved_placement, status, attempt
     ) VALUES ($1, $2, 'wait_api', $3, '@beam/wait', '1.0.0',
       'wait-checksum', 'registry', 'local-workers', $4, 1)`,
    [input.stepRunId, input.runId, input.dynamicInstanceId, input.status],
  );
  await pool.query(
    `INSERT INTO execution.workflow_tasks (
       id, organization_id, workflow_run_id, workflow_step_run_id,
       workflow_step_id, task_kind, action_package_name, status,
       input_checksum, idempotency_key
     ) VALUES ($1, 'org_g7_api', $2, $3, 'wait_api', 'wait', '@beam/wait',
       $4, 'wait-input', $5)`,
    [
      input.taskId,
      input.runId,
      input.stepRunId,
      input.status,
      `${input.stepRunId}:wait`,
    ],
  );
}

export async function withIsolatedStore(
  callback: (pool: PgPool, store: typeof import("./store.js")) => Promise<void>,
) {
  assert.ok(testDatabaseUrl);
  const priorUrl = process.env.DATABASE_URL;
  const priorAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  const source = new URL(testDatabaseUrl);
  const databaseName = `beam_g7_api_${process.pid}_${Date.now()}`;
  const maintenanceUrl = new URL(source);
  maintenanceUrl.pathname = "/postgres";
  const admin = createPostgresPool(maintenanceUrl.toString());
  let pool: PgPool | null = null;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const isolatedUrl = new URL(source);
    isolatedUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = isolatedUrl.toString();
    pool = createPostgresPool(isolatedUrl.toString());
    await ensurePostgresMigrations(pool);
    const store = await import("./store.js");
    await callback(pool, store);
  } finally {
    const globalStore = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
    };
    await globalStore.__beamStudioPgPool?.end().catch(() => {});
    delete globalStore.__beamStudioPgPool;
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
    if (priorUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorUrl;
    if (priorAllow === undefined) {
      delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    } else {
      process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = priorAllow;
    }
  }
}
