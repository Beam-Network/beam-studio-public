import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { AgentControlRepository } from "./repository.js";

test("recent room source paths are scoped to organization, template, and source agent", async () => {
  let sql = "";
  let values: unknown[] = [];
  const pool = {
    query: async (statement: string, parameters: unknown[]) => {
      sql = statement;
      values = parameters;
      return { rows: [{ source_path: "/srv/fixtures/a.bin" }] };
    },
  } as unknown as PgPool;
  const repository = new AgentControlRepository(pool, ["test-secret"]);
  assert.deepEqual(
    await repository.listRecentRoomSourcePaths("org-a", "prod", "agent-a", 8),
    ["/srv/fixtures/a.bin"],
  );
  assert.match(sql, /jsonb_array_elements\(run\.resolved_steps_json\)/);
  assert.match(sql, /step_run\.status = 'completed'/);
  assert.deepEqual(values, ["org-a", "prod", "agent-a", 8]);
});
