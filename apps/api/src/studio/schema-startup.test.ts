import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { applyTargetSchema } from "../../../../packages/db/src/target-schema-application.mjs";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres"))
  throw new Error(
    "Schema startup acceptance requires isolated PostgreSQL in CI.",
  );

test(
  "schema startup serializes concurrent callers and rolls back/retries real lock contention",
  {
    skip: !source?.startsWith("postgres"),
    timeout: 90_000,
  },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `schema_startup_${randomBytes(6).toString("hex")}`;
    let pool: PgPool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      pool = createPostgresPool(url.toString());
      await Promise.all([
        ensurePostgresMigrations(pool),
        ensurePostgresMigrations(pool),
      ]);
      const migration = await pool.connect();
      const reader = await pool.connect();
      try {
        await pool.query(
          "CREATE TABLE public.lock_a(id int); CREATE TABLE public.lock_b(id int)",
        );
        const ddl =
          "ALTER TABLE public.lock_a ADD COLUMN recovered int; SELECT pg_sleep(0.2); ALTER TABLE public.lock_b ADD COLUMN recovered int";
        await migration.query("SET deadlock_timeout='50ms'");
        await reader.query(
          "SET deadlock_timeout='5s'; BEGIN; LOCK TABLE public.lock_b IN ACCESS SHARE MODE",
        );
        const retried: string[] = [];
        const applying = applyTargetSchema(migration, ddl, {
          onRetry: async ({ code }) => {
            retried.push(code);
            await reader.query("ROLLBACK");
          },
        });
        // Wait for the DDL lock, then reproduce the AccessExclusive/AccessShare cycle.
        let locked = false;
        for (let i = 0; i < 100; i++) {
          const locks = await pool.query(
            "SELECT 1 FROM pg_locks WHERE relation='public.lock_a'::regclass AND mode='AccessExclusiveLock' AND granted",
          );
          if (locks.rowCount) {
            locked = true;
            break;
          }
          await delay(10);
        }
        assert.equal(locked, true);
        const reading = reader.query("SELECT * FROM public.lock_a");
        await Promise.all([applying, reading]);
        assert.deepEqual(retried, ["40P01"]);
        const columns = await pool.query(
          "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='recovered' ORDER BY table_name",
        );
        assert.deepEqual(
          columns.rows.map((row) => row.table_name),
          ["lock_a", "lock_b"],
        );

        await assert.rejects(
          applyTargetSchema(
            migration,
            "CREATE TABLE public.must_rollback(id int); SELECT * FROM public.missing_relation",
          ),
          { code: "42P01" },
        );
        assert.equal(
          (
            await pool.query(
              "SELECT to_regclass('public.must_rollback') AS name",
            )
          ).rows[0].name,
          null,
        );

        await reader.query(
          "BEGIN; LOCK TABLE public.lock_b IN ACCESS SHARE MODE",
        );
        const blockedDdl =
          "CREATE TABLE public.transient_rollback(id int); ALTER TABLE public.lock_b ADD COLUMN extra int";
        await assert.rejects(
          applyTargetSchema(migration, blockedDdl, {
            maxAttempts: 2,
            lockTimeoutMs: 40,
          }),
          /exhausted 2 attempts.*55P03/,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT to_regclass('public.transient_rollback') AS name",
            )
          ).rows[0].name,
          null,
        );
        await reader.query("ROLLBACK");
        await applyTargetSchema(migration, blockedDdl);
        assert.ok(
          (
            await pool.query(
              "SELECT to_regclass('public.transient_rollback') AS name",
            )
          ).rows[0].name,
        );
        assert.equal(
          (await migration.query("SHOW lock_timeout")).rows[0].lock_timeout,
          "0",
        );
      } finally {
        await reader.query("ROLLBACK");
        reader.release();
        migration.release();
      }
    } finally {
      if (pool) await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      if (previousAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previousAllow;
    }
  },
);

test(
  "schema startup and migration 0038 remove retired transfer step options",
  {
    skip: !source?.startsWith("postgres"),
    timeout: 90_000,
  },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `schema_step_cleanup_${randomBytes(6).toString("hex")}`;
    let pool: PgPool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      pool = createPostgresPool(url.toString());
      // The retired step key and legacy column are read from the migration,
      // so this test checks exactly what it removes.
      const migration = await migrationSql(
        "0038_transfer_step_config_cleanup.sql",
      );
      const retiredKey = /config_json - '(\w+)'/.exec(migration)?.[1];
      const retiredColumn = /DROP COLUMN IF EXISTS (\w+)/.exec(migration)?.[1];
      assert.ok(retiredKey && retiredColumn);
      await ensurePostgresMigrations(pool);
      // An upgraded installation: the legacy transfer table and Beam Transfer
      // steps that still carry the retired key.
      await pool.query(await migrationSql("0008_legacy_product_state.sql"));
      await pool.query(`
        INSERT INTO identity.organizations(id, slug, name)
          VALUES ('org_rs', 'org-rs', 'Org RS');
        INSERT INTO workflow.templates(id, organization_id, name)
          VALUES ('wft_rs', 'org_rs', 'Transfer');
      `);
      await pool.query(
        `INSERT INTO workflow.steps(id, workflow_template_id, action_package_name, position, config_json)
          VALUES
            ('wfs_a', 'wft_rs', '@beam/transfer', 0, jsonb_build_object('credentialId', 'cred_a', $1::text, false)),
            ('wfs_b', 'wft_rs', '@beam/transfer', 1, jsonb_build_object('credentialId', 'cred_b', $1::text, true, 'distribute', false)),
            ('wfs_other', 'wft_rs', '@acme/other', 2, jsonb_build_object($1::text, true))`,
        [retiredKey],
      );
      const configs = async () =>
        Object.fromEntries(
          (
            await pool!.query<{ id: string; config_json: unknown }>(
              "SELECT id, config_json FROM workflow.steps WHERE workflow_template_id='wft_rs'",
            )
          ).rows.map((row) => [row.id, row.config_json]),
        );
      const retiredColumns = async () =>
        (
          await pool!.query(
            "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='transfer_templates' AND column_name=$1",
            [retiredColumn],
          )
        ).rowCount;
      const expected = {
        wfs_a: { credentialId: "cred_a" },
        wfs_b: { credentialId: "cred_b", distribute: false },
        wfs_other: { [retiredKey]: true },
      };
      assert.equal(await retiredColumns(), 1);

      // The numbered chain, applied twice.
      await pool.query(migration);
      await pool.query(migration);
      assert.deepEqual(await configs(), expected);
      assert.equal(await retiredColumns(), 0);

      // The startup schema reaches the same state from the pre-upgrade one.
      await pool.query(
        `ALTER TABLE public.transfer_templates ADD COLUMN ${retiredColumn} integer NOT NULL DEFAULT 0`,
      );
      await pool.query(
        `UPDATE workflow.steps SET config_json = config_json || jsonb_build_object($1::text, false)
          WHERE id IN ('wfs_a','wfs_b')`,
        [retiredKey],
      );
      await ensurePostgresMigrations(pool);
      await ensurePostgresMigrations(pool);
      assert.deepEqual(await configs(), expected);
      assert.equal(await retiredColumns(), 0);
    } finally {
      if (pool) await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      if (previousAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previousAllow;
    }
  },
);

function migrationSql(name: string) {
  return readFile(
    new URL(
      `../../../../packages/db/src/postgres-migrations/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
}
