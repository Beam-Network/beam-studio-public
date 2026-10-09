import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { WorkflowReadRepository } from "./repositories/workflow-read-repository.js";
import { organizationScope } from "./repositories/organization-scope.js";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres")) {
  throw new Error(
    "Workflow read acceptance requires isolated PostgreSQL in CI.",
  );
}

test(
  "workflow navigation is read-only, scoped and excludes large immutable run payloads",
  { skip: !source?.startsWith("postgres") },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const previousUrl = process.env.DATABASE_URL;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `workflow_reads_${randomBytes(6).toString("hex")}`;
    const globals = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
    };
    const previousPool = globals.__beamStudioPgPool;
    let pool: PgPool | undefined;
    let readPool: PgPool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      globals.__beamStudioPgPool = pool;
      const store = await import("./store.js");
      const first = await store.createWorkflowTemplate({
        organizationId: "read_org_a",
        name: "Visible workflow",
      });
      const second = await store.createWorkflowTemplate({
        organizationId: "read_org_b",
        name: "Private workflow",
      });
      const huge = JSON.stringify({
        retained: "historical-payload-".repeat(100_000),
      });
      for (const [id, org, template] of [
        ["read_run_a", "read_org_a", first],
        ["read_run_b", "read_org_b", second],
      ]) {
        await pool.query(
          `INSERT INTO execution.workflow_runs
        (id, organization_id, workflow_template_id, status, historical, historical_snapshot_json,
         template_snapshot_json, resolved_steps_json, output_json, output_validation)
        VALUES ($1,$2,$3,'completed',true,$4::jsonb,'{}','[]','{"answer":42}','historical')`,
          [id, org, template, huge],
        );
      }
      // PostgreSQL itself enforces that GET helpers cannot seed or update catalog rows.
      url.searchParams.set("options", "-c default_transaction_read_only=on");
      readPool = createPostgresPool(url.toString());
      globals.__beamStudioPgPool = readPool;
      const [catalog, registry, bundle, runs] = await Promise.all([
        store.listActionPackages(),
        store.listRegistryPackages(),
        store.getWorkflowTemplate(first, "read_org_a"),
        store.listWorkflowRuns({ organizationId: "read_org_a" }),
      ]);
      assert.ok(catalog.length > 0);
      assert.ok(registry);
      assert.equal(bundle?.runCount, 1);
      assert.equal(
        Object.hasOwn(bundle!, "runs"),
        false,
        "definitions do not embed history",
      );
      assert.deepEqual(
        runs.map((run) => run.id),
        ["read_run_a"],
      );
      assert.equal(runs[0]?.historical, true);
      for (const field of [
        "historicalSnapshot",
        "output",
        "triggerEvent",
        "templateSnapshot",
        "resolvedSteps",
      ]) {
        assert.equal(
          Object.hasOwn(runs[0]!, field),
          false,
          `${field} is not navigation data`,
        );
      }
      assert.ok(JSON.stringify(bundle).length < 20_000);
      const history = await store.getWorkflowRun("read_run_a", "read_org_a");
      assert.equal(
        history?.run.historicalSnapshot?.retained,
        JSON.parse(huge).retained,
      );
      assert.equal(
        await store.getWorkflowRun("read_run_a", "read_org_b"),
        null,
      );
      assert.equal(await store.getWorkflowTemplate(first, "read_org_b"), null);
      await assert.rejects(
        store.listWorkflowRuns({ organizationId: "" }),
        /organization is required/i,
      );

      // Equal timestamps exercise the ID tie-breaker; inserting a newer run between
      // pages must not duplicate or displace entries in the cursor's older history.
      await pool.query(
        `INSERT INTO execution.workflow_runs
      (id,organization_id,workflow_template_id,status,created_at)
      SELECT 'page_' || lpad(i::text,3,'0'),'read_org_a',$1,
        CASE WHEN i % 2 = 0 THEN 'failed' ELSE 'completed' END,'2026-08-01T00:00:00Z'
      FROM generate_series(0,104) i`,
        [first],
      );
      const reads = new WorkflowReadRepository(readPool);
      const scope = organizationScope("read_org_a");
      const firstPage = await reads.runsPage(scope, {
        workflowTemplateId: first,
      });
      assert.equal(firstPage.runs.length, 50);
      assert.equal(firstPage.totalCount, 106);
      assert.ok(firstPage.nextCursor);
      await pool.query(
        `INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status)
      VALUES ('newest','read_org_a',$1,'queued')`,
        [first],
      );
      const seen = firstPage.runs.map((run) => run.id);
      let cursor: string | null = firstPage.nextCursor;
      while (cursor) {
        const page = await reads.runsPage(scope, {
          workflowTemplateId: first,
          cursor,
        });
        assert.equal(page.totalCount, 107);
        seen.push(...page.runs.map((run) => run.id));
        cursor = page.nextCursor;
      }
      assert.equal(seen.length, 106);
      assert.equal(new Set(seen).size, 106);
      assert.equal(seen.includes("newest"), false);
      assert.equal(
        (await reads.runsPage(scope, { limit: 999 })).runs.length,
        100,
      );
      assert.equal(
        (await reads.runsPage(scope, { view: "dead-letter" })).totalCount,
        53,
      );
      assert.equal(
        (
          await reads.runsPage(scope, {
            status: "completed",
            search: "Visible workflow",
          })
        ).totalCount,
        53,
      );
      assert.equal(
        (await reads.runsPage(scope, { view: "queue" })).totalCount,
        1,
      );
      assert.equal(
        (await reads.runsPage(scope, { search: "' OR 1=1" })).totalCount,
        0,
      );
      assert.equal(
        (await reads.runsPage(scope, { projectId: "other-project" }))
          .totalCount,
        0,
      );
      assert.equal(
        (await reads.runsPage(scope, { workflowTemplateId: second }))
          .totalCount,
        0,
      );
      assert.equal(
        (await reads.runsPage(scope, { from: "2026-08-01", to: "2026-08-02" }))
          .totalCount,
        105,
      );
      await assert.rejects(
        reads.runsPage(scope, { cursor: "invalid" }),
        /Invalid run page cursor/,
      );
      const workflows = await reads.listWorkflows(scope);
      assert.equal(workflows.length, 1);
      assert.equal(workflows[0]?.runCount, 107);
      assert.equal(Object.hasOwn(workflows[0]!, "graph"), false);
      assert.equal(Object.hasOwn(workflows[0]!, "inputSchema"), false);
    } finally {
      globals.__beamStudioPgPool = previousPool;
      await readPool?.end();
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      if (previousAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previousAllow;
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
  },
);
