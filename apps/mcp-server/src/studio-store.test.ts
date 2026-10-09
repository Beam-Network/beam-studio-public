import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import {
  openSynchronousPostgres,
  type SqlDatabase,
} from "@beam-studio/db";

loadEnv("../../.env.local");
loadEnv("../../.env");

const databaseUrl =
  process.env.MCP_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://beam:beam@127.0.0.1:5432/beam_studio";
process.env.DATABASE_URL = databaseUrl;
const database = openSynchronousPostgres(databaseUrl);

const store = await import("./studio-store.js");

// The instance row is a singleton the whole database shares; put it back.
const originalInstance = database
  .prepare(
    "SELECT state, owner_organization_id, join_policy FROM studio.instance WHERE id = 'singleton'",
  )
  .get();

beforeEach(async () => {
  cleanTestRows();
  serveOrganization("org_alpha");
  await store.authenticateMcpToken("missing");
});

after(() => {
  cleanTestRows();
  if (originalInstance) {
    database
      .prepare(
        `UPDATE studio.instance
            SET state = :state,
                owner_organization_id = :owner,
                join_policy = :joinPolicy
          WHERE id = 'singleton'`,
      )
      .run({
        state: originalInstance.state,
        owner: originalInstance.owner_organization_id,
        joinPolicy: originalInstance.join_policy,
      });
  }
  store.closeStudioStore();
  database.close?.();
});

