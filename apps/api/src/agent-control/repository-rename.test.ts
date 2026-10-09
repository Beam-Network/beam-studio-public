import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { AgentControlRepository } from "./repository.js";

function setup(rowCount = 1, auditFailure = false) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  let released = false;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (auditFailure && sql.includes("audit_events"))
        throw new Error("Audit unavailable");
      return { rows: [], rowCount };
    },
    release: () => {
      released = true;
    },
  };
  const repository = new AgentControlRepository(
    { connect: async () => client } as unknown as PgPool,
    ["test-secret"],
  );
  return { repository, calls, released: () => released };
}

test("rename is scoped to the organization, audited and leaves machine hostnames untouched", async () => {
  const fixture = setup();
  assert.deepEqual(
    await fixture.repository.renameAgent(
      "org-1",
      "agent-a",
      "  Production  ",
      "user-1",
    ),
    { id: "agent-a", name: "Production" },
  );
  const update = fixture.calls[1];
  assert.ok(update);
  assert.match(update.sql, /WHERE id = \$1 AND organization_id = \$2/);
  assert.deepEqual(update.values, ["agent-a", "org-1", "Production"]);
  assert.ok(
    fixture.calls.some((call) => call.values?.includes("agent.renamed")),
  );
  assert.ok(fixture.calls.some((call) => call.values?.includes("user-1")));
  assert.ok(
    !fixture.calls.some((call) =>
      call.sql.includes("UPDATE agent_control.machines"),
    ),
  );
  assert.equal(fixture.calls.at(-1)?.sql, "COMMIT");
  assert.ok(fixture.released());
});

test("invalid names are rejected before database access", async () => {
  const fixture = setup();
  for (const name of [
    null,
    undefined,
    123,
    "",
    "   ",
    "x".repeat(161),
    "bad\nname",
    "bad\0name",
  ]) {
    await assert.rejects(
      fixture.repository.renameAgent("org-1", "agent-a", name),
      { code: "agent_name_invalid", statusCode: 400 },
    );
  }
  assert.equal(fixture.calls.length, 0);
});

test("missing agents and failed audits roll back and release the connection", async () => {
  const missing = setup(0);
  await assert.rejects(
    missing.repository.renameAgent("wrong-org", "agent-a", "New name"),
    { code: "agent_not_found", statusCode: 404 },
  );
  assert.equal(missing.calls.at(-1)?.sql, "ROLLBACK");
  assert.ok(missing.released());
  const failed = setup(1, true);
  await assert.rejects(
    failed.repository.renameAgent("org-1", "agent-a", "New name"),
    /Audit unavailable/,
  );
  assert.equal(failed.calls.at(-1)?.sql, "ROLLBACK");
  assert.ok(failed.released());
});
