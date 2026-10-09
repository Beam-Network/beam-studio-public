import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import {
  captureWorkflowTreePg,
  createPostgresPool,
  enqueueFrozenWorkflowRunPg,
  ensurePostgresMigrations,
  withPostgresTransaction,
  type PgPool,
} from "@beam-studio/db";
import { createWorkflowCallPg } from "./workflowCalls.js";
import { workflowStepFromSnapshot } from "./postgresOrchestration.js";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
const database = `workflow_room_${crypto.randomBytes(6).toString("hex")}`;
let pool: PgPool;
let maintenance: PgPool;
const room = {
  environmentTemplateKey: "dev",
  roomId: `btr_room_${"a".repeat(26)}`,
};
const other = { ...room, roomId: `btr_room_${"b".repeat(26)}` };
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
    "INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Test')",
  );
  await pool.query(
    "INSERT INTO actions.scopes(id,name) VALUES('test-room-scope','@test-room')",
  );
  await pool.query(
    "INSERT INTO actions.packages(id,scope_id,name,package_name,display_name) VALUES('room-action','test-room-scope','room-transfer','@beam/room-transfer','Room transfer')",
  );
  await pool.query(
    `INSERT INTO actions.package_versions(id,package_id,version,manifest_json,manifest_checksum,artifact_checksum,artifact_size_bytes,status)
    VALUES('room-version','room-action','2.1.0',$1::jsonb,'manifest','artifact',1,'active')`,
    [
      JSON.stringify({
        name: "@beam/room-transfer",
        version: "2.1.0",
        runtime: {
          placements: ["local-workers"],
          defaultPlacement: "local-workers",
        },
        configSchema: {
          type: "object",
          required: ["roomId", "environmentTemplateKey"],
          properties: {
            roomId: { type: "string" },
            environmentTemplateKey: { type: "string" },
          },
        },
      }),
    ],
  );
});
after(async () => {
  await pool?.end();
  if (maintenance) {
    await maintenance.query(`DROP DATABASE IF EXISTS ${database}`);
    await maintenance.end();
  }
});
async function definition(id: string, context: unknown = null) {
  await pool.query(
    "INSERT INTO workflow.templates(id,organization_id,name,room_context_json,api_key_id) VALUES($1,'org',$1,$2::jsonb,'execution-key')",
    [id, context ? JSON.stringify(context) : null],
  );
}
async function call(parent: string, child: string) {
  await pool.query(
    "INSERT INTO workflow.steps(id,workflow_template_id,kind,called_workflow_id,position) VALUES($1,$2,'workflow',$3,0)",
    [`${parent}-call`, parent, child],
  );
}
async function action(parent: string, config: unknown) {
  await pool.query(
    "INSERT INTO workflow.steps(id,workflow_template_id,kind,action_package_name,action_version_range,config_json,position) VALUES($1,$2,'action','@beam/room-transfer','2.1.0',$3::jsonb,1)",
    [`${parent}-action`, parent, JSON.stringify(config)],
  );
}
const capture = (id: string, validateOnly = false) =>
  withPostgresTransaction(pool, (client) =>
    captureWorkflowTreePg(client, {
      organizationId: "org",
      workflowTemplateId: id,
      validateOnly,
    }),
  );
