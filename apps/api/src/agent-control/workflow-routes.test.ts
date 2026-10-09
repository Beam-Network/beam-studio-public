import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { PgPool } from "@beam-studio/db";
import { builtinBeamEnvironmentTemplates } from "@beam-studio/shared";
import type { AgentControlRepository } from "./repository.js";
import type { AgentGateway } from "./gateway.js";
import { CoordinatorRoomError } from "./coordinator-client.js";
import type { RoomStorageTransferManager } from "./room-storage-transfer-manager.js";
import { registerRoomWorkflowRoutes } from "./workflow-routes.js";
import { recordVerifiedRoomIdleLease } from "./workflow-resource-cleanup.js";
import {
  roomServiceForOrganization,
} from "./room-service.js";

const config = {
  environmentTemplateKey: "prod",
  source: {
    memberId: "btr_member_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    locator: { type: "agent_path", path: "/data/source" },
  },
  roomId: `btr_room_${"a".repeat(26)}`,
  channelId: "btr_channel_aaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const task = {
  id: "task",
  claim_token: "claim",
  status: "running",
  lease_expires_at: new Date(Date.now() + 60000).toISOString(),
  organization_id: "org",
  workflow_step_id: "step",
  workflow_step_run_id: "step-run",
  run_status: "running",
  resolved_steps_json: [
    { id: "step", actionPackage: "@beam/room-transfer", config },
  ],
  state_json: {},
};

test("claims fence organization, source, template, publication identity and command retries", async (t) => {
  let row = { ...task };
  const commands: Record<string, any>[] = [];
  const server = Fastify();
  t.after(() => server.close());
  registerRoomWorkflowRoutes(
    server,
    {
      query: async (sql: string) => ({
        rows: sql.includes("SELECT agent_id,payload_json")
          ? commands
              .filter((c) => c.operation === "room.channel.object.publish")
              .map((c) => ({ agent_id: c.agentId, payload_json: c.payload }))
          : [row],
      }),
    } as unknown as PgPool,
    {
      getAgent: async () => ({ capabilities: ["room-workflows/v1"] }),
      createCommand: async (input: Record<string, any>) => {
        commands.push(input);
        return { id: "command" };
      },
    } as unknown as AgentControlRepository,
    { dispatchAgent: async () => {} } as unknown as AgentGateway,
    undefined,
    async ({ templateKey }) =>
      builtinBeamEnvironmentTemplates[templateKey === "dev" ? "dev" : "prod"],
    (() => ({
      token: "test-service",
      client: {
        organizationRoomSnapshot: async () => {
          assert.notEqual(
            row.status,
            "cancelled",
            "Cleanup must not require current membership",
          );
          return {
            memberships: [
              {
                member_id: "btr_member_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                agent_id: "source-agent",
                kind: "agent",
                state: "active",
              },
            ],
          };
        },
      },
    })) as any,
    async () => {},
  );
  const send = (
    authorization = "Bearer claim",
    operation = "publish",
    requestId = "delivery-one",
  ) =>
    server.inject({
      method: "POST",
      url: "/internal/workflow-tasks/task/room-command",
      headers: { authorization },
      payload: {
        operation,
        requestId,
        sourceAgentId: "attacker",
        environment: "dev",
        publicationId: "other",
      },
    });
  assert.equal((await send("Bearer wrong")).statusCode, 403);
  assert.equal(commands.length, 0);
  assert.equal((await send()).statusCode, 200);
  assert.equal(
    (await send(undefined, "publish", "delivery-two")).statusCode,
    200,
  );
  assert.equal(commands[0]!.organizationId, "org");
  assert.equal(commands[0]!.agentId, "source-agent");
  assert.equal(
    commands[0]!.payload.coordinator_url,
    "https://coordinator.b1m.ai",
  );
  assert.equal(
    commands[0]!.payload.publication_key,
    commands[1]!.payload.publication_key,
  );
  assert.notEqual(commands[0]!.idempotencyKey, commands[1]!.idempotencyKey);
  row = {
    ...row,
    status: "cancelled",
    run_status: "cancelled",
    lease_expires_at: "",
  };
  assert.equal((await send()).statusCode, 403);
  assert.equal((await send(undefined, "cancel")).statusCode, 200);
  row = {
    ...row,
    status: "running",
    lease_expires_at: new Date(Date.now() - 1000).toISOString(),
  };
  assert.equal((await send()).statusCode, 403);
});

