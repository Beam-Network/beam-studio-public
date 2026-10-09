import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import type { AgentControlRepository } from "./repository.js";
import type { AgentGateway } from "./gateway.js";
import type { RoomStorageTransferManager } from "./room-storage-transfer-manager.js";
import { reconcileRoomWorkflowCancellations } from "./workflow-cancellation.js";
import {
  cancelWorkflowRoomPublication,
  recordWorkflowResourceActive,
} from "./workflow-resource-cleanup.js";

test("active publication registration does not claim cancellation completion", async () => {
  let query = "";
  const pool = {
    async query(sql: string) {
      query = sql;
      return { rows: [] };
    },
  } as unknown as PgPool;
  await recordWorkflowResourceActive(pool, "step");
  assert.match(query, /'state','active'/);
  assert.doesNotMatch(query, /cancellationStatus/);
});

test("a not-found cancellation settles an absent publication once", async () => {
  const recordedStates: string[] = [];
  let active = true;
  const pool = {
    async query(sql: string, values?: any[]) {
      if (sql.includes("SELECT s.id"))
        return {
          rows: active
            ? [
                {
                  id: "step",
                  organization_id: "org",
                  project_id: null,
                  workflow_step_id: "definition",
                  resolved_steps_json: [
                    {
                      id: "definition",
                      config: {
                        environmentTemplateKey: "prod",
                        roomId: `btr_room_${"a".repeat(26)}`,
                        channelId: "btr_channel_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                        source: {
                          memberId: "btr_member_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                          locator: { type: "agent_path", path: "/data/file" },
                        },
                        ttlSeconds: 300,
                      },
                    },
                  ],
                },
              ]
            : [],
        };
      if (sql.includes("SELECT * FROM agent_control.commands"))
        return {
          rows: [
            {
              state: "failed",
              error_json: { code: "not_found", message: "resource absent" },
            },
          ],
        };
      if (sql.includes("SET resource_execution_json")) {
        recordedStates.push(String(values?.[1]));
        active = false;
        return { rows: [] };
      }
      throw new Error("Unexpected cleanup database operation: " + sql);
    },
  } as unknown as PgPool;
  const repository = {
    async createCommand() {
      throw new Error("must not create another cancellation command");
    },
  } as unknown as AgentControlRepository;
  await reconcileRoomWorkflowCancellations(
    pool,
    repository,
    {} as AgentGateway,
  );
  await reconcileRoomWorkflowCancellations(
    pool,
    repository,
    {} as AgentGateway,
  );
  assert.deepEqual(recordedStates, ["failed"]);
});

test("completed storage cleanup without Core proof is recorded as unverified", async () => {
  const recordedStates: string[] = [];
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      recordedStates.push(String(values[1]));
      return { rows: [] };
    },
  } as unknown as PgPool;
  const result = await cancelWorkflowRoomPublication(
    pool,
    {} as AgentControlRepository,
    {} as AgentGateway,
    {
      workflowStatus: async () => ({
        id: "job",
        status: "completed",
        errorCode: null,
      }),
    } as unknown as RoomStorageTransferManager,
    {
      organizationId: "org",
      stepRunId: "step",
      roomId: "room",
      channelId: "channel",
      requestId: "request",
    },
  );
  assert.deepEqual(recordedStates, ["unverified"]);
  assert.equal(
    (result.result as { object: { state: string } }).object.state,
    "completed",
  );
});