test(
  "transitive room context resolves before action validation and survives definition edits",
  { skip: !source },
  async () => {
    await definition("root", room);
    await definition("middle");
    await definition("leaf");
    await call("root", "middle");
    await call("middle", "leaf");
    await action("leaf", {});
    // The reusable child can be saved without a room but cannot run by itself.
    await capture("leaf", true);
    await assert.rejects(capture("leaf"), /roomId is required/);
    const tree = await capture("root");
    assert.deepEqual(tree.definitions.leaf!.resolvedSteps[0]!.config, {});
    const runId = await withPostgresTransaction(pool, (client) =>
      enqueueFrozenWorkflowRunPg(client, {
        definition: tree.root,
        definitions: tree.definitions,
        runtimeInput: {},
        trigger: "manual",
      }),
    );
    await pool.query(
      "UPDATE workflow.templates SET room_context_json=$1 WHERE id='root'",
      [other],
    );
    const frozenContext = (
      await pool.query(
        "SELECT execution_context_json FROM execution.workflow_runs WHERE id=$1",
        [runId],
      )
    ).rows[0].execution_context_json;
    let parent = runId;
    for (const id of ["root", "middle"]) {
      await pool.query(
        "UPDATE execution.workflow_runs SET status='running' WHERE id=$1",
        [parent],
      );
      await withPostgresTransaction(pool, (client) =>
        createWorkflowCallPg(client, {
          workflowRunId: parent,
          organizationId: "org",
          step: workflowStepFromSnapshot(
            tree.definitions[id]!.resolvedSteps[0]!,
            0,
          ),
          inputs: {},
          dynamicInstanceId: null,
          authorizeExecution: async () => {},
        }),
      );
      const child = (
        await pool.query(
          "SELECT * FROM execution.workflow_runs WHERE parent_run_id=$1",
          [parent],
        )
      ).rows[0]!;
      assert.deepEqual(child.execution_context_json.room, room);
      assert.equal(
        child.execution_context_json.environment,
        frozenContext.environment,
      );
      assert.deepEqual(child.execution_context_json.beam, frozenContext.beam);
      if (id === "middle")
        assert.deepEqual(child.resolved_steps_json[0].config, room);
      parent = child.id;
    }
    assert.deepEqual(
      (
        await pool.query(
          "SELECT config_json FROM workflow.steps WHERE id='leaf-action'",
        )
      ).rows[0].config_json,
      {},
    );
  },
);
test(
  "child room establishes only its own subtree; action selections never establish sibling context",
  { skip: !source },
  async () => {
    await definition("optional-parent");
    await definition("own-room-child", other);
    await call("optional-parent", "own-room-child");
    await action("optional-parent", room);
    const tree = await capture("optional-parent");
    const rootId = await withPostgresTransaction(pool, (client) =>
      enqueueFrozenWorkflowRunPg(client, {
        definition: tree.root,
        definitions: tree.definitions,
        runtimeInput: {},
        trigger: "manual",
      }),
    );
    const root = (
      await pool.query("SELECT * FROM execution.workflow_runs WHERE id=$1", [
        rootId,
      ])
    ).rows[0];
    assert.equal(root.execution_context_json.room, null);
    assert.deepEqual(
      root.resolved_steps_json.find(
        (step: { kind: string }) => step.kind === "action",
      ).executionRoom,
      room,
    );
    await pool.query(
      "UPDATE execution.workflow_runs SET status='running' WHERE id=$1",
      [rootId],
    );
    const step = tree.root.resolvedSteps.find(
      (step) => step.kind === "workflow",
    )!;
    await withPostgresTransaction(pool, (client) =>
      createWorkflowCallPg(client, {
        workflowRunId: rootId,
        organizationId: "org",
        step: workflowStepFromSnapshot(step, 0),
        inputs: {},
        dynamicInstanceId: null,
        authorizeExecution: async () => {},
      }),
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT execution_context_json FROM execution.workflow_runs WHERE parent_run_id=$1",
          [rootId],
        )
      ).rows[0].execution_context_json.room,
      other,
    );
  },
);
test(
  "conflicting action and child associations reject the whole snapshot transaction",
  { skip: !source },
  async () => {
    await definition("conflict-parent", room);
    await definition("conflict-child", other);
    await call("conflict-parent", "conflict-child");
    await assert.rejects(
      capture("conflict-parent"),
      /conflicts with the inherited room/,
    );
    await pool.query(
      "UPDATE workflow.templates SET room_context_json=$1 WHERE id='conflict-child'",
      [room],
    );
    await action("conflict-child", { ...room, environmentTemplateKey: "prod" });
    await assert.rejects(
      capture("conflict-parent"),
      /conflicts with the inherited room/,
    );
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) AS n FROM workflow.plan_versions WHERE workflow_template_id LIKE 'conflict-%'",
          )
        ).rows[0].n,
      ),
      0,
    );
  },
);

test(
  "definition, action tag and artifact resolution use the same database snapshot",
  { skip: !source },
  async () => {
    await definition("catalog-root", room);
    await action("catalog-root", {});
    await pool.query(
      "UPDATE workflow.steps SET action_version_range='latest' WHERE id='catalog-root-action'",
    );
    await pool.query(
      "INSERT INTO actions.dist_tags(id,package_id,tag,version_id) VALUES('room-latest','room-action','latest','room-version')",
    );
    const tree = await withPostgresTransaction(pool, async (client) => {
      const query = client.query.bind(client);
      let changed = false;
      client.query = (async (sql: any, ...values: any[]) => {
        if (
          !changed &&
          typeof sql === "string" &&
          sql.includes("pg_advisory_xact_lock")
        ) {
          changed = true;
          await pool.query(`INSERT INTO actions.package_versions(id,package_id,version,manifest_json,manifest_checksum,artifact_checksum,artifact_size_bytes,status)
          SELECT 'room-version-new',package_id,'2.2.0',manifest_json,'new-manifest','new-artifact',1,'active' FROM actions.package_versions WHERE id='room-version'`);
          await pool.query(
            "UPDATE actions.dist_tags SET version_id='room-version-new' WHERE id='room-latest'",
          );
          await pool.query(
            "UPDATE workflow.templates SET name='Edited concurrently' WHERE id='catalog-root'",
          );
        }
        return (query as any)(sql, ...values);
      }) as typeof client.query;
      try {
        return await captureWorkflowTreePg(client, {
          organizationId: "org",
          workflowTemplateId: "catalog-root",
        });
      } finally {
        client.query = query;
      }
    });
    assert.equal(tree.root.resolvedSteps[0]!.resolvedVersion, "2.1.0");
    assert.equal(tree.root.resolvedSteps[0]!.artifactChecksum, "artifact");
    assert.equal(
      (tree.root.snapshot.workflowTemplate as any).name,
      "catalog-root",
    );
    assert.equal(
      (await capture("catalog-root")).root.resolvedSteps[0]!.resolvedVersion,
      "2.2.0",
    );
  },
);