test("storage status waits for coordinator binding and then requires its evidence", async (t) => {
  const row = {
    ...task,
    state_json: { publicationId: "btr_pub_aaaaaaaaaaaaaaaaaaaaaaaaaa" },
  };
  let objectStatusReads = 0;
  let storageStatus = "running";
  let coordinatorStarted = false;
  const server = Fastify();
  t.after(() => server.close());
  registerRoomWorkflowRoutes(
    server,
    { query: async () => ({ rows: [row] }) } as unknown as PgPool,
    {} as unknown as AgentControlRepository,
    {} as unknown as AgentGateway,
    {
      workflowStatus: async () => ({
        publicationId: "btr_pub_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: storageStatus,
        file: {
          size_bytes: 104857600,
          chunk_size_bytes: 41943040,
          chunk_count: 3,
          identity: "identity",
        },
        transferId: null,
        errorCode: null,
        sourceMemberId: "btr_member_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceLocator: { type: "bucket_object", objectKey: "source.bin" },
        targetMemberIds: ["btr_member_bbbbbbbbbbbbbbbbbbbbbbbbbb"],
        coordinatorStarted,
      }),
    } as unknown as RoomStorageTransferManager,
    async ({ templateKey }) =>
      builtinBeamEnvironmentTemplates[templateKey === "dev" ? "dev" : "prod"],
    (() => ({
      token: "test-service",
      client: {
        organizationObjectStatus: async () => {
          objectStatusReads++;
          throw new CoordinatorRoomError(
            "BTR resource not found",
            404,
            "not_found",
          );
        },
      },
    })) as any,
    async () => {},
  );
  const send = () =>
    server.inject({
      method: "POST",
      url: "/internal/workflow-tasks/task/room-command",
      headers: { authorization: "Bearer claim" },
      payload: { operation: "status", requestId: "status-one" },
    });
  for (storageStatus of ["running", "cancel_requested"]) {
    const pending = await send();
    assert.equal(pending.statusCode, 200);
    assert.equal(
      pending.json().command.result.status.publisher.room_transfer.status,
      "pending",
    );
    assert.equal(objectStatusReads, 0);
  }
  coordinatorStarted = true;
  storageStatus = "completed";
  const response = await send();
  assert.equal(response.statusCode, 404);
  assert.equal(objectStatusReads, 1);
  assert.equal(response.json().command, undefined);
});

test("only Coordinator status bound to the workflow publication renews the room execution lease", async (t) => {
  const publicationId = "btr_pub_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const row = {
    ...task,
    attempt_count: 1,
    state_json: { publicationId },
  };
  const status = {
    publisher: {
      preflight: {
        publication_id: publicationId,
        publication_key_sha256: createHash("sha256")
          .update("workflow-step:step-run")
          .digest("hex"),
        room_id: config.roomId,
        channel_id: config.channelId,
        publisher_member_id: config.source.memberId,
      },
      room_transfer: {
        transfer_id: publicationId,
        status: "in_progress",
        idle_expires_at: new Date(Date.now() + 295_000).toISOString(),
      },
    },
  };
  let injectedLease: string | null = null;
  const writes: unknown[][] = [];
  const server = Fastify();
  t.after(() => server.close());
  registerRoomWorkflowRoutes(
    server,
    {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("'{trusted_idle_lease}'")) {
          writes.push(values ?? []);
          return { rows: [{ id: "step-run" }], rowCount: 1 };
        }
        return { rows: [row], rowCount: 1 };
      },
    } as unknown as PgPool,
    {} as AgentControlRepository,
    {} as AgentGateway,
    undefined,
    async () => builtinBeamEnvironmentTemplates.prod,
    (() => ({
      token: "test-service",
      client: {
        organizationObjectStatus: async () => ({
          status,
          ...(injectedLease ? { trustedIdleExpiresAt: injectedLease } : {}),
        }),
      },
    })) as any,
    async () => {},
  );
  const send = () =>
    server.inject({
      method: "POST",
      url: "/internal/workflow-tasks/task/room-command",
      headers: { authorization: "Bearer claim" },
      payload: { operation: "status", requestId: "lease" },
    });
  const valid = await send();
  assert.equal(valid.statusCode, 200);
  assert.equal(
    valid.json().command.result.trustedIdleExpiresAt,
    status.publisher.room_transfer.idle_expires_at,
  );
  assert.deepEqual(writes[0]?.slice(0, 2), ["step-run", publicationId]);
  status.publisher.preflight.publication_key_sha256 = "0".repeat(64);
  injectedLease = new Date(Date.now() + 300_000).toISOString();
  assert.equal(
    (await send()).json().command.result.trustedIdleExpiresAt,
    undefined,
  );
  assert.equal(writes.length, 1);
  status.publisher.preflight.publication_key_sha256 = createHash("sha256")
    .update("workflow-step:step-run")
    .digest("hex");
  status.publisher.room_transfer.idle_expires_at = new Date(
    Date.now() + 600_000,
  ).toISOString();
  assert.equal(
    (await send()).json().command.result.trustedIdleExpiresAt,
    undefined,
  );
  assert.equal(writes.length, 1);
});

