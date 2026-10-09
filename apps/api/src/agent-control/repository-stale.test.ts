import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { AgentControlRepository } from "./repository.js";

test("reconciles agent sessions after three missed heartbeat intervals", async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return { rowCount: 1, rows: [] };
    },
  } as unknown as PgPool;
  const now = new Date("2026-08-18T18:00:00.000Z");
  const repository = new AgentControlRepository(
    pool,
    ["test-secret"],
    () => now,
  );

  assert.equal(await repository.reconcileStaleSessions(), 1);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /status = 'expired'/);
  assert.match(queries[0]!.sql, /status = 'stale'/);
  assert.deepEqual(queries[0]!.values, ["2026-08-18T17:59:15.000Z"]);
});
