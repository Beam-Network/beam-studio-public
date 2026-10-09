import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { AgentControlRepository } from "./repository.js";

test("room labels do not require organizations to be mirrored locally", async () => {
  const schema = await readFile(
    new URL(
      "../../../../packages/db/src/beam-studio-target-schema.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const table = schema.match(
    /CREATE TABLE IF NOT EXISTS agent_control\.room_labels \([\s\S]*?\n\);/,
  )?.[0];

  assert.ok(table, "room_labels table definition is missing");
  assert.doesNotMatch(table, /REFERENCES identity\.organizations/);
  assert.match(
    schema,
    /ALTER TABLE agent_control\.room_labels\s+DROP CONSTRAINT IF EXISTS room_labels_organization_id_fkey/,
  );
});

test("room labels are listed per organization", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return {
        rows: [
          { room_id: "room-a", label: "Production" },
          { room_id: "room-b", label: "Design sync" },
        ],
        rowCount: 2,
      };
    },
  } as unknown as PgPool;
  const repository = new AgentControlRepository(pool, ["test-secret"]);

  assert.deepEqual(await repository.listRoomLabels("org-1"), {
    "room-a": "Production",
    "room-b": "Design sync",
  });
  assert.deepEqual(calls[0]?.values, ["org-1"]);
  assert.match(calls[0]?.sql ?? "", /FROM agent_control\.room_labels/);
});

test("room labels can be saved and cleared", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PgPool;
  const repository = new AgentControlRepository(pool, ["test-secret"]);

  assert.equal(
    await repository.setRoomLabel({
      organizationId: "org-1",
      roomId: "room-a",
      label: "  Production  ",
    }),
    "Production",
  );
  assert.match(calls[0]?.sql ?? "", /ON CONFLICT/);
  assert.deepEqual(calls[0]?.values, ["org-1", "room-a", "Production"]);

  assert.equal(
    await repository.setRoomLabel({
      organizationId: "org-1",
      roomId: "room-a",
      label: null,
    }),
    null,
  );
  assert.match(calls[1]?.sql ?? "", /DELETE FROM agent_control\.room_labels/);
  assert.deepEqual(calls[1]?.values, ["org-1", "room-a"]);
});

test("room labels reject values over 120 characters", async () => {
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as PgPool;
  const repository = new AgentControlRepository(pool, ["test-secret"]);

  await assert.rejects(
    repository.setRoomLabel({
      organizationId: "org-1",
      roomId: "room-a",
      label: "x".repeat(121),
    }),
    { code: "room_label_too_long", statusCode: 400 },
  );
});
