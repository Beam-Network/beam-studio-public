import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { createHash } from "node:crypto";
import { buildServer } from "../server.js";
import { admittedInstance } from "./instance-admission.fixture.js";

const TOKEN = "beam_mcp_test0000000000000000000000000000000";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

/**
 * A pool that answers the token lookup and nothing else, so these tests
 * exercise the auth decision rather than a handler's data access.
 */
function poolWithToken(
  scopes: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM mcp.tokens") && values?.[0] === TOKEN_HASH) {
        return {
          rows: [
            {
              id: "mcp_test",
              organization_id: "org_alpha",
              project_id: null,
              scopes_json: scopes,
              ...overrides,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PgPool;
}

const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

async function withServer(
  pool: PgPool,
  run: (server: Awaited<ReturnType<typeof buildServer>>) => Promise<void>,
) {
  const server = await buildServer({
    pgPool: pool,
    admission: admittedInstance(["org_alpha"]),
  });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

test("a scoped token reaches a route that grants its scope", async () => {
  await withServer(poolWithToken(["read:runs"]), async (server) => {
    const response = await server.inject({
      method: "GET",
      url: "/studio/runs",
      headers: bearer(),
    });
    // Not 401: the token authenticated. The handler's own outcome is not
    // what this asserts.
    assert.notEqual(response.statusCode, 401, response.body);
  });
});

test("a token without the route's scope is refused", async () => {
  await withServer(poolWithToken(["read:transfers"]), async (server) => {
    const response = await server.inject({
      method: "GET",
      url: "/studio/runs",
      headers: bearer(),
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.match(response.json().code, /^machine_scope_required:read:runs$/);
  });
});

test("an unknown token is refused", async () => {
  await withServer(poolWithToken(["read:runs"]), async (server) => {
    const response = await server.inject({
      method: "GET",
      url: "/studio/runs",
      headers: bearer("beam_mcp_not_a_real_token"),
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "machine_token_invalid");
  });
});

test("a revoked or expired token is refused", async () => {
  // The lookup filters on revoked_at and expires_at, so a revoked token
  // simply does not come back.
  const empty = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as PgPool;
  await withServer(empty, async (server) => {
    const response = await server.inject({
      method: "GET",
      url: "/studio/runs",
      headers: bearer(),
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "machine_token_invalid");
  });
});

test("a token cannot reach a route that grants no machine access", async () => {
  // The assistant can execute operation plans, and the MCP admin routes would
  // let a token mint another one. Neither opts in, so the token is not even
  // consulted and the request falls through to requiring a session.
  await withServer(
    poolWithToken(["read:runs", "write:workflows"]),
    async (server) => {
      for (const url of ["/studio/assistant/conversations", "/studio/mcp"]) {
        const response = await server.inject({
          method: "GET",
          url,
          headers: bearer(),
        });
        assert.equal(response.statusCode, 401, `${url} -> ${response.body}`);
        assert.equal(response.json().code, "studio_session_required");
      }
    },
  );
});

test("the organization comes from the token, not from a header", async () => {
  // Otherwise a token could be pointed at another tenant by changing a
  // request header.
  await withServer(poolWithToken(["read:runs"]), async (server) => {
    const response = await server.inject({
      method: "GET",
      url: "/studio/runs",
      headers: { ...bearer(), "x-organization-id": "org_someone_else" },
    });
    assert.notEqual(response.statusCode, 401);
    assert.notEqual(response.statusCode, 403);
  });
});

test("a token is refused once Beam revokes its organization", async () => {
  // The token itself is still valid and unexpired; it is the organization
  // that lost standing, which the token row cannot express.
  const server = await buildServer({
    pgPool: poolWithToken(["read:runs"]),
    admission: admittedInstance(["org_alpha"]),
    authority: {
      check: async () => "revoked" as const,
      forget: () => {},
    },
  });
  try {
    const response = await server.inject({
      method: "GET",
      url: "/studio/runs",
      headers: bearer(),
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().code, "machine_token_organization_revoked");
  } finally {
    await server.close();
  }
});

test("a token still works when the organization cannot be checked", async () => {
  // No stored key, or Beam unreachable. The token's own expiry and
  // revocation remain the control; refusing here would take every machine
  // caller down with an upstream blip.
  const server = await buildServer({
    pgPool: poolWithToken(["read:runs"]),
    admission: admittedInstance(["org_alpha"]),
    authority: {
      check: async () => "unverified" as const,
      forget: () => {},
    },
  });
  try {
    const response = await server.inject({
      method: "GET",
      url: "/studio/runs",
      headers: bearer(),
    });
    assert.notEqual(response.statusCode, 401, response.body);
    assert.notEqual(response.statusCode, 403, response.body);
  } finally {
    await server.close();
  }
});

test("a non-Studio bearer is ignored rather than treated as a token", async () => {
  // Only beam_mcp_ values are machine tokens; anything else should fall
  // through to the session path and be refused as unauthenticated.
  await withServer(poolWithToken(["read:runs"]), async (server) => {
    const response = await server.inject({
      method: "GET",
      url: "/studio/runs",
      headers: { authorization: "Bearer some-other-credential" },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "studio_session_required");
  });
});
