import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { MCP_ADMIN_SCOPES } from "@beam-studio/shared";
import { McpTokenRepository } from "./mcp-token-repository.js";
import { organizationScope } from "./organization-scope.js";

type Executed = { sql: string; values: unknown[] };

function fakePool() {
  const executed: Executed[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    executed.push({ sql, values });
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
  } as unknown as PgPool;
  return { pool, executed };
}

const scope = organizationScope("org_alpha");

const tokenInsert = (executed: Executed[]) =>
  executed.find(({ sql }) => sql.includes("INSERT INTO mcp.tokens"));

test("a misspelled scope is refused rather than silently granting admin", async () => {
  const { pool, executed } = fakePool();
  await assert.rejects(
    new McpTokenRepository(pool).create(scope, {
      name: "ci",
      scopes: ["read:runs", "write:transfer"],
    }),
    (error: Error & { statusCode?: number; code?: string }) => {
      assert.match(error.message, /Unknown MCP scope: write:transfer/);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "mcp_scopes_invalid");
      return true;
    },
  );
  assert.deepEqual(executed, [], "nothing may be written for a rejected scope");
});

test("an empty scope list is refused", async () => {
  const { pool, executed } = fakePool();
  await assert.rejects(
    new McpTokenRepository(pool).create(scope, { name: "ci", scopes: [] }),
    /Select at least one MCP scope/,
  );
  assert.deepEqual(executed, []);
});

test("a valid subset is persisted exactly as requested", async () => {
  const { pool, executed } = fakePool();
  const { record } = await new McpTokenRepository(pool).create(scope, {
    name: "ci",
    scopes: ["read:runs", "cancel:runs"],
  });

  assert.deepEqual(record.scopes, ["read:runs", "cancel:runs"]);
  const insert = tokenInsert(executed);
  assert.ok(insert, "the token must be written");
  // The persisted column must match the request; it previously widened to the
  // full admin set whenever normalization could not recognise every entry.
  assert.equal(
    insert.values[5],
    JSON.stringify(["read:runs", "cancel:runs"]),
    "the stored scope set must be the requested subset",
  );
  assert.notEqual(insert.values[5], JSON.stringify(MCP_ADMIN_SCOPES));
});

test("admin is granted only when every scope is asked for", async () => {
  const { pool, executed } = fakePool();
  await new McpTokenRepository(pool).create(scope, {
    name: "admin",
    scopes: [...MCP_ADMIN_SCOPES],
  });
  assert.equal(
    tokenInsert(executed)?.values[5],
    JSON.stringify(MCP_ADMIN_SCOPES),
  );
});

// mcp.tokens references identity.organizations, and after pairing nothing has
// written the organization yet, so the insert alone fails with 23503.
test("the organization row is ensured before the token is inserted", async () => {
  const { pool, executed } = fakePool();
  await new McpTokenRepository(pool).create(scope, {
    name: "first",
    scopes: ["read:runs"],
  });
  const ensure = executed.findIndex(({ sql }) =>
    sql.includes("INSERT INTO identity.organizations"),
  );
  assert.notEqual(ensure, -1, "the organization row must be ensured");
  assert.equal(executed[ensure]?.values[0], "org_alpha");
  assert.ok(
    ensure < executed.indexOf(tokenInsert(executed)!),
    "the organization must exist before the token references it",
  );
});
