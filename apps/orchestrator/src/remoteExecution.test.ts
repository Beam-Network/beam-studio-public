import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createRemoteTaskPreparer,
  decodeRemoteExecutionResult,
} from "./remoteExecution.js";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";

test("decodes the canonical Orchestrator Studio result", () => {
  const result = decodeRemoteExecutionResult(
    JSON.stringify({
      type: "workflow_task_result",
      event_id: "event-1",
      task_id: "task-1",
      attempt_id: "task-1:1",
      worker_id: "worker-1",
      status: "completed",
      outputs: { result: '{"outputs":{"value":42}}' },
    }),
  );
  assert.equal(result.task_id, "task-1");
  assert.equal(result.status, "completed");
});

test("rejects a malformed Orchestrator Studio result", () => {
  assert.throws(
    () =>
      decodeRemoteExecutionResult(
        JSON.stringify({ type: "workflow_task_result", task_id: "task-1" }),
      ),
    /Invalid Orchestrator Studio result envelope/,
  );
});

test("enabling remote transport preserves ordinary Studio wakeups", async () => {
  const pool = {
    connect() {
      throw new Error("A Studio target must not acquire a remote claim.");
    },
  } as unknown as PgPool;
  const prepare = createRemoteTaskPreparer(
    pool,
    {
      enabled: true,
      taskSubject: "remote.tasks",
      resultSubject: "remote.results",
      ownerId: "remote",
      leaseMs: 60000,
      sandboxRuntime: "node-legacy",
    },
    { info() {}, warn() {}, error() {} },
  );
  assert.deepEqual(
    await prepare({
      taskId: "task",
      workflowRunId: "run",
      placement: "local-workers",
      subject: "studio.tasks",
      messageId: "wakeup",
    }),
    {
      subject: "studio.tasks",
      messageId: "wakeup",
      payload: {
        taskId: "task",
        workflowRunId: "run",
        correlationId: undefined,
        traceparent: undefined,
      },
    },
  );
});

const postgres = process.env.BEAM_TEST_POSTGRES_URL;

test(
  "a remote dispatch publishes the signed Registry URL Studio grants, never storing it",
  { skip: !postgres },
  async () => {
    const database = `remote_signed_${randomBytes(6).toString("hex")}`;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(postgres);
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(postgres!);
    url.pathname = `/${database}`;
    const pool = createPostgresPool(url.toString());
    const previousUrl = process.env.BEAM_STUDIO_API_URL;
    const previousFetch = globalThis.fetch;
    const plainUrl =
      "https://api.b1m.ai/registry/v1/packages/%40acme/tool/versions/1.0.0/artifact";
    const signedUrl = `https://api.b1m.ai/registry/v1/artifacts/sha256/${"f".repeat(64)}?exp=1&sig=s`;
    const bodies: Array<Record<string, unknown>> = [];
    try {
      await ensurePostgresMigrations(pool);
      await pool.query(`
        INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Remote');
        INSERT INTO workflow.templates(id,organization_id,name) VALUES('workflow','org','Remote');
        INSERT INTO workflow.steps(id,workflow_template_id,kind,action_package_name,action_version_range,position) VALUES('step','workflow','action','@acme/tool','1.0.0',0);`);
      await pool.query(
        `INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status,resolved_steps_json)
         VALUES('run','org','workflow','running',$1::jsonb)`,
        [
          JSON.stringify([
            {
              id: "step",
              kind: "action",
              actionPackage: "@acme/tool",
              resolvedVersion: "1.0.0",
              sourceRegistry: "public-registry",
              artifactChecksum: `sha256:${"f".repeat(64)}`,
              registryArtifactUrl: plainUrl,
              mediaType: "application/gzip",
              manifestSnapshot: { name: "@acme/tool", version: "1.0.0" },
              executionTarget: { kind: "remote-transport" },
              config: {},
            },
          ]),
        ],
      );
      await pool.query(`
        INSERT INTO execution.workflow_run_authority(workflow_run_id,owner_id,lease_expires_at) VALUES('run','test',now()+interval '1 hour');
        INSERT INTO execution.workflow_run_capabilities(workflow_run_id,authorization_token) VALUES('run','run-capability');
        INSERT INTO execution.workflow_step_runs(id,workflow_run_id,workflow_step_id,action_package_name,resolved_version,checksum,source_registry,resolved_placement,status)
          VALUES('step-run','run','step','@acme/tool','1.0.0','checksum','public-registry','beamcore-public','queued');
        INSERT INTO execution.workflow_tasks(id,organization_id,workflow_run_id,workflow_step_run_id,workflow_step_id,task_kind,action_package_name,status,input_checksum)
          VALUES('task','org','run','step-run','step','step','@acme/tool','queued','checksum');`);
      process.env.BEAM_STUDIO_API_URL = "https://studio.example/";
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ authorized: true, artifactUrl: signedUrl });
      }) as typeof fetch;
      const prepare = createRemoteTaskPreparer(
        pool,
        {
          enabled: true,
          taskSubject: "remote.tasks",
          resultSubject: "remote.results",
          ownerId: "remote",
          leaseMs: 60000,
          sandboxRuntime: "node-legacy",
        },
        { info() {}, warn() {}, error() {} },
      );
      const prepared = await prepare({
        taskId: "task",
        workflowRunId: "run",
        placement: "beamcore-public",
        messageId: "publish",
      });
      assert.deepEqual(bodies[0], {
        stepId: "step",
        phase: "dispatch",
        inputs: {},
        artifactUrl: true,
      });
      const task = (prepared?.payload as { task: Record<string, any> }).task;
      assert.equal(task.registry_artifact.url, signedUrl);
      assert.equal(task.artifact_sha256, `sha256:${"f".repeat(64)}`);
      const stored = (
        await pool.query(
          "SELECT resolved_steps_json FROM execution.workflow_runs WHERE id='run'",
        )
      ).rows[0]!.resolved_steps_json;
      assert.equal(stored[0].registryArtifactUrl, plainUrl);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.BEAM_STUDIO_API_URL;
      else process.env.BEAM_STUDIO_API_URL = previousUrl;
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  },
);
