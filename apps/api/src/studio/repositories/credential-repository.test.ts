import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { encryptString } from "@beam-studio/vault";
import { CredentialRepository } from "./credential-repository.js";
import { organizationScope } from "./organization-scope.js";

const secret = "0".repeat(64);
const vault = () => secret;

type Executed = { sql: string; values: unknown[] };

/**
 * A pool that records every statement and answers from a table keyed by the
 * organization column, so a predicate that fails to filter is visible as a row
 * the caller was never entitled to.
 */
function fakePool(
  respond: (executed: Executed) => { rows: unknown[]; rowCount?: number },
) {
  const executed: Executed[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    executed.push({ sql, values });
    const result = respond({ sql, values });
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  };
  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
  } as unknown as PgPool;
  return { pool, executed };
}

test("listing filters on the organization by equality, with no widening value", async () => {
  const { pool, executed } = fakePool(() => ({ rows: [] }));
  await new CredentialRepository(pool, vault).list(
    organizationScope("org_alpha"),
  );
  const [statement] = executed;
  assert.ok(statement, "a statement must run");
  assert.match(statement.sql, /c\.organization_id = \$1/);
  // The store's form was `($1 = '' OR c.organization_id = $1)`, where the
  // empty string disabled the filter entirely.
  assert.doesNotMatch(statement.sql, /\$1 = ''/);
  assert.deepEqual(statement.values, ["org_alpha"]);
});

test("the decrypted payload is scoped, and a foreign credential yields nothing", async () => {
  const stored = encryptString(JSON.stringify({ api_key: "secret" }), secret);
  const { pool } = fakePool(({ values }) =>
    values[1] === "org_alpha"
      ? { rows: [{ encrypted_payload: stored }] }
      : { rows: [] },
  );
  const repository = new CredentialRepository(pool, vault);

  assert.deepEqual(await repository.payload(organizationScope("org_alpha"), "cred_1"), {
    api_key: "secret",
  });
  assert.equal(
    await repository.payload(organizationScope("org_beta"), "cred_1"),
    null,
  );
});

test("revoking a credential owned by another organization changes nothing", async () => {
  // The store ran the credential UPDATE with an organization predicate and the
  // versions UPDATE without one, so a caller in another organization left the
  // credential active while revoking every one of its versions — silently
  // breaking a tenant whose data it could not otherwise touch.
  const { pool, executed } = fakePool(({ sql }) =>
    sql.includes("room_storage_bindings") ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 },
  );
  const revoked = await new CredentialRepository(pool, vault).revoke(
    organizationScope("org_beta"),
    "cred_owned_by_alpha",
  );

  assert.equal(revoked, false, "a foreign credential must not report a revoke");
  assert.equal(
    executed.filter((statement) =>
      statement.sql.includes("secrets.credential_versions"),
    ).length,
    0,
    "the versions must not be touched once the credential did not match",
  );
  assert.ok(
    executed.some((statement) => statement.sql.includes("ROLLBACK")) === false,
    "a miss is not an error",
  );
});

test("revoking an owned credential revokes it and its active versions", async () => {
  const { pool, executed } = fakePool(({ sql }) => {
    if (sql.includes("room_storage_bindings")) return { rows: [], rowCount: 0 };
    if (sql.includes("beam_studio_instance")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });
  const revoked = await new CredentialRepository(pool, vault).revoke(
    organizationScope("org_alpha"),
    "cred_1",
  );

  assert.equal(revoked, true);
  const update = executed.find((statement) =>
    statement.sql.includes("UPDATE secrets.credentials"),
  );
  assert.ok(update, "the credential must be updated");
  assert.deepEqual(update.values.slice(0, 2), ["cred_1", "org_alpha"]);
  assert.match(update.sql, /organization_id = \$2/);
  assert.ok(
    executed.some((statement) =>
      statement.sql.includes("secrets.credential_versions"),
    ),
    "its versions must be revoked too",
  );
});

test("a credential attached to a room storage binding is refused", async () => {
  const { pool } = fakePool(({ sql }) =>
    sql.includes("room_storage_bindings")
      ? { rows: [{ "?column?": 1 }], rowCount: 1 }
      : sql.includes("beam_studio_instance")
        ? { rows: [], rowCount: 0 }
        : { rows: [], rowCount: 1 },
  );
  await assert.rejects(
    () =>
      new CredentialRepository(pool, vault).revoke(
        organizationScope("org_alpha"),
        "cred_1",
      ),
    /room storage member/,
  );
});

test("the Studio instance key cannot be deleted as a credential", async () => {
  const { pool, executed } = fakePool(({ sql }) =>
    sql.includes("beam_studio_instance")
      ? { rows: [{ "?column?": 1 }], rowCount: 1 }
      : { rows: [], rowCount: 1 },
  );
  await assert.rejects(
    () =>
      new CredentialRepository(pool, vault).revoke(
        organizationScope("org_alpha"),
        "cred_instance",
      ),
    { code: "credential_managed_by_studio", statusCode: 409 },
  );
  assert.equal(
    executed.some((statement) =>
      statement.sql.includes("UPDATE secrets.credentials"),
    ),
    false,
    "the key must stay live here until Settings → Access revokes it at Beam",
  );
});
