import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { AgentControlRepository } from "./repository.js";

test("records a delegated coordinator mutation as a completed agent command", async () => {
  const now = new Date("2026-08-18T18:00:00.000Z");
  const client = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("SELECT * FROM agent_control.commands")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("UPDATE agent_control.agents")) {
        return { rowCount: 1, rows: [{ command_sequence: 7 }] };
      }
      if (sql.includes("INSERT INTO agent_control.commands")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "agcmd_delegated",
              agent_id: "agent-a",
              organization_id: "org-a",
              project_id: null,
              sequence: 7,
              idempotency_key: "create-key",
              operation: "room.close",
              state: "completed",
              payload_json: {},
              result_json: { room: { room: { room_id: "room-a" } } },
              error_json: null,
              session_generation: null,
              expires_at: values?.at(-1),
              dispatched_at: now,
              accepted_at: now,
              started_at: now,
              completed_at: now,
              created_at: now,
              updated_at: now,
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as PgPool;
  const repository = new AgentControlRepository(
    pool,
    ["test-secret"],
    () => now,
  );

  const command = await repository.recordDelegatedCommand({
    organizationId: "org-a",
    agentId: "agent-a",
    operation: "room.close",
    payload: {},
    result: { room: { room: { room_id: "room-a" } } },
    idempotencyKey: "create-key",
    requestedById: "user-a",
  });

  assert.equal(command.state, "completed");
  assert.equal(command.sessionGeneration, null);
  assert.deepEqual(command.result, {
    room: { room: { room_id: "room-a" } },
  });
});