test("a late room status cannot persist a lease after publication, claim or run replacement", async () => {
  let sql = "";
  let values: unknown[] = [];
  const pool = {
    query: async (statement: string, parameters: unknown[]) => {
      sql = statement;
      values = parameters;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PgPool;
  const written = await recordVerifiedRoomIdleLease(
    pool,
    {
      taskId: "task",
      claimToken: "current-claim",
      attempt: 3,
      stepRunId: "step-run",
      publicationId: "current-publication",
      roomId: config.roomId,
      channelId: config.channelId,
      sourceMemberId: config.source.memberId,
    },
    new Date(Date.now() + 295_000).toISOString(),
  );
  assert.equal(written, false);
  assert.match(sql, /step\.state_json->>'publicationId'=\$2/);
  assert.match(sql, /task\.claim_token=\$6/);
  assert.match(sql, /run\.status='running'/);
  assert.equal(values[1], "current-publication");
  assert.equal(values[5], "current-claim");
});

test("execution inspection availability does not replace authoritative settlement or suppress access failures", async (t) => {
  const row = { ...task, state_json: { publicationId: "publication" } };
  const status = {
    publisher: {
      room_transfer: { status: "completed", full_delivery_verified: true },
      deliveries: [{ member_id: "recipient", state: "delivered" }],
    },
  };
  let inspectionStatus = 404;
  const recordedStates: string[] = [];
  const server = Fastify();
  t.after(() => server.close());
  registerRoomWorkflowRoutes(
    server,
    {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("SET resource_execution_json"))
          recordedStates.push(String(values?.[1]));
        return { rows: [row] };
      },
    } as unknown as PgPool,
    {} as AgentControlRepository,
    {} as AgentGateway,
    undefined,
    async () => builtinBeamEnvironmentTemplates.prod,
    (() => ({
      token: "test-service",
      client: {
        organizationObjectStatus: async () => ({ status }),
        organizationObjectExecution: async () => {
          throw new CoordinatorRoomError(
            "inspection unavailable",
            inspectionStatus,
            "inspection_unavailable",
          );
        },
      },
    })) as any,
    async () => {},
  );
  const send = () =>
    server.inject({
      method: "POST",
      url: "/internal/workflow-tasks/task/room-command",
      headers: { authorization: "Bearer claim" },
      payload: { operation: "status", requestId: "inspection" },
    });
  for (const code of [404, 408, 429, 502, 503, 504]) {
    inspectionStatus = code;
    const response = await send();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().command.result.status, status);
    assert.equal(response.json().command.result.execution, undefined);
  }
  for (const verified of [false, undefined]) {
    status.publisher.room_transfer.full_delivery_verified = verified as boolean;
    inspectionStatus = 404;
    const response = await send();
    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().command.result.status.publisher.room_transfer.status,
      "failed",
    );
    assert.equal(
      response.json().command.result.status.publisher.room_transfer.error_code,
      "room_transfer_delivery_unverified",
    );
    assert.equal(recordedStates.at(-1), "failed");
    assert.equal(status.publisher.room_transfer.status, "completed");
  }
  status.publisher.room_transfer.full_delivery_verified = true;
  for (const code of [401, 403, 400, 409]) {
    inspectionStatus = code;
    assert.equal((await send()).statusCode, code);
  }
});