test("cleanup survives revoked membership, uncertain dispatch and expired cancellation commands", async () => {
  let confirmed = false;
  let reconciled = false;
  const recordedStates: string[] = [];
  let command: Record<string, any> | undefined;
  const sent: Record<string, any>[] = [];
  const publication = {
    agent_id: "original-source",
    payload_json: { coordinator_url: "https://coordinator.b1m.ai" },
  };
  const query = async (sql: string, values?: any[]) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.startsWith("WITH verified AS MATERIALIZED")) {
      reconciled = true;
      return { rows: [] };
    }
    if (sql.includes("SELECT s.id"))
      return {
        rows: confirmed
          ? []
          : [
              {
                id: "step",
                organization_id: "org",
                project_id: null,
                workflow_step_id: "definition",
                resolved_steps_json: [
                  {
                    id: "definition",
                    config: {
                      environmentTemplateKey: "prod",
                      roomId: `btr_room_${"a".repeat(26)}`,
                      channelId: "btr_channel_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                      source: {
                        memberId: "btr_member_aaaaaaaaaaaaaaaaaaaaaaaaaa",
                        locator: { type: "agent_path", path: "/data/file" },
                      },
                      ttlSeconds: 600,
                    },
                  },
                ],
              },
            ],
      };
    if (sql.includes("SELECT * FROM agent_control.commands"))
      return { rows: command ? [command] : [] };
    if (sql.includes("SELECT agent_id,payload_json"))
      return { rows: [publication] };
    if (sql.includes("SET resource_execution_json")) {
      recordedStates.push(values?.[1]);
      confirmed = true;
      return { rows: [] };
    }
    throw new Error("Unexpected cleanup database operation: " + sql);
  };
  const pool = {
    query,
    async connect() {
      return { query, release() {} };
    },
  } as unknown as PgPool;
  const repository = {
    async createCommand(input: Record<string, any>) {
      sent.push(input);
      command = {
        id: `cancel-${sent.length}`,
        agent_id: input.agentId,
        state: "queued",
        expires_at: new Date(Date.now() + 60000).toISOString(),
      };
      return command;
    },
  } as unknown as AgentControlRepository;
  const gateway = {
    async dispatchAgent(id: string) {
      assert.equal(id, "original-source");
    },
  } as unknown as AgentGateway;
  await reconcileRoomWorkflowCancellations(pool, repository, gateway);
  await reconcileRoomWorkflowCancellations(pool, repository, gateway);
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0]!.payload.coordinator_url,
    publication.payload_json.coordinator_url,
  );
  assert.equal(sent[0]!.payload.publication_key, "workflow-step:step");
  command!.state = "expired";
  await reconcileRoomWorkflowCancellations(pool, repository, gateway);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0]!.idempotencyKey, sent[1]!.idempotencyKey);
  command!.state = "completed";
  command!.result_json = { object: { state: "cancelled" } };
  await reconcileRoomWorkflowCancellations(pool, repository, gateway);
  assert.equal(confirmed, true);
  assert.equal(reconciled, true);
  assert.deepEqual(recordedStates, ["cancelled"]);
  await reconcileRoomWorkflowCancellations(pool, repository, gateway);
  assert.equal(sent.length, 2);

  // A late cancel can observe a publication that already finished. Its
  // actual outcome settles cleanup without turning partial delivery into a
  // cancelled transfer or dispatching another cancel command.
  for (const [result, expected] of [
    [
      { object: { state: "completed", room_transfer: { status: "partial" } } },
      "partial",
    ],
    [
      {
        object: {
          state: "completed",
          room_transfer: { status: "completed", full_delivery_verified: true },
        },
      },
      "completed",
    ],
    [
      {
        object: { state: "completed", room_transfer: { status: "completed" } },
      },
      "unverified",
    ],
    [{ object: { state: "failed" } }, "failed"],
    [{ object: { state: "expired" } }, "expired"],
  ] as const) {
    confirmed = false;
    command!.result_json = result;
    await reconcileRoomWorkflowCancellations(pool, repository, gateway);
    assert.equal(recordedStates.at(-1), expected);
    assert.equal(sent.length, 2);
  }
  confirmed = false;
  command!.result_json = {
    object: { state: "completed" },
    storage: { errorCode: "room_storage_cleanup_incomplete" },
  };
  await reconcileRoomWorkflowCancellations(pool, repository, gateway);
  assert.equal(confirmed, false);
  assert.equal(sent.length, 3);
});