test("authenticates active scoped MCP tokens and rejects expired tokens", async () => {
  insertToken({
    id: "mcp_active",
    token: "beam_mcp_active",
    organizationId: "org_alpha",
    scopes: ["read:runs"],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  insertToken({
    id: "mcp_expired",
    token: "beam_mcp_expired",
    organizationId: "org_alpha",
    scopes: ["read:runs"],
    expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
  });

  const auth = await store.authenticateMcpToken("beam_mcp_active");
  assert.equal(auth?.id, "mcp_active");
  assert.equal(auth?.organizationId, "org_alpha");
  assert.deepEqual(auth?.scopes, ["read:runs"]);
  assert.equal(await store.authenticateMcpToken("beam_mcp_expired"), null);
  assert.equal(await store.authenticateMcpToken("missing"), null);
});

test("refuses a token whose organization this deployment does not serve", async () => {
  // The MCP server validates tokens in its own process, so the API's admission
  // check does not cover it. Without this a token minted before an
  // organization was revoked would keep working here after it stopped working
  // everywhere else.
  insertToken({
    id: "mcp_active",
    token: "beam_mcp_unserved",
    organizationId: "org_unserved",
    scopes: ["read:runs"],
    expiresAt: null,
  });
  await assertRefused("beam_mcp_unserved", "org_unserved");
});

// The MCP server and the API share one admission authority. These pin the
// three instance states on this plane, because an earlier copy of the rules
// here admitted only on a claimed instance and so refused every token on every
// upgraded (adopted) installation while the API kept serving it.

test("an adopted instance serves its adopted organizations' tokens", async () => {
  // What the schema seeds on a database that already had organizations:
  // adopted, open, each existing organization recorded as admitted, no owner.
  setInstance({ state: "adopted", joinPolicy: "open", owner: null });
  admitOrganization("org_alpha", "member", "admitted");
  admitOrganization("org_revoked", "member", "revoked");
  insertToken(tokenFor("mcp_adopted", "org_alpha"));
  insertToken(tokenFor("mcp_unrecorded", "org_unserved"));
  insertToken(tokenFor("mcp_revoked", "org_revoked"));

  const auth = await store.authenticateMcpToken("beam_mcp_adopted");
  assert.equal(auth?.id, "mcp_adopted");
  assert.equal(auth?.organizationId, "org_alpha");
  // The open policy admits browser sessions, never a machine caller whose
  // organization was not recorded — exactly as the API decides it.
  await assertRefused("beam_mcp_unrecorded", "org_unserved");
  await assertRefused("beam_mcp_revoked", "org_revoked");
});

test("an unclaimed instance serves no token", async () => {
  setInstance({ state: "unclaimed", joinPolicy: "closed", owner: null });
  // Even a recorded admission does not count before anyone owns the instance.
  admitOrganization("org_alpha", "member", "admitted");
  insertToken(tokenFor("mcp_active", "org_alpha"));

  await assertRefused("beam_mcp_active", "org_alpha");
});

test("a claimed instance serves only its admitted organizations", async () => {
  setInstance({ state: "claimed", joinPolicy: "open", owner: "org_alpha" });
  admitOrganization("org_beta", "member", "admitted");
  admitOrganization("org_pending", "member", "pending");
  insertToken(tokenFor("mcp_active", "org_alpha"));
  insertToken(tokenFor("mcp_beta", "org_beta"));
  insertToken(tokenFor("mcp_pending", "org_pending"));
  insertToken(tokenFor("mcp_unrecorded", "org_unserved"));

  assert.equal(
    (await store.authenticateMcpToken("beam_mcp_active"))?.organizationId,
    "org_alpha",
  );
  assert.equal(
    (await store.authenticateMcpToken("beam_mcp_beta"))?.organizationId,
    "org_beta",
  );
  await assertRefused("beam_mcp_pending", "org_pending");
  await assertRefused("beam_mcp_unrecorded", "org_unserved");
});

test("the local and consumer organizations are always served", async () => {
  // The deployment acting as itself, whatever the instance state.
  const previous = process.env.BEAM_STUDIO_CONSUMER_ORGANIZATION_ID;
  process.env.BEAM_STUDIO_CONSUMER_ORGANIZATION_ID = "org_consumer";
  store.closeStudioStore();
  try {
    setInstance({ state: "unclaimed", joinPolicy: "closed", owner: null });
    insertToken(tokenFor("mcp_consumer", "org_consumer"));
    assert.equal(
      (await store.authenticateMcpToken("beam_mcp_consumer"))?.organizationId,
      "org_consumer",
    );
  } finally {
    if (previous === undefined)
      delete process.env.BEAM_STUDIO_CONSUMER_ORGANIZATION_ID;
    else process.env.BEAM_STUDIO_CONSUMER_ORGANIZATION_ID = previous;
    store.closeStudioStore();
  }
});

async function assertRefused(token: string, organizationId: string) {
  await assert.rejects(
    () => store.authenticateMcpToken(token),
    (error: unknown) =>
      error instanceof store.McpOrganizationNotAdmittedError &&
      error.code === "instance_organization_forbidden" &&
      error.statusCode === 403 &&
      error.organizationId === organizationId,
  );
}

function tokenFor(id: string, organizationId: string) {
  return {
    id,
    token: `beam_${id}`,
    organizationId,
    scopes: ["read:runs"],
    expiresAt: null,
  };
}

test("records MCP audit events", () => {
  insertToken({
    id: "mcp_active",
    token: "beam_mcp_active",
    organizationId: "org_alpha",
    scopes: ["read:runs"],
    expiresAt: null,
  });
  store.recordMcpAuditEvent({
    organizationId: "org_alpha",
    tokenId: "mcp_active",
    action: "tool",
    target: "beam.list_recent_runs",
    status: "success",
    ipAddress: "127.0.0.1",
    userAgent: "node:test",
    clientName: "test-client",
  });

  withDatabase((database) => {
    // The table is shared with every other writer of this database, so read
    // only the row this test recorded.
    const rows = database
      .prepare(
        `SELECT event_type, subject_id, metadata_json
           FROM mcp.audit_events
          WHERE token_id = :tokenId
            AND organization_id = :organizationId
            AND subject_id = 'beam.list_recent_runs'
          ORDER BY created_at DESC`,
      )
      .all({ tokenId: "mcp_active", organizationId: "org_alpha" }) as Array<
      Record<string, unknown>
    >;
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.event_type, "tool");
    assert.equal(row.subject_id, "beam.list_recent_runs");
    const metadata = row.metadata_json as Record<string, unknown>;
    assert.equal(metadata.status, "success");
    assert.equal(metadata.clientName, "test-client");
  });
});

test("lists legacy local API keys only to the organization using them", () => {
  const timestamp = new Date().toISOString();
  withDatabase((database) => {
    database
      .prepare(
        `INSERT INTO beam_api_keys (id, name, base_url, encrypted_api_key, created_at, updated_at)
         VALUES ('key_mcp_alpha', 'Alpha key', 'https://beam.example', 'x', :at, :at),
                ('key_mcp_unbound', 'Unbound key', 'https://beam.example', 'x', :at, :at)`,
      )
      .run({ at: timestamp });
    database
      .prepare(
        `INSERT INTO transfer_templates (id, organization_id, name, api_key_id, created_at, updated_at)
         VALUES ('tpl_mcp_keys', 'org_alpha', 'Keyed transfer', 'key_mcp_alpha', :at, :at)`,
      )
      .run({ at: timestamp });
  });
  const legacyIds = (organizationId: string) =>
    store
      .listApiKeys({ organizationId })
      .map((key) => key.id)
      .filter((id) => id.startsWith("key_mcp_"))
      .sort();

  assert.deepEqual(legacyIds("org_alpha"), ["key_mcp_alpha"]);
  assert.deepEqual(legacyIds("org_beta"), []);
  assert.deepEqual(legacyIds("__local__"), [
    "key_mcp_alpha",
    "key_mcp_unbound",
  ]);
});

test("reads transfer status from the Studio run recorded for a Beam transfer", () => {
  const timestamp = new Date().toISOString();
  withDatabase((database) => {
    database
      .prepare(
        `
        INSERT INTO transfer_templates (
          id, organization_id, name, api_key_id, created_at, updated_at
        )
        VALUES (
          :id, :organizationId, :name, :apiKeyId, :createdAt, :updatedAt
        )
        `,
      )
      .run({
        id: "tpl_mcp_status",
        organizationId: "org_alpha",
        name: "MCP status transfer",
        apiKeyId: "key_registry_action",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    database
      .prepare(
        `
        INSERT INTO runs (
          id, transfer_template_id, status, created_at, updated_at,
          beam_transfer_id, trigger
        )
        VALUES (
          :id, :transferTemplateId, :status, :createdAt, :updatedAt,
          :beamTransferId, :trigger
        )
        `,
      )
      .run({
        id: "run_mcp_status",
        transferTemplateId: "tpl_mcp_status",
        status: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
        beamTransferId: "beam_transfer_mcp_status",
        trigger: "manual",
      });
  });

  const result = store.getRunByBeamTransferId(
    "beam_transfer_mcp_status",
    "org_alpha",
  );
  assert.equal(result?.run.id, "run_mcp_status");
  assert.equal(result?.run.status, "completed");
  assert.equal(result?.run.beamTransferId, "beam_transfer_mcp_status");
  assert.equal(
    store.getRunByBeamTransferId("beam_transfer_mcp_status", "org_other"),
    null,
  );
});

function insertToken(input: {
  id: string;
  token: string;
  organizationId: string;
  scopes: string[];
  expiresAt: string | null;
}) {
  withDatabase((database) => {
    const timestamp = new Date().toISOString();
    // mcp.tokens has a foreign key to identity.organizations that the legacy
    // public.mcp_tokens did not.
    database
      .prepare(
        `
        INSERT INTO identity.organizations (id, slug, name, created_at, updated_at)
        VALUES (:id, :slug, :name, :createdAt, :updatedAt)
        ON CONFLICT (id) DO NOTHING
        `,
      )
      .run({
        id: input.organizationId,
        slug: input.organizationId,
        name: input.organizationId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    database
      .prepare(
        `
        INSERT INTO mcp.tokens (
          id, organization_id, name, token_hash, prefix, scopes_json,
          expires_at, created_at, updated_at, last_used_at, revoked_at
        )
        VALUES (
          :id, :organizationId, :name, :tokenHash, :tokenPrefix, :scopes,
          :expiresAt, :createdAt, :updatedAt, NULL, NULL
        )
        `,
      )
      .run({
        id: input.id,
        organizationId: input.organizationId,
        name: input.id,
        tokenHash: createHash("sha256").update(input.token).digest("hex"),
        tokenPrefix: input.token.slice(0, 18),
        scopes: JSON.stringify(input.scopes),
        expiresAt: input.expiresAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
  });
}

function withDatabase<T>(callback: (database: SqlDatabase) => T) {
  return callback(database);
}

const TEST_TOKEN_IDS = [
  "mcp_active",
  "mcp_expired",
  "mcp_adopted",
  "mcp_unrecorded",
  "mcp_revoked",
  "mcp_beta",
  "mcp_pending",
  "mcp_consumer",
]
  .map((id) => `'${id}'`)
  .join(", ");
const TEST_ORGANIZATION_IDS = [
  "org_alpha",
  "org_beta",
  "org_unserved",
  "org_revoked",
  "org_pending",
  "org_consumer",
]
  .map((id) => `'${id}'`)
  .join(", ");

function cleanTestRows() {
  database.exec(
    `
    DELETE FROM mcp.audit_events
    WHERE token_id IN (${TEST_TOKEN_IDS})
       OR subject_id = 'beam.list_recent_runs';
    DELETE FROM mcp.tokens
    WHERE id IN (${TEST_TOKEN_IDS});
    DELETE FROM runs WHERE id = 'run_mcp_status';
    DELETE FROM transfer_templates WHERE id IN ('tpl_mcp_status', 'tpl_mcp_keys');
    DELETE FROM beam_api_keys WHERE id IN ('key_mcp_alpha', 'key_mcp_unbound');
    DELETE FROM studio.instance_organizations
    WHERE organization_id IN (${TEST_ORGANIZATION_IDS});
    `,
  );
}

/** Marks this deployment as claimed and serving one organization. */
function serveOrganization(organizationId: string) {
  database.exec(
    `
    INSERT INTO studio.instance (id, state, owner_organization_id, join_policy)
    VALUES ('singleton', 'claimed', '${organizationId}', 'closed')
    ON CONFLICT (id) DO UPDATE
    SET state = 'claimed',
        owner_organization_id = EXCLUDED.owner_organization_id;
    INSERT INTO studio.instance_organizations (organization_id, role, status)
    VALUES ('${organizationId}', 'owner', 'admitted')
    ON CONFLICT (organization_id) DO UPDATE SET status = 'admitted';
    `,
  );
}

function setInstance(input: {
  state: "unclaimed" | "adopted" | "claimed";
  joinPolicy: "open" | "request" | "closed";
  owner: string | null;
}) {
  database
    .prepare(
      `UPDATE studio.instance
          SET state = :state,
              owner_organization_id = :owner,
              join_policy = :joinPolicy
        WHERE id = 'singleton'`,
    )
    .run(input);
  if (input.state !== "claimed") {
    // Only the claim makes an organization the owner.
    database.exec(
      `DELETE FROM studio.instance_organizations
        WHERE organization_id IN (${TEST_ORGANIZATION_IDS})`,
    );
  }
}

function admitOrganization(
  organizationId: string,
  role: "owner" | "member",
  status: "admitted" | "pending" | "revoked",
) {
  database
    .prepare(
      `INSERT INTO studio.instance_organizations (organization_id, role, status)
       VALUES (:organizationId, :role, :status)
       ON CONFLICT (organization_id) DO UPDATE
       SET role = EXCLUDED.role, status = EXCLUDED.status`,
    )
    .run({ organizationId, role, status });
}

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) {
      const [, key, rawValue] = match;
      if (key && rawValue !== undefined) {
        process.env[key] ??= rawValue.replace(/^(['"])(.*)\1$/, "$2");
      }
    }
  }
}
