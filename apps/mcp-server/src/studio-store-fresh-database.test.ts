import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { encryptString, vaultSecretFromEnv } from "@beam-studio/vault";

const source =
  process.env.BEAM_TEST_POSTGRES_URL ??
  process.env.MCP_TEST_DATABASE_URL ??
  process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres")) {
  throw new Error("Fresh database acceptance requires isolated PostgreSQL.");
}

test(
  "MCP store reads succeed on a database bootstrapped only from the target schema",
  { skip: !source?.startsWith("postgres"), timeout: 60_000 },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const previousUrl = process.env.DATABASE_URL;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `fresh_mcp_${randomBytes(6).toString("hex")}`;
    let pool: PgPool | undefined;
    let store: typeof import("./studio-store.js") | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      await pool.query(
        "INSERT INTO identity.organizations(id,slug,name) VALUES('mcp_a','mcp-a','A'),('mcp_b','mcp-b','B')",
      );
      await pool.query(
        "INSERT INTO secrets.credential_types(id,slug,display_name) VALUES('credential_type:beam_api_key','beam_api_key','Beam API key')",
      );
      await pool.query(
        `INSERT INTO secrets.credentials(id,organization_id,credential_type_id,name,metadata_json)
         VALUES('mcp_key','mcp_a','credential_type:beam_api_key','Billing key','{"baseUrl":"https://beam.example"}')`,
      );
      await pool.query(
        "INSERT INTO secrets.credential_versions(id,credential_id,version,encrypted_payload,encryption_key_id) VALUES('mcp_key_v1','mcp_key',1,$1,'local')",
        [
          encryptString(
            JSON.stringify({ api_key: "beam_mcp_test_key" }),
            vaultSecretFromEnv(),
          ),
        ],
      );

      store = await import("./studio-store.js");
      const apiKeys = store.listApiKeys({ organizationId: "mcp_a" });
      assert.deepEqual(
        apiKeys.map(({ id, baseUrl, secretAvailable }) => ({
          id,
          baseUrl,
          secretAvailable,
        })),
        [
          {
            id: "mcp_key",
            baseUrl: "https://beam.example",
            secretAvailable: true,
          },
        ],
      );
      assert.deepEqual(store.listApiKeys({ organizationId: "mcp_b" }), []);
      assert.deepEqual(
        store.listCredentials({ organizationId: "mcp_a" }).map((c) => c.id),
        ["mcp_key"],
      );
      assert.deepEqual(
        store.listRuns({ organizationId: "mcp_a", limit: 20 }),
        [],
      );
      assert.deepEqual(
        store.listTransfers({ organizationId: "mcp_a", limit: 50 }),
        [],
      );
      assert.deepEqual(store.listSchedules({ organizationId: "mcp_a" }), []);
      assert.equal(store.getRun("run_missing", "mcp_a"), null);
      assert.equal(store.getTransfer("tpl_missing", "mcp_a"), null);
      assert.equal(
        store.getRunByBeamTransferId("beam_transfer_missing", "mcp_a"),
        null,
      );

      for (const write of [
        () =>
          store!.createTransfer({
            organizationId: "mcp_a",
            name: "Transfer",
            apiKeyId: "mcp_key",
            notifyOnStart: false,
            notifyOnSuccess: true,
            notifyOnFailure: true,
            notifyOnCancel: true,
            enabled: false,
          }),
        () =>
          store!.createSchedule({
            organizationId: "mcp_a",
            transferTemplateId: "tpl_missing",
            frequency: "daily",
            enabled: true,
          }),
        () => store!.startRun("tpl_missing", "mcp_a"),
        () => store!.cancelRun("run_missing", "mcp_a"),
      ]) {
        assert.throws(write, {
          name: "LegacyProductRetiredError",
          statusCode: 410,
        });
      }
    } finally {
      store?.closeStudioStore();
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
      if (previousAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previousAllow;
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
  },
);
