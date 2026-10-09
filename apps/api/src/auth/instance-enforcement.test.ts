import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { PgPool } from "@beam-studio/db";
import { buildServer } from "../server.js";
import { StudioSessionManager } from "./session-manager.js";
import { admittedInstance } from "./instance-admission.fixture.js";

/**
 * A signed-in account this deployment does not serve.
 *
 * The gap these cases cover: Studio asked Beam whether an organization belonged
 * to the caller, which it did, and treated that as permission to use this
 * installation. Any Beam account could therefore sign into any reachable
 * Studio, select its own organization, and be handed a tenant on someone
 * else's hardware.
 */

const SESSION = "beam-studio.session=signed-in";
const TOKEN = "beam_mcp_test0000000000000000000000000000000";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

function sessions(organizationId: string, role = "owner") {
  const services = {
    oauth: { hasSession: async () => true, shutdown() {} },
    beamApi: {
      getJson: async (path: string) => {
        if (path === "/api/me") return { id: "user_1", platformRole: "USER" };
        if (path === "/api/organizations") {
          return { organizations: [{ id: organizationId, role }] };
        }
        if (path.startsWith("/api/projects")) return { projects: [] };
        throw new Error(`unexpected Beam API call ${path}`);
      },
    },
  };
  return {
    get: (cookie: string | null) => (cookie === "signed-in" ? services : null),
    shutdown() {},
  } as unknown as StudioSessionManager;
}

