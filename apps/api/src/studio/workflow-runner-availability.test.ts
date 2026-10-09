import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type FrozenWorkflowDefinition,
  type FrozenWorkflowTree,
  type PgClient,
} from "@beam-studio/db";
import { defaultWorkflowContract } from "@beam-studio/core";
import {
  assertWorkflowStudioRunnersAvailablePg,
  StudioRunnerUnavailableError,
} from "./workflow-runner-availability.js";

const definition = (
  id: string,
  steps: Record<string, unknown>[],
): FrozenWorkflowDefinition => ({
  revisionId: `${id}-version`,
  workflowTemplateId: id,
  organizationId: "org",
  projectId: "project",
  snapshot: { contract: defaultWorkflowContract },
  resolvedSteps: steps,
});
function tree(...definitions: FrozenWorkflowDefinition[]): FrozenWorkflowTree {
  return {
    root: definitions[0]!,
    definitions: Object.fromEntries(
      definitions.map((value) => [value.workflowTemplateId, value]),
    ),
  };
}
const action = (id: string, executionTarget: Record<string, unknown>) => ({
  id,
  kind: "action",
  enabled: true,
  executionTarget,
});
const call = (id: string, calledWorkflowId: string, enabled = true) => ({
  id,
  kind: "workflow",
  calledWorkflowId,
  enabled,
});
test("room-member and remote actions, including child calls, never require Studio registration", async () => {
  const client = {
    query: () =>
      assert.fail(
        "non-Studio actions must not query Studio runner availability",
      ),
  } as unknown as PgClient;
  await assertWorkflowStudioRunnersAvailablePg(
    client,
    tree(
      definition("parent", [
        call("call", "child"),
        call("disabled", "studio", false),
      ]),
      definition("child", [
        action("member", {
          kind: "room-member",
          memberIds: ["member"],
          channelId: "channel",
          requesterMemberId: "requester",
        }),
        action("remote", { kind: "remote-transport" }),
      ]),
      definition("studio", [action("compute", { kind: "studio" })]),
    ),
  );
});

test("an enabled Studio action in a child retains its own project and runner constraints", async () => {
  const queries: unknown[][] = [];
  const client = {
    query: async (_sql: string, values: unknown[]) => {
      queries.push(values);
      return { rows: [{ has_active_runner: false }] };
    },
  } as unknown as PgClient;
  const child = definition("child", [
    action("compute", { kind: "studio", runnerIds: ["chosen"] }),
  ]);
  child.projectId = "child-project";
  await assert.rejects(
    assertWorkflowStudioRunnersAvailablePg(
      client,
      tree(definition("parent", [call("call", "child")]), child),
    ),
    (error: unknown) => {
      assert.ok(error instanceof StudioRunnerUnavailableError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "studio_runner_unavailable");
      assert.match(error.message, /Workflow child, action compute.*chosen/);
      return true;
    },
  );
  assert.deepEqual(queries, [["org", "child-project", ["chosen"]]]);
});

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
test(
  "PostgreSQL readiness enforces fresh scoped candidates within the declared runner set",
  { skip: !source },
  async () => {
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const maintenance = createPostgresPool(source!);
    const database = `runner_readiness_${randomBytes(6).toString("hex")}`;
    await maintenance.query(`CREATE DATABASE ${database}`);
    const url = new URL(source!);
    url.pathname = `/${database}`;
    const pool = createPostgresPool(url.toString());
    try {
      await ensurePostgresMigrations(pool);
      await pool.query(
        "INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Org'),('other','other','Other')",
      );
      await pool.query(
        "INSERT INTO identity.projects(id,organization_id,name,slug) VALUES('project','org','Project','project'),('other-project','org','Other project','other-project')",
      );
      const frozen = tree(
        definition("workflow", [
          action("compute", { kind: "studio", runnerIds: ["chosen"] }),
        ]),
      );
      const client = await pool.connect();
      try {
        // An unrelated global runner must not satisfy an explicit runner set.
        await client.query(
          "INSERT INTO runtime.worker_runtime_state(worker_id,network_identity,status,heartbeat_at) VALUES('unlisted','unlisted','active',now()),('chosen','chosen','active',now())",
        );
        await client.query(
          "UPDATE runtime.worker_runtime_state SET organization_id='other' WHERE worker_id='chosen'",
        );
        await assert.rejects(
          assertWorkflowStudioRunnersAvailablePg(client, frozen),
          StudioRunnerUnavailableError,
        );
        await client.query(
          "UPDATE runtime.worker_runtime_state SET organization_id='org',project_id='other-project' WHERE worker_id='chosen'",
        );
        await assert.rejects(
          assertWorkflowStudioRunnersAvailablePg(client, frozen),
          StudioRunnerUnavailableError,
        );
        await client.query(
          "UPDATE runtime.worker_runtime_state SET project_id='project',heartbeat_at=now()-interval '1 minute' WHERE worker_id='chosen'",
        );
        await assert.rejects(
          assertWorkflowStudioRunnersAvailablePg(client, frozen),
          StudioRunnerUnavailableError,
        );
        await client.query(
          "UPDATE runtime.worker_runtime_state SET heartbeat_at=now(),status='draining' WHERE worker_id='chosen'",
        );
        await assert.rejects(
          assertWorkflowStudioRunnersAvailablePg(client, frozen),
          StudioRunnerUnavailableError,
        );
        await client.query(
          "UPDATE runtime.worker_runtime_state SET status='active' WHERE worker_id='chosen'",
        );
        await assert.doesNotReject(
          assertWorkflowStudioRunnersAvailablePg(client, frozen),
        );
        await client.query(
          "UPDATE runtime.worker_runtime_state SET organization_id=NULL,project_id=NULL WHERE worker_id='chosen'",
        );
        await assert.doesNotReject(
          assertWorkflowStudioRunnersAvailablePg(client, frozen),
        );
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await maintenance.query(`DROP DATABASE ${database}`);
      await maintenance.end();
    }
  },
);
