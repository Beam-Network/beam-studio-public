import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";

const databaseUrl =
  process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !databaseUrl?.startsWith("postgres")) {
  throw new Error("Workflow authoring acceptance requires isolated PostgreSQL.");
}
test(
  "authoring preserves locked manifests, saves contracts atomically and renders frozen call definitions",
  { skip: !databaseUrl?.startsWith("postgres") },
  async () => {
    const originalUrl = process.env.DATABASE_URL;
    const originalAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(databaseUrl);
    const database = `workflow_authoring_${crypto.randomBytes(6).toString("hex")}`;
    let pool: PgPool | undefined;
    const globalStore = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
    };
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${database}`;
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      globalStore.__beamStudioPgPool = pool;
      const store = await import("./store.js");
      const versionedId = await store.createWorkflowTemplate({
        organizationId: "org_authoring", name: "Versioned actions",
      });
      await pool.query("INSERT INTO actions.scopes(id,name) VALUES('version-scope','@version')");
      await pool.query("INSERT INTO actions.packages(id,scope_id,name,package_name,display_name) VALUES('version-action','version-scope','action','@version/action','Versioned action')");
      for (const [position, version] of ["1.2.19", "1.2.21"].entries()) {
        const manifest = { name: "@version/action", version, configSchema: { title: version } };
        await pool.query(
          "INSERT INTO actions.package_versions(id,package_id,version,manifest_json,manifest_checksum,artifact_checksum,published_at) VALUES($1,'version-action',$2,$3,$4,'test-artifact',$5)",
          [`version-${version}`, version, JSON.stringify(manifest), `checksum-${version}`, `2026-09-${position + 10}T00:00:00Z`],
        );
        await pool.query(
          "INSERT INTO workflow.steps(id,workflow_template_id,action_package_name,action_version_range,position) VALUES($1,$2,'@version/action',$3,$4)",
          [`step-${version}`, versionedId, version, position],
        );
        await pool.query(
          "INSERT INTO workflow.action_locks(id,workflow_template_id,action_package_name,version_range,resolved_version,package_version_id,checksum,source_registry) VALUES($1,$2,'@version/action',$3,$3,$4,$5,'test')",
          [`wfl_step-${version}`, versionedId, version, `version-${version}`, `checksum-${version}`],
        );
      }
      const versioned = await store.getWorkflowTemplate(versionedId, "org_authoring");
      assert.deepEqual(versioned?.steps.map((step) => step.manifest?.version), ["1.2.19", "1.2.21"]);
      assert.deepEqual(versioned?.steps[0]?.manifest?.configSchema, { title: "1.2.19" });
      await pool.query("UPDATE workflow.action_locks SET checksum='missing' WHERE id='wfl_step-1.2.19'");
      assert.equal((await store.listWorkflowSteps(versionedId))[0]?.manifest, null,
        "an unavailable locked manifest must not be substituted with the latest version");
      const childId = await store.createWorkflowTemplate({
        organizationId: "org_authoring",
        name: "Public child",
      });
      const parentId = await store.createWorkflowTemplate({
        organizationId: "org_authoring",
        name: "Parent",
        apiKeyId: "execution-key",
      });
      const parent = await store.getWorkflowTemplate(parentId, "org_authoring");
      assert.ok(parent);
      const step = {
        id: "call_authoring",
        name: "Original call",
        kind: "workflow" as const,
        calledWorkflowId: childId,
        actionPackageName: "",
        actionVersionRange: "*",
        position: 0,
        config: {},
        placement: "dispatcher",
        executionLocationId: null,
        canvasX: null,
        canvasY: null,
        timeoutSeconds: null,
        enabled: true,
        inputBindings: {},
        required: true,
      };
      const saved = await store.updateWorkflowGraph({
        organizationId: "org_authoring",
        workflowTemplateId: parentId,
        inputSchema: { type: "object" },
        output: {
          schema: { type: "object" },
          bindings: "${steps.call_authoring.outputs}",
        },
        steps: [step],
        edges: [],
        triggers: parent.triggers,
        triggerEdges: [
          {
            id: "call_trigger",
            triggerId: parent.triggers[0]!.id,
            toStepId: step.id,
            condition: null,
          },
        ],
      });
      assert.equal(saved?.steps[0]?.kind, "workflow");
      const runId = await store.startWorkflowRun(parentId, "org_authoring", {
        initiatingPrincipalId: "account-user",
      });
      const before = (
        await pool.query("SELECT * FROM execution.workflow_runs WHERE id=$1", [
          runId,
        ])
      ).rows[0];
      assert.equal(
        before.execution_context_json.initiatingPrincipalId,
        "account-user",
      );
      assert.ok(before.template_snapshot_json.dependencies[childId]);
      await store.updateWorkflowGraph({
        organizationId: "org_authoring",
        workflowTemplateId: parentId,
        steps: [{ ...step, name: "Edited call" }],
        edges: [],
        triggers: parent.triggers,
        triggerEdges: [
          {
            id: "call_trigger",
            triggerId: parent.triggers[0]!.id,
            toStepId: step.id,
            condition: null,
          },
        ],
      });
      const history = await store.getWorkflowRun(runId, "org_authoring");
      assert.equal(history?.steps[0]?.name, "Original call");
      assert.equal(history?.steps[0]?.calledWorkflowId, childId);
      assert.deepEqual(history?.template?.output, {
        schema: { type: "object" },
        bindings: "${steps.call_authoring.outputs}",
      });
      const revisions = (
        await pool.query(
          "SELECT count(*)::int AS n FROM workflow.plan_versions WHERE workflow_template_id=$1",
          [parentId],
        )
      ).rows[0].n;
      await assert.rejects(
        store.updateWorkflowGraph({
          organizationId: "org_authoring",
          workflowTemplateId: parentId,
          output: { schema: { type: "incorrect" }, bindings: {} },
          steps: [step],
          edges: [],
          triggers: parent.triggers,
          triggerEdges: [
            {
              id: "call_trigger",
              triggerId: parent.triggers[0]!.id,
              toStepId: step.id,
              condition: null,
            },
          ],
        }),
        /Invalid workflow schema/,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM workflow.plan_versions WHERE workflow_template_id=$1",
            [parentId],
          )
        ).rows[0].n,
        revisions,
      );
      assert.equal(
        (await store.getWorkflowTemplate(parentId, "org_authoring"))?.steps[0]
          ?.name,
        "Edited call",
      );
      const copyId = await store.duplicateWorkflowTemplate({
        id: parentId,
        organizationId: "org_authoring",
      });
      const copy = await store.getWorkflowTemplate(copyId, "org_authoring");
      assert.equal(copy?.steps[0]?.calledWorkflowId, childId);
      assert.equal(
        copy?.template.output.bindings,
        `\${steps.${copy?.steps[0]?.id}.outputs}`,
      );
      // Region retry must retain the invoking step identity and its previous child.
      const { orchestratePg } = await import(
        new URL(
          "../../../orchestrator/src/postgresOrchestration.ts",
          import.meta.url,
        ).href
      );
      const options = {
        authorizeExecution: async () => {},
        batchSize: 100,
        maxAttempts: 3,
        logger: { info() {}, warn() {}, error() {} },
        broker: {
          async publishTask() {
            throw new Error("Calls do not use Action Runners");
          },
        },
      };
      await store.updateWorkflowTemplate({
        id: childId,
        organizationId: "org_authoring",
        output: {
          schema: { type: "integer" },
          bindings: "${workflow.input.value}",
        },
      });
      const regionParent = await store.createWorkflowTemplate({
        organizationId: "org_authoring",
        name: "Region calls",
        apiKeyId: "execution-key",
      });
      await store.updateWorkflowGraph({
        workflowTemplateId: regionParent,
        organizationId: "org_authoring",
        failurePolicy: "continue_on_failure",
        graphVersion: "workflow-graph/v2",
        controls: [
          {
            id: "fan",
            kind: "fan-out",
            items: [1, "bad"],
            concurrency: 2,
            fanInId: "join",
            body: {
              stepIds: ["region-call"],
              entryStepId: "region-call",
              outputStepId: "region-call",
              edges: [],
            },
          },
        ],
        steps: [
          {
            ...step,
            id: "region-call",
            inputBindings: { value: "${graph.fan.item}" },
          },
        ],
        edges: [],
        triggers: [
          {
            id: "region-manual",
            type: "manual",
            name: "Manual",
            enabled: true,
            config: {},
            canvasX: null,
            canvasY: null,
          },
        ],
        triggerEdges: [
          {
            id: "region-entry",
            triggerId: "region-manual",
            toStepId: "region-call",
            condition: null,
          },
        ],
      });
      const regionRun = await store.startWorkflowRun(
        regionParent,
        "org_authoring",
      );
      for (let tick = 0; tick < 12; tick++) {
        await orchestratePg(pool, options);
        if (
          (
            await pool.query(
              "SELECT status FROM execution.workflow_runs WHERE id=$1",
              [regionRun],
            )
          ).rows[0].status === "failed"
        )
          break;
      }
      const oldCalls = (
        await pool.query(
          "SELECT id,status,child_run_id FROM execution.workflow_step_runs WHERE workflow_run_id=$1",
          [regionRun],
        )
      ).rows;
      assert.deepEqual(oldCalls.map((row) => row.status).sort(), [
        "completed",
        "failed",
      ]);
      const failed = oldCalls.find((row) => row.status === "failed")!;
      await store.retryWorkflowDynamicRegion({
        authorizeExecution: async () => {},
        workflowRunId: regionRun,
        controlId: "fan",
        organizationId: "org_authoring",
      });
      await orchestratePg(pool, options);
      const retried = (
        await pool.query(
          "SELECT * FROM execution.workflow_step_runs WHERE id=$1",
          [failed.id],
        )
      ).rows[0];
      assert.equal(retried.attempt, 2);
      assert.notEqual(retried.child_run_id, failed.child_run_id);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM execution.workflow_runs WHERE parent_run_id=$1",
            [regionRun],
          )
        ).rows[0].n,
        3,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT child_run_id FROM execution.workflow_step_runs WHERE id=$1",
            [oldCalls.find((row) => row.status === "completed")!.id],
          )
        ).rows[0].child_run_id,
        oldCalls.find((row) => row.status === "completed")!.child_run_id,
      );
      await store.cancelWorkflowDynamicRegion({
        workflowRunId: regionRun,
        controlId: "fan",
        organizationId: "org_authoring",
      });
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM execution.workflow_runs WHERE id=$1",
            [retried.child_run_id],
          )
        ).rows[0].status,
        "cancel_requested",
      );
      await assert.rejects(
        store.retryWorkflowDynamicRegion({
          authorizeExecution: async () => {},
          workflowRunId: regionRun,
          controlId: "fan",
          organizationId: "org_authoring",
        }),
        /Only failed or cancelled/,
      );
      for (let tick = 0; tick < 5; tick++) await orchestratePg(pool, options);
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM execution.workflow_runs WHERE id=$1",
            [retried.child_run_id],
          )
        ).rows[0].status,
        "cancelled",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM execution.workflow_dynamic_regions WHERE workflow_run_id=$1",
            [regionRun],
          )
        ).rows[0].status,
        "cancelled",
      );
    } finally {
      delete globalStore.__beamStudioPgPool;
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = originalAllow;
    }
  },
);
