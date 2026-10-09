import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { defaultWorkflowContract } from "@beam-studio/core";
import {
  pgMany,
  pgOne,
  withPostgresTransaction,
  type PgClient,
  type PgPool,
} from "./postgres.js";

type Row = Record<string, any>;
const CUTOVER = "workflow-first-v1";
const LOCK = 872048732;
const json = (value: unknown) => JSON.stringify(value);
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const cutoverSchema = `
CREATE SCHEMA IF NOT EXISTS meta;
CREATE TABLE IF NOT EXISTS meta.workflow_cutovers (
  id text PRIMARY KEY, status text NOT NULL CHECK (status IN ('prepared','migrated','resumed')),
  trigger_snapshot_json jsonb NOT NULL, backup_json jsonb, report_json jsonb,
  prepared_at timestamptz NOT NULL DEFAULT now(), migrated_at timestamptz, resumed_at timestamptz
);
CREATE OR REPLACE FUNCTION meta.guard_workflow_root_launch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM meta.workflow_cutovers WHERE id='workflow-first-v1' AND status <> 'resumed')
    AND NULLIF(to_jsonb(NEW)->>'parent_run_id','') IS NULL
    AND NULLIF(to_jsonb(NEW)->>'job_run_id','') IS NULL
    AND (TG_OP='INSERT' OR (OLD.status IN ('completed','failed','cancelled') AND NEW.status IN ('queued','running','cancel_requested'))) THEN
    RAISE EXCEPTION 'Workflow launches are paused for the workflow-first cutover';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION meta.guard_workflow_authoring() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('beam.workflow_cutover',true) IS DISTINCT FROM 'operator'
    AND EXISTS (SELECT 1 FROM meta.workflow_cutovers WHERE id='workflow-first-v1' AND status <> 'resumed') THEN
    RAISE EXCEPTION 'Workflow authoring is paused for the workflow-first cutover';
  END IF;
  RETURN NULL;
END $$;`;

async function lock(client: PgClient) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
  await client.query(cutoverSchema);
  await client.query(
    "SELECT set_config('beam.workflow_cutover','operator',true)",
  );
}

/** Safe to repeat. The launch guard also protects against old API/MCP processes. */
export async function prepareWorkflowJobCutoverPg(pool: PgPool) {
  return withPostgresTransaction(pool, async (client) => {
    await lock(client);
    const existing = await pgOne<Row>(
      client,
      "SELECT * FROM meta.workflow_cutovers WHERE id=$1",
      [CUTOVER],
    );
    if (existing) return existing;
    await client.query(
      `LOCK TABLE execution.workflow_runs, execution.job_runs, workflow.triggers, job.triggers IN SHARE ROW EXCLUSIVE MODE`,
    );
    const triggers = await pgMany<Row>(
      client,
      `
      SELECT 'workflow' AS source, id, enabled, state_json FROM workflow.triggers
      UNION ALL SELECT 'job', id, enabled, state_json FROM job.triggers`,
    );
    await client.query(
      "INSERT INTO meta.workflow_cutovers(id,status,trigger_snapshot_json) VALUES($1,'prepared',$2::jsonb)",
      [CUTOVER, json(triggers)],
    );
    await client.query(`
      UPDATE workflow.triggers SET enabled=false;
      UPDATE job.triggers SET enabled=false;
      CREATE TRIGGER workflow_cutover_launch_guard BEFORE INSERT OR UPDATE OF status ON execution.workflow_runs FOR EACH ROW EXECUTE FUNCTION meta.guard_workflow_root_launch();
      CREATE TRIGGER workflow_cutover_launch_guard BEFORE INSERT OR UPDATE OF status ON execution.job_runs FOR EACH ROW EXECUTE FUNCTION meta.guard_workflow_root_launch();`);
    for (const table of [
      "workflow.templates",
      "workflow.steps",
      "workflow.edges",
      "workflow.triggers",
      "workflow.trigger_edges",
      "workflow.decisions",
      "workflow.decision_edges",
      "workflow.action_locks",
      "workflow.step_credential_bindings",
      "job.definitions",
      "job.items",
      "job.triggers",
    ])
      await client.query(
        `CREATE TRIGGER workflow_cutover_authoring_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION meta.guard_workflow_authoring()`,
      );
    return pgOne<Row>(
      client,
      "SELECT * FROM meta.workflow_cutovers WHERE id=$1",
      [CUTOVER],
    );
  });
}

