import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { WorkflowHierarchyRepository } from "./repositories/workflow-hierarchy-repository.js";
import { WorkflowReadRepository } from "./repositories/workflow-read-repository.js";
import { organizationScope } from "./repositories/organization-scope.js";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres"))
  throw new Error(
    "Workflow hierarchy acceptance requires isolated PostgreSQL in CI.",
  );

test(
  "workflow nesting is durable, scoped, cycle-safe under concurrent moves and independent of definitions",
  {
    skip: !source?.startsWith("postgres"),
  },
  async () => {
    const previous = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `workflow_hierarchy_${randomBytes(6).toString("hex")}`;
    let pool: PgPool | undefined;
    let second: PgPool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      second = createPostgresPool(url.toString());
      await pool.query(`INSERT INTO identity.organizations(id,slug,name) VALUES('org-a','org-a','A'),('org-b','org-b','B');
      INSERT INTO identity.projects(id,organization_id,slug,name) VALUES('project-a','org-a','a','A'),('project-b','org-a','b','B');
      INSERT INTO workflow.templates(id,organization_id,project_id,name,graph_json) VALUES
        ('a','org-a','project-a','Child','{"preserved":true}'),('b','org-a','project-b','Parent','{}'),
        ('c','org-a','project-a','Grandchild','{}'),('foreign','org-b',NULL,'Private','{}')`);
      const moves = new WorkflowHierarchyRepository(pool);
      const other = new WorkflowHierarchyRepository(second);
      const reads = new WorkflowReadRepository(second);
      const scope = organizationScope("org-a");
      const definitionsBefore = (
        await pool.query(
          "SELECT row_to_json(w) AS value FROM workflow.templates w ORDER BY id",
        )
      ).rows;
      await moves.move(scope, "a", "b");
      assert.equal(
        (await reads.listWorkflows(scope)).find((row) => row.id === "a")
          ?.sidebarParentId,
        "b",
      );
      await other.move(scope, "c", "a");
      assert.deepEqual(
        (
          await pool.query(
            "SELECT row_to_json(w) AS value FROM workflow.templates w ORDER BY id",
          )
        ).rows,
        definitionsBefore,
      );
      await assert.rejects(moves.move(scope, "a", "a"), { statusCode: 400 });
      await assert.rejects(moves.move(scope, "b", "c"), { statusCode: 409 });
      await assert.rejects(moves.move(scope, "a", "foreign"), {
        statusCode: 404,
      });
      await assert.rejects(moves.move(scope, "foreign", null), {
        statusCode: 404,
      });
      await assert.rejects(moves.move(scope, "a", "b", "project-a"), {
        statusCode: 404,
      });
      assert.deepEqual(
        (await reads.listWorkflows(organizationScope("org-b"))).map((row) => [
          row.id,
          row.sidebarParentId,
        ]),
        [["foreign", null]],
      );

      await moves.move(scope, "a", null);
      const competing = await Promise.allSettled([
        moves.move(scope, "a", "b"),
        other.move(scope, "b", "a"),
      ]);
      assert.equal(
        competing.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const rejected = competing.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.equal(rejected.reason.statusCode, 409);
      await moves.move(scope, "b", null);
      await moves.move(scope, "a", "b");
      await pool.query("DELETE FROM workflow.templates WHERE id='b'");
      const survivors = await reads.listWorkflows(scope);
      assert.equal(
        survivors.find((row) => row.id === "a")?.sidebarParentId,
        null,
      );
      assert.equal(
        survivors.find((row) => row.id === "c")?.sidebarParentId,
        "a",
      );
    } finally {
      await second?.end();
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      if (previous === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previous;
    }
  },
);
