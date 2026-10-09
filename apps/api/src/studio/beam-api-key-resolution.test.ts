import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { encryptString, vaultSecretFromEnv } from "@beam-studio/vault";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres")) {
  throw new Error(
    "Beam API key resolution acceptance requires isolated PostgreSQL in CI.",
  );
}

// Room creation, workflow billing, the action gate and storage jobs all resolve
// the Beam API key through getDecryptedApiKey. The target schema has no
// public.beam_api_keys, so the credential must be found without touching it.
test(
  "Beam API keys resolve from credentials on a target-schema-only database",
  { skip: !source?.startsWith("postgres") },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const previousUrl = process.env.DATABASE_URL;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `api_key_resolution_${randomBytes(6).toString("hex")}`;
    const globals = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
      __beamStudioDb?: { close?: () => void };
    };
    let pool: PgPool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      assert.equal(
        (await pool.query("SELECT to_regclass('public.beam_api_keys') AS name"))
          .rows[0].name,
        null,
        "the target schema does not recreate the legacy key table",
      );
      await pool.query(
        "INSERT INTO identity.organizations(id,slug,name) VALUES('org_a','org-a','A'),('org_b','org-b','B')",
      );
      await pool.query(
        "INSERT INTO secrets.credential_types(id,slug,display_name) VALUES('credential_type:beam_api_key','beam_api_key','Beam API key')",
      );
      await pool.query(
        "INSERT INTO secrets.credentials(id,organization_id,credential_type_id,name) VALUES('cred_key','org_a','credential_type:beam_api_key','Billing key')",
      );
      await pool.query(
        "INSERT INTO secrets.credential_versions(id,credential_id,version,encrypted_payload,encryption_key_id) VALUES('cred_key_v1','cred_key',1,$1,'local')",
        [
          encryptString(
            JSON.stringify({ api_key: "beam_test_only_key" }),
            vaultSecretFromEnv(),
          ),
        ],
      );
      globals.__beamStudioPgPool = pool;

      const store = await import("./store.js");
      assert.equal(
        await store.getDecryptedApiKey("cred_key", "org_a"),
        "beam_test_only_key",
      );
      assert.equal(
        await store.getDecryptedApiKey("cred_key", "org_b"),
        null,
        "a key is never resolved across organizations",
      );
      assert.equal(
        await store.getDecryptedApiKey("missing_key", "org_a"),
        null,
        "an unknown key is absent rather than a missing-relation error",
      );
      assert.equal(
        await store.organizationBeamApiKey("org_a"),
        "beam_test_only_key",
      );

      // Execution authorization and workflow billing read a run's key through
      // one filter: the organization, project, expiry and version must all
      // still admit it.
      const executionKey = (
        overrides: {
          organizationId?: string;
          projectId?: string | null;
        } = {},
      ) =>
        store.executionBeamApiKey(pool!, {
          credentialId: "cred_key",
          organizationId: "org_a",
          projectId: null,
          ...overrides,
        });
      assert.equal(await executionKey(), "beam_test_only_key");
      assert.equal(
        await executionKey({ projectId: "any_project" }),
        "beam_test_only_key",
        "an organization-wide key serves every project",
      );
      assert.equal(await executionKey({ organizationId: "org_b" }), null);
      await pool.query(
        "UPDATE secrets.credentials SET expires_at=now()-interval '1 minute' WHERE id='cred_key'",
      );
      assert.equal(await executionKey(), null, "an expired key is refused");
      await pool.query(
        "UPDATE secrets.credentials SET expires_at=NULL WHERE id='cred_key'",
      );
      await pool.query(
        "UPDATE secrets.credential_versions SET revoked_at=now() WHERE id='cred_key_v1'",
      );
      assert.equal(await executionKey(), null, "a revoked version is refused");
    } finally {
      globals.__beamStudioDb?.close?.();
      delete globals.__beamStudioDb;
      delete globals.__beamStudioPgPool;
      if (pool) await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      if (previousAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previousAllow;
    }
  },
);