export async function assertWorkflowCutoverDrainedPg(
  client: PgClient | PgPool,
) {
  const active = await pgOne<Row>(
    client,
    `SELECT
    (SELECT count(*) FROM execution.workflow_runs WHERE status IN ('queued','running','cancel_requested')) +
    (SELECT count(*) FROM execution.job_runs WHERE status IN ('queued','running','cancel_requested')) +
    (SELECT count(*) FROM execution.workflow_tasks WHERE status NOT IN ('completed','failed','cancelled','dead_letter')) +
    (SELECT count(*) FROM studio.room_storage_transfer_jobs WHERE workflow_run_id IS NOT NULL
      AND (status IN ('queued','preparing','running','cancel_requested') OR lease_owner IS NOT NULL)) AS count`,
  );
  if (Number(active?.count))
    throw new Error(
      `Cutover requires drained runs, action tasks and room operations; ${active?.count} active records remain.`,
    );
}

export async function recordWorkflowCutoverBackupPg(
  pool: PgPool,
  backup: { path: string; sha256: string; bytes: number },
) {
  if (
    !backup.path ||
    !/^[a-f0-9]{64}$/.test(backup.sha256) ||
    backup.bytes <= 0
  )
    throw new Error(
      "A completed backup with path, SHA-256 and byte count is required.",
    );
  return withPostgresTransaction(pool, async (client) => {
    await lock(client);
    await assertWorkflowCutoverDrainedPg(client);
    const result = await client.query(
      "UPDATE meta.workflow_cutovers SET backup_json=$2::jsonb WHERE id=$1 AND status='prepared' RETURNING id",
      [CUTOVER, json(backup)],
    );
    if (!result.rowCount)
      throw new Error("Prepare the cutover before recording a backup.");
  });
}

/** Job custom edges identify workflows; workflow edges identify invocation steps. */
export function migratedJobEdges(job: Row, items: Row[]) {
  const enabled = items
    .filter((item) => item.enabled !== false)
    .sort((a, b) => Number(a.position) - Number(b.position));
  const edge = (from: Row, to: Row) => ({
    id: `wfe_${createHash("sha256").update(`${job.id}:${from.id}:${to.id}`).digest("hex")}`,
    fromStepId: String(from.id),
    toStepId: String(to.id),
    condition: null,
  });
  if (job.strategy === "parallel") return [];
  if (job.strategy === "sequential")
    return enabled.slice(1).map((item, i) => edge(enabled[i]!, item));
  const graph = object(
    job.executionGraph ?? object(job.metadata_json).executionGraph,
  );
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const find = (id: string) => {
    const matches = enabled.filter(
      (item) =>
        String(item.workflow_template_id ?? item.workflowTemplateId) === id,
    );
    if (matches.length > 1)
      throw new Error(
        `Job ${job.id} has ambiguous custom dependencies for workflow ${id}.`,
      );
    return matches[0];
  };
  return edges.flatMap((value: Row) => {
    const from = find(String(value.from ?? value.source));
    const to = find(String(value.to ?? value.target));
    return from && to ? [edge(from, to)] : [];
  });
}

function callStep(item: Row) {
  return {
    id: String(item.job_item_id ?? item.id),
    kind: "workflow",
    calledWorkflowId: item.workflow_template_id ?? item.workflowTemplateId,
    position: item.position,
    enabled: item.enabled !== false,
    name: item.name ?? null,
    config: {},
    inputBindings: { $literal: item.input_json ?? item.input ?? {} },
    required: true,
  };
}