/** Records every statement, so a test can assert what was *not* written. */
function recordingPool(organizationId = "org_stranger") {
  const statements: string[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      if (sql.includes("FROM mcp.tokens") && values[0] === TOKEN_HASH) {
        return {
          rows: [
            {
              id: "mcp_test",
              organization_id: organizationId,
              project_id: null,
              scopes_json: ["read:runs"],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PgPool;
  return { pool, statements };
}

// Beam's verdict on the organization is not what these tests exercise, so the
// machine-token cases hold it at "unverified" and admission alone decides.
const unverifiedAuthority = {
  check: async () => "unverified" as const,
  forget: () => {},
};

const headers = (organizationId: string) => ({
  cookie: SESSION,
  "x-organization-id": organizationId,
});

test("an account whose organization this deployment does not admit is refused", async (t) => {
  const { pool, statements } = recordingPool();
  const server = await buildServer({
    pgPool: pool,
    sessions: sessions("org_stranger"),
    admission: admittedInstance(["org_owner"]),
  });
  t.after(async () => {
    await server.close();
  });

  const read = await server.inject({
    method: "GET",
    url: "/studio/credentials",
    headers: headers("org_stranger"),
  });
  assert.equal(read.statusCode, 403, read.body);
  assert.equal(read.json().code, "instance_organization_forbidden");

  const write = await server.inject({
    method: "POST",
    url: "/studio/mcp/tokens",
    headers: headers("org_stranger"),
    payload: { name: "mine" },
  });
  assert.equal(write.statusCode, 403, write.body);

  // The actual harm was not only the 403 that never happened: the stranger's
  // organization was materialised as a tenant row on first write. A fix that
  // returned 403 and still created the row would pass a status-code-only
  // assertion.
  const created = statements.filter((sql) =>
    sql.includes("INSERT INTO identity.organizations"),
  );
  assert.deepEqual(created, [], "a refused caller still became a tenant");
});

test("an admitted organization is served normally", async (t) => {
  const { pool } = recordingPool("org_owner");
  const server = await buildServer({
    pgPool: pool,
    sessions: sessions("org_owner"),
    admission: admittedInstance(["org_owner"]),
  });
  t.after(async () => {
    await server.close();
  });

  const response = await server.inject({
    method: "GET",
    url: "/studio/credentials",
    headers: headers("org_owner"),
  });
  assert.notEqual(response.statusCode, 403, response.body);
});

test("an unclaimed deployment serves nobody but the claim funnel", async (t) => {
  const { pool } = recordingPool("org_owner");
  const server = await buildServer({
    pgPool: pool,
    sessions: sessions("org_owner"),
    admission: admittedInstance(["org_owner"], { state: "unclaimed" }),
  });
  t.after(async () => {
    await server.close();
  });

  const refused = await server.inject({
    method: "GET",
    url: "/studio/credentials",
    headers: headers("org_owner"),
  });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, "instance_unclaimed");

  // Updating the host is the worst thing an unclaimed instance could offer a
  // stranger, so it is explicitly on the wrong side of this line.
  const updates = await server.inject({
    method: "GET",
    url: "/studio/updates/status",
    headers: headers("org_owner"),
  });
  assert.equal(updates.statusCode, 403, updates.body);

  // The funnel still answers, or the instance could never be claimed.
  const probe = await server.inject({
    method: "GET",
    url: "/studio/session",
    headers: { cookie: SESSION },
  });
  assert.equal(probe.statusCode, 200, probe.body);

  const organizations = await server.inject({
    method: "GET",
    url: "/studio/organizations",
    headers: { cookie: SESSION },
  });
  assert.equal(organizations.statusCode, 200, organizations.body);
});

test("a revoked organization is refused even while the policy is open", async (t) => {
  const { pool } = recordingPool("org_stranger");
  const server = await buildServer({
    pgPool: pool,
    sessions: sessions("org_stranger"),
    // Admitted list omits it, so the fixture reports no row; an open policy
    // would otherwise let it back in.
    admission: admittedInstance(["org_owner"], { joinPolicy: "open" }),
  });
  t.after(async () => {
    await server.close();
  });

  const response = await server.inject({
    method: "GET",
    url: "/studio/credentials",
    headers: headers("org_stranger"),
  });
  // An open instance admits browser callers on first use by design.
  assert.notEqual(response.statusCode, 403, response.body);
});

test("a machine token is refused when its organization is not admitted", async (t) => {
  const { pool } = recordingPool("org_stranger");
  const server = await buildServer({
    pgPool: pool,
    sessions: sessions("org_owner"),
    admission: admittedInstance(["org_owner"]),
    authority: unverifiedAuthority,
  });
  t.after(async () => {
    await server.close();
  });

  const response = await server.inject({
    method: "GET",
    url: "/studio/runs",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().code, "instance_organization_forbidden");
});

test("an open policy does not admit a machine token on its own", async (t) => {
  const { pool } = recordingPool("org_stranger");
  const server = await buildServer({
    pgPool: pool,
    sessions: sessions("org_owner"),
    admission: admittedInstance(["org_owner"], { joinPolicy: "open" }),
    authority: unverifiedAuthority,
  });
  t.after(async () => {
    await server.close();
  });

  // A token proves nothing about current Beam membership, so letting one
  // admit its own organization would let a token for an organization that has
  // since been removed quietly re-admit it.
  const response = await server.inject({
    method: "GET",
    url: "/studio/runs",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().code, "instance_organization_forbidden");
});

test("administering the deployment requires the owning organization", async (t) => {
  const { pool } = recordingPool("org_member");
  const server = await buildServer({
    pgPool: pool,
    sessions: sessions("org_member"),
    admission: admittedInstance(["org_owner", "org_member"], {
      ownerOrganizationId: "org_owner",
    }),
  });
  t.after(async () => {
    await server.close();
  });

  // Admitted, so it uses Studio; not the owner, so it cannot redeploy the host.
  const served = await server.inject({
    method: "GET",
    url: "/studio/credentials",
    headers: headers("org_member"),
  });
  assert.notEqual(served.statusCode, 403, served.body);

  const updates = await server.inject({
    method: "GET",
    url: "/studio/updates/status",
    headers: headers("org_member"),
  });
  assert.equal(updates.statusCode, 403, updates.body);
  assert.equal(updates.json().code, "instance_admin_required");
});
