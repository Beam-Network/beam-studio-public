import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "../packages/db/src/index.js";
import { encryptString, decryptString } from "../packages/vault/src/index.js";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
const clients = ["pg_dump", "pg_restore"].every(
  (name) => spawnSync(name, ["--version"]).status === 0,
);
const root = fileURLToPath(new URL("../", import.meta.url));

test(
  "operator CLI archive restores Job history and safely completes a repeatable cutover",
  {
    skip: !source || (!clients && process.env.CI !== "true"),
    timeout: 180_000,
  },
  async () => {
    assert.ok(
      clients,
      "CI must install matching PostgreSQL dump and restore clients",
    );
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const maintenance = createPostgresPool(source!);
    const name = `workflow_cutover_cli_${randomBytes(6).toString("hex")}`;
    const restoreName = `${name}_restore`;
    const directory = await mkdtemp(join(tmpdir(), "beam-cutover-"));
    const archive = join(directory, "before.dump");
    const url = new URL(source!);
    url.pathname = `/${name}`;
    let pool: PgPool | undefined, restored: PgPool | undefined;
    const target = `${url.hostname}:${url.port || "5432"}${url.pathname}`;
    const env = {
      ...process.env,
      DATABASE_URL: url.toString(),
      NODE_OPTIONS: "--conditions=development",
      BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE: "true",
      BEAM_STUDIO_SECRET_KEY: "workflow-cutover-isolated-test-vault-secret",
    };
    const invoke = (
      command: string,
      args: string[] = [],
      expected = target,
    ) => {
      const result = spawnSync(
        process.execPath,
        [
          join(root, "apps/api/node_modules/tsx/dist/cli.mjs"),
          join(root, "packages/db/scripts/workflow-job-cutover.ts"),
          command,
          expected,
          ...args,
        ],
        { env, encoding: "utf8", timeout: 45_000, windowsHide: true },
      );
      assert.equal(result.error, undefined);
      return result;
    };
    const succeed = (command: string, args: string[] = []) => {
      const result = invoke(command, args);
      assert.equal(result.status, 0, result.stderr);
    };
    const snapshot = async (db: PgPool) => {
      const result: Record<string, unknown> = {};
      for (const table of [
        "job.definitions",
        "job.items",
        "job.triggers",
        "workflow.triggers",
        "execution.job_runs",
        "execution.job_run_items",
        "execution.workflow_runs",
      ])
        result[table] = (
          await db.query(
            `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`,
          )
        ).rows;
      return result;
    };
    try {
      await maintenance.query(`CREATE DATABASE ${name}`);
      await maintenance.query(`CREATE DATABASE ${restoreName}`);
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      await pool.query(
        await readFile(
          join(root, "packages/db/src/fixtures/pre-workflow-jobs.sql"),
          "utf8",
        ),
      );
      await pool.query(
        "CREATE TABLE public.beam_api_keys(id text PRIMARY KEY,name text,base_url text,encrypted_api_key text,created_at timestamptz,updated_at timestamptz)",
      );
      await pool.query(
        "INSERT INTO public.beam_api_keys VALUES('original-key','Test key','https://example.invalid',$1,now(),now())",
        [encryptString("isolated-test-api-key", env.BEAM_STUDIO_SECRET_KEY)],
      );
      await pool.query(`
      INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Cutover test');
      INSERT INTO workflow.templates(id,organization_id,name) VALUES('leaf','org','Leaf');
      INSERT INTO job.definitions(id,organization_id,name,strategy,failure_policy,api_key_id) VALUES('job','org','Parent','sequential','continue_on_failure','original-key');
      INSERT INTO job.items(id,job_id,workflow_template_id,position,input_json) VALUES('item','job','leaf',0,'{"literal":"preserved"}');
      INSERT INTO job.triggers(id,job_id,type,name,enabled,config_json,state_json) VALUES
        ('schedule','job','schedule','Scheduled',true,'{"overlapPolicy":"queue_new"}','{"runCount":7}'),
        ('disabled','job','manual','Disabled',false,'{}','{"kept":true}');
      INSERT INTO workflow.triggers(id,workflow_template_id,type,name,enabled,config_json)
        VALUES('completion','leaf','completion','After parent',true,'{"sourceKind":"job","sourceId":"job"}');
      INSERT INTO execution.job_runs(id,organization_id,job_id,status,strategy,failure_policy,trigger_id,composition_snapshot_json,error,created_at,completed_at,credit_operation_key)
        VALUES('history','org','job','failed','sequential','continue_on_failure','schedule','{"job":{"id":"job","name":"Historical name"},"items":[{"id":"item","preserved":true}]}','historical error','2025-01-01','2025-01-02','original-reservation');
      INSERT INTO execution.job_run_items(id,job_run_id,job_item_id,workflow_template_id,position,status,workflow_run_id,workflow_snapshot_json)
        VALUES('history-item','history','item','leaf',0,'failed','history-child','{"source":"original child"}');
      INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status,job_run_id,job_item_id,template_snapshot_json,resolved_steps_json)
        VALUES('history-child','org','leaf','failed','history','history-item','{"source":"original run"}','[]');
    `);
      assert.notEqual(invoke("prepare", [], `${target}-wrong`).status, 0);
      assert.equal(
        (
          await pool.query(
            "SELECT to_regclass('meta.workflow_cutovers') AS table_name",
          )
        ).rows[0].table_name,
        null,
      );
      succeed("prepare");
      succeed("prepare");
      const before = await snapshot(pool);
      assert.notEqual(invoke("migrate").status, 0);
      succeed("backup", [archive]);
      const bytes = await readFile(archive);
      const recorded = (
        await pool.query("SELECT backup_json FROM meta.workflow_cutovers")
      ).rows[0].backup_json;
      assert.equal(
        recorded.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
      assert.equal(recorded.bytes, bytes.length);
      assert.ok(bytes.length > 0);
      if (process.platform !== "win32")
        assert.equal((await stat(archive)).mode & 0o077, 0);
      assert.notEqual(invoke("backup", [archive]).status, 0);
      assert.deepEqual(
        await readFile(archive),
        bytes,
        "repeated backup cannot overwrite the archive",
      );
      const restore = spawnSync(
        "pg_restore",
        [
          "--exit-on-error",
          "--no-owner",
          "--no-privileges",
          "--dbname",
          restoreName,
          archive,
        ],
        {
          env: {
            ...env,
            PGHOST: url.hostname,
            PGPORT: url.port || "5432",
            PGDATABASE: restoreName,
            PGUSER: decodeURIComponent(url.username),
            PGPASSWORD: decodeURIComponent(url.password),
            PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer",
          },
          encoding: "utf8",
          timeout: 45_000,
          windowsHide: true,
        },
      );
      assert.equal(
        restore.status,
        0,
        `pg_restore failed with ${restore.status}`,
      );
      const restoreUrl = new URL(url);
      restoreUrl.pathname = `/${restoreName}`;
      restored = createPostgresPool(restoreUrl.toString());
      assert.deepEqual(await snapshot(restored), before);
      assert.equal(
        (await restored.query("SELECT status FROM meta.workflow_cutovers"))
          .rows[0].status,
        "prepared",
      );
      await assert.rejects(
        restored.query(
          "INSERT INTO execution.job_runs(id,organization_id,job_id,status,strategy,failure_policy) VALUES('blocked','org','job','queued','sequential','stop_on_failure')",
        ),
        /launches are paused/,
      );
      succeed("migrate");
      succeed("migrate");
      await ensurePostgresMigrations(pool);
      await ensurePostgresMigrations(pool);
      assert.equal(
        (
          await pool.query(
            "SELECT to_regclass('job.definitions') AS table_name",
          )
        ).rows[0].table_name,
        null,
      );
      const history = (
        await pool.query(
          "SELECT * FROM execution.workflow_runs WHERE id='history'",
        )
      ).rows[0];
      assert.equal(history.historical, true);
      assert.equal(history.output_validation, "historical");
      assert.equal(history.output_json, null);
      assert.equal(history.error, "historical error");
      assert.equal(history.credit_operation_key, "original-reservation");
      const credential = (
        await pool.query(
          "SELECT v.encrypted_payload,c.organization_id FROM workflow.templates w JOIN secrets.credentials c ON c.id=w.api_key_id JOIN secrets.credential_versions v ON v.credential_id=c.id WHERE w.id='job'",
        )
      ).rows[0];
      assert.equal(credential.organization_id, "org");
      assert.deepEqual(
        JSON.parse(
          decryptString(
            credential.encrypted_payload,
            env.BEAM_STUDIO_SECRET_KEY,
          ),
        ),
        { api_key: "isolated-test-api-key" },
      );
      assert.deepEqual(
        history.historical_snapshot_json,
        (before["execution.job_runs"] as any[])[0].row,
      );
      const child = (
        await pool.query(
          "SELECT * FROM execution.workflow_runs WHERE id='history-child'",
        )
      ).rows[0];
      assert.equal(child.parent_run_id, "history");
      assert.equal(child.invoking_step_run_id, "history-item");
      assert.deepEqual(child.template_snapshot_json, {
        source: "original run",
      });
      await assert.rejects(
        pool.query(
          "INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status) VALUES('blocked','org','job','queued')",
        ),
        /launches are paused/,
      );
      succeed("resume");
      succeed("resume");
      succeed("status");
      const triggers = (
        await pool.query("SELECT * FROM workflow.triggers ORDER BY id")
      ).rows;
      assert.deepEqual(
        triggers.map((row) => [row.id, row.enabled, row.state_json]),
        [
          ["completion", true, {}],
          ["disabled", false, { kept: true }],
          ["schedule", true, { runCount: 7 }],
        ],
      );
      assert.equal(triggers[0].config_json.sourceKind, "workflow");
      assert.equal(triggers[2].config_json.overlapPolicy, "queue_new");
      assert.deepEqual(
        await snapshot(restored),
        before,
        "the independent rollback database remains untouched",
      );
    } finally {
      await pool?.end();
      await restored?.end();
      await maintenance.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await maintenance.query(
        `DROP DATABASE IF EXISTS ${restoreName} WITH (FORCE)`,
      );
      await maintenance.end();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith("beam-cutover-"));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