/** This is an operator cutover, never an implicit application startup migration. */
export async function migrateJobsToWorkflowsPg(
  pool: PgPool,
  options: {
    wrapLegacyBillingKey?: (encryptedKey: string) => string;
  } = {},
) {
  return withPostgresTransaction(pool, async (client) => {
    await lock(client);
    const state = await pgOne<Row>(
      client,
      "SELECT * FROM meta.workflow_cutovers WHERE id=$1 FOR UPDATE",
      [CUTOVER],
    );
    if (!state)
      throw new Error("Prepare, drain and back up before migrating Jobs.");
    if (state.status !== "prepared") return state.report_json;
    if (!state.backup_json)
      throw new Error("A completed backup must be recorded before migration.");
    await client.query(`LOCK TABLE job.definitions, job.items, job.triggers, execution.job_runs, execution.job_run_items,
      workflow.templates, workflow.steps, workflow.edges, workflow.triggers, execution.workflow_runs, execution.workflow_step_runs IN ACCESS EXCLUSIVE MODE`);
    await assertWorkflowCutoverDrainedPg(client);
    // Existing installations have not necessarily deployed the additive composition schema.
    await client.query(
      readFileSync(
        new URL(
          "./postgres-migrations/0022_workflow_composition.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await client.query(
      readFileSync(
        new URL(
          "./postgres-migrations/0023_workflow_history.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const jobs = await pgMany<Row>(
      client,
      "SELECT * FROM job.definitions ORDER BY id",
    );
    const items = await pgMany<Row>(
      client,
      "SELECT * FROM job.items ORDER BY job_id,position",
    );
    const runs = await pgMany<Row>(
      client,
      "SELECT * FROM execution.job_runs ORDER BY id",
    );
    const runItems = await pgMany<Row>(
      client,
      "SELECT * FROM execution.job_run_items ORDER BY job_run_id,position",
    );
    const collisions = await pgOne<Row>(
      client,
      `SELECT
      (SELECT count(*) FROM job.definitions j JOIN workflow.templates w ON w.id=j.id) +
      (SELECT count(*) FROM job.items j JOIN workflow.steps w ON w.id=j.id) +
      (SELECT count(*) FROM job.triggers j JOIN workflow.triggers w ON w.id=j.id) +
      (SELECT count(*) FROM execution.job_runs j JOIN execution.workflow_runs w ON w.id=j.id) +
      (SELECT count(*) FROM execution.job_run_items j JOIN execution.workflow_step_runs w ON w.id=j.id) AS count`,
    );
    if (Number(collisions?.count))
      throw new Error(
        "Job IDs collide with workflow IDs; cutover rolled back without overwriting history.",
      );
    const invalidLinks = await pgOne<Row>(
      client,
      `SELECT count(*) AS count FROM execution.job_run_items i
      JOIN execution.job_runs j ON j.id=i.job_run_id
      LEFT JOIN execution.workflow_runs r ON r.id=i.workflow_run_id
      WHERE i.workflow_run_id IS NOT NULL AND (r.id IS NULL OR r.organization_id<>j.organization_id
        OR r.workflow_template_id<>i.workflow_template_id OR r.job_run_id IS DISTINCT FROM j.id OR r.job_item_id IS DISTINCT FROM i.id)`,
    );
    if (Number(invalidLinks?.count))
      throw new Error(
        "Job child-run relationships are inconsistent; repair them before cutover.",
      );
    const orphanLinks = await pgOne<Row>(
      client,
      `SELECT count(*) AS count FROM execution.workflow_runs r
      LEFT JOIN execution.job_run_items i ON i.workflow_run_id=r.id
      WHERE (r.job_run_id IS NOT NULL OR r.job_item_id IS NOT NULL) AND i.id IS NULL`,
    );
    if (Number(orphanLinks?.count))
      throw new Error(
        "Workflow history has orphaned Job links; cutover rolled back.",
      );
    const crossOrg = await pgOne<Row>(
      client,
      `SELECT count(*) AS count FROM job.items i JOIN job.definitions j ON j.id=i.job_id
      JOIN workflow.templates w ON w.id=i.workflow_template_id WHERE j.organization_id<>w.organization_id`,
    );
    if (Number(crossOrg?.count))
      throw new Error("Job composition crosses organization boundaries.");

    await client.query(`
      INSERT INTO workflow.templates(id,organization_id,project_id,name,description,status,config_json,enabled,api_key_id,created_at,updated_at,migration_source_json)
      SELECT id,organization_id,project_id,name,description,'active',jsonb_build_object('failurePolicy',failure_policy),enabled,api_key_id,created_at,updated_at,to_jsonb(j) FROM job.definitions j;
      INSERT INTO workflow.steps(id,workflow_template_id,kind,called_workflow_id,action_package_name,position,enabled,input_bindings_json,created_at,updated_at)
      SELECT id,job_id,'workflow',workflow_template_id,NULL,position,enabled,jsonb_build_object('$literal',input_json),created_at,updated_at FROM job.items;
      INSERT INTO workflow.triggers(id,workflow_template_id,type,name,enabled,config_json,state_json,created_at,updated_at)
      SELECT id,job_id,type,name,false,config_json,state_json,created_at,updated_at FROM job.triggers;
      UPDATE workflow.triggers SET config_json=jsonb_set(config_json,'{sourceKind}','"workflow"'::jsonb)
      WHERE type='completion' AND config_json->>'sourceKind'='job';`);
    for (const job of jobs) {
      for (const edge of migratedJobEdges(
        job,
        items.filter((item) => item.job_id === job.id),
      ))
        await client.query(
          "INSERT INTO workflow.edges(id,workflow_template_id,from_step_id,to_step_id) VALUES($1,$2,$3,$4)",
          [edge.id, job.id, edge.fromStepId, edge.toStepId],
        );
    }
    // Preserve originals before changing relationship columns. No historical output is revalidated.
    await client.query(`ALTER TABLE execution.workflow_runs DISABLE TRIGGER immutable_workflow_run;
      UPDATE execution.workflow_runs r SET historical=true,historical_snapshot_json=to_jsonb(r),output_validation='historical'
        WHERE NOT historical;
      ALTER TABLE execution.workflow_runs DISABLE TRIGGER workflow_cutover_launch_guard;`);
    for (const run of runs) {
      const original = object(run.composition_snapshot_json);
      const definition = object(original.job);
      const historicalItems = runItems.filter(
        (item) => item.job_run_id === run.id,
      );
      const steps = historicalItems.map(callStep);
      const template = {
        ...definition,
        id: run.job_id,
        config: {
          ...object(definition.config),
          failurePolicy: run.failure_policy,
        },
      };
      const snapshot = {
        workflowTemplate: template,
        contract: defaultWorkflowContract,
        graphVersion: "workflow-graph/v1",
        steps,
        edges: migratedJobEdges(
          {
            ...definition,
            id: run.job_id,
            strategy: run.strategy,
            executionGraph:
              original.executionGraph ?? definition.executionGraph,
          },
          historicalItems.map((item) => ({ ...item, id: item.job_item_id })),
        ),
        triggers: [],
        triggerEdges: [],
        decisions: [],
        decisionEdges: [],
      };
      await client.query(
        `INSERT INTO execution.workflow_runs(id,organization_id,project_id,workflow_template_id,status,trigger,trigger_id,trigger_type,
        trigger_event_json,input_json,output_json,metadata_json,template_snapshot_json,resolved_steps_json,error,
        queued_at,started_at,completed_at,created_at,updated_at,credit_operation_key,credit_settled_at,
        historical,historical_snapshot_json,output_validation,root_run_id)
        SELECT id,organization_id,(SELECT project_id FROM workflow.templates WHERE id=j.job_id),job_id,status,trigger,trigger_id,trigger,
          trigger_event_json,'{}'::jsonb,'null'::jsonb,metadata_json,$2::jsonb,$3::jsonb,error,
          queued_at,started_at,completed_at,created_at,updated_at,credit_operation_key,credit_settled_at,true,to_jsonb(j),'historical',id
        FROM execution.job_runs j WHERE id=$1`,
        [run.id, json(snapshot), json(steps)],
      );
    }
    await client.query(`INSERT INTO execution.workflow_step_runs(id,workflow_run_id,workflow_step_id,kind,child_run_id,action_package_name,
        resolved_version,checksum,source_registry,resolved_placement,status,input_json,output_json,metadata_json,error,started_at,completed_at,created_at,updated_at)
      SELECT id,job_run_id,job_item_id,'workflow',workflow_run_id,NULL,'historical','','workflow','dispatcher',
        CASE WHEN status='pending' THEN 'not_reached' ELSE status END,input_json,'null'::jsonb,
        jsonb_build_object('historical',true,'originalJobItem',to_jsonb(i),'invocation',jsonb_build_object('childRunId',workflow_run_id,'status',status,'error',error)),
        error,started_at,completed_at,created_at,updated_at FROM execution.job_run_items i;
      UPDATE execution.workflow_runs r SET parent_run_id=i.job_run_id,root_run_id=i.job_run_id,invoking_step_run_id=i.id,invocation_attempt=1
        FROM execution.job_run_items i WHERE r.id=i.workflow_run_id;
      SET CONSTRAINTS ALL IMMEDIATE;
      ALTER TABLE execution.workflow_runs ENABLE TRIGGER immutable_workflow_run;
      ALTER TABLE execution.workflow_runs ENABLE TRIGGER workflow_cutover_launch_guard;`);
    const verification = await pgOne<Row>(
      client,
      `SELECT
      (SELECT count(*) FROM job.definitions j JOIN workflow.templates w ON w.id=j.id WHERE w.migration_source_json=to_jsonb(j)) AS definitions,
      (SELECT count(*) FROM job.items j JOIN workflow.steps s ON s.id=j.id WHERE s.kind='workflow' AND s.called_workflow_id=j.workflow_template_id AND s.input_bindings_json=jsonb_build_object('$literal',j.input_json)) AS items,
      (SELECT count(*) FROM job.triggers j JOIN workflow.triggers t ON t.id=j.id WHERE t.state_json=j.state_json AND t.config_json=CASE WHEN j.type='completion' AND j.config_json->>'sourceKind'='job' THEN jsonb_set(j.config_json,'{sourceKind}','"workflow"'::jsonb) ELSE j.config_json END) AS triggers,
      (SELECT count(*) FROM execution.job_runs j JOIN execution.workflow_runs w ON w.id=j.id WHERE w.historical_snapshot_json=to_jsonb(j) AND w.historical) AS runs,
      (SELECT count(*) FROM execution.job_run_items j JOIN execution.workflow_step_runs s ON s.id=j.id WHERE s.metadata_json->'originalJobItem'=to_jsonb(j) AND s.child_run_id IS NOT DISTINCT FROM j.workflow_run_id) AS run_items,
      (SELECT count(*) FROM execution.job_run_items j JOIN execution.workflow_runs w ON w.id=j.workflow_run_id WHERE w.parent_run_id=j.job_run_id AND w.invoking_step_run_id=j.id) AS child_links,
      (SELECT count(*) FROM job.triggers) AS expected_triggers`,
    );
    const expected = {
      definitions: jobs.length,
      items: items.length,
      triggers: Number(verification?.expected_triggers),
      runs: runs.length,
      run_items: runItems.length,
      child_links: runItems.filter((item) => item.workflow_run_id).length,
    };
    for (const [key, count] of Object.entries(expected))
      if (Number(verification?.[key]) !== count)
        throw new Error(
          `Cutover integrity check failed for ${key}; all changes rolled back.`,
        );
    const migratedBillingKeys = await migrateWorkflowBillingKeys(
      client,
      options.wrapLegacyBillingKey,
    );
    await client.query(`ALTER TABLE execution.workflow_runs DROP COLUMN job_run_id, DROP COLUMN job_item_id;
      DROP TABLE execution.job_run_items;
      DROP TABLE execution.job_runs;
      DROP TABLE job.triggers;
      DROP TABLE job.items;
      DROP TABLE job.definitions;
      DROP SCHEMA job;`);
    for (const table of [
      "workflow.templates",
      "workflow.steps",
      "workflow.edges",
      "workflow.triggers",
      "workflow.trigger_edges",
      "workflow.decisions",
      "workflow.decision_edges",
      "workflow.action_locks",
      "workflow.step_credential_bindings",
    ])
      await client.query(
        `DROP TRIGGER workflow_cutover_authoring_guard ON ${table}`,
      );
    await client.query(
      "UPDATE meta.workflow_cutovers SET status='migrated',migrated_at=now(),report_json=$2::jsonb WHERE id=$1",
      [CUTOVER, json({ ...expected, migratedBillingKeys })],
    );
    return { ...expected, migratedBillingKeys };
  });
}

/** One-time conversion of unscoped key storage; execution uses only scoped credentials. */
async function migrateWorkflowBillingKeys(
  client: PgClient,
  wrap?: (encryptedKey: string) => string,
) {
  const legacy = await pgOne<Row>(
    client,
    "SELECT to_regclass('public.beam_api_keys') AS table_name",
  );
  if (!legacy?.table_name) return 0;
  const keys = await pgMany<Row>(
    client,
    `SELECT DISTINCT w.organization_id,k.* FROM workflow.templates w
    JOIN public.beam_api_keys k ON k.id=w.api_key_id
    WHERE NOT EXISTS(SELECT 1 FROM secrets.credentials c WHERE c.id=w.api_key_id AND c.organization_id=w.organization_id)
    ORDER BY w.organization_id,k.id`,
  );
  if (keys.length && !wrap)
    throw new Error(
      "Legacy workflow billing keys require the vault-enabled cutover CLI; migration was rolled back.",
    );
  if (keys.length)
    await client.query(`INSERT INTO secrets.credential_types(id,slug,display_name,secret_schema_json)
    VALUES('beam_api_key','beam_api_key','Beam API key','{"type":"object","required":["api_key"],"properties":{"api_key":{"type":"string"}}}') ON CONFLICT(slug) DO NOTHING`);
  for (const key of keys) {
    const id = `workflow_key_${createHash("sha256")
      .update(JSON.stringify([key.organization_id, key.id]))
      .digest("hex")
      .slice(0, 32)}`;
    await client.query(
      `INSERT INTO secrets.credentials(id,organization_id,credential_type_id,name,metadata_json,created_at,updated_at)
      SELECT $1,$2,id,$3,$4::jsonb,$5,$6 FROM secrets.credential_types WHERE slug='beam_api_key'`,
      [
        id,
        key.organization_id,
        key.name,
        json({ baseUrl: key.base_url, migratedBillingKeyId: key.id }),
        key.created_at,
        key.updated_at,
      ],
    );
    await client.query(
      `INSERT INTO secrets.credential_versions(id,credential_id,version,encrypted_payload,encryption_key_id)
      VALUES($1,$2,1,$3,'env:BEAM_STUDIO_SECRET_KEY')`,
      [`${id}_v1`, id, wrap!(String(key.encrypted_api_key))],
    );
    await client.query(
      "UPDATE workflow.templates SET api_key_id=$3 WHERE organization_id=$1 AND api_key_id=$2",
      [key.organization_id, key.id, id],
    );
  }
  return keys.length;
}

export async function resumeWorkflowJobCutoverPg(pool: PgPool) {
  return withPostgresTransaction(pool, async (client) => {
    await lock(client);
    const state = await pgOne<Row>(
      client,
      "SELECT * FROM meta.workflow_cutovers WHERE id=$1 FOR UPDATE",
      [CUTOVER],
    );
    if (state?.status === "resumed") return state.report_json;
    if (state?.status !== "migrated")
      throw new Error(
        "Verify the completed migration before resuming launches.",
      );
    for (const trigger of state.trigger_snapshot_json as Row[])
      if (
        !(
          await client.query(
            "UPDATE workflow.triggers SET enabled=$2,state_json=$3::jsonb WHERE id=$1 RETURNING id",
            [trigger.id, trigger.enabled, json(trigger.state_json)],
          )
        ).rowCount
      )
        throw new Error(
          `Preserved trigger ${trigger.id} is missing; launches remain paused.`,
        );
    await client.query(
      "UPDATE meta.workflow_cutovers SET status='resumed',resumed_at=now() WHERE id=$1",
      [CUTOVER],
    );
    return state.report_json;
  });
}
