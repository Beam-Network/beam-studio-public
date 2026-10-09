import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  LEGACY_PRODUCT_TABLES,
  type PgPool,
} from "@beam-studio/db";
import { encryptString, vaultSecretFromEnv } from "@beam-studio/vault";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres")) {
  throw new Error("Fresh database acceptance requires isolated PostgreSQL.");
}

test(
  "Studio routes work on a database bootstrapped only from the target schema",
  { skip: !source?.startsWith("postgres"), timeout: 60_000 },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const previousUrl = process.env.DATABASE_URL;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `fresh_studio_${randomBytes(6).toString("hex")}`;
    const globals = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
      __beamStudioDb?: { close?: () => void };
    };
    const previousPool = globals.__beamStudioPgPool;
    let pool: PgPool | undefined;
    let server: FastifyInstance | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      const legacy = await pool.query(
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
        [[...LEGACY_PRODUCT_TABLES]],
      );
      assert.deepEqual(
        legacy.rows,
        [],
        "the target schema has no legacy tables",
      );

      await pool.query(
        "INSERT INTO identity.organizations(id,slug,name) VALUES('fresh_a','fresh-a','Fresh A')",
      );
      await pool.query(
        "INSERT INTO secrets.credential_types(id,slug,display_name) VALUES('credential_type:beam_api_key','beam_api_key','Beam API key')",
      );
      await pool.query(
        "INSERT INTO secrets.credentials(id,organization_id,credential_type_id,name) VALUES('fresh_key','fresh_a','credential_type:beam_api_key','Billing key')",
      );
      await pool.query(
        "INSERT INTO secrets.credential_versions(id,credential_id,version,encrypted_payload,encryption_key_id) VALUES('fresh_key_v1','fresh_key',1,$1,'local')",
        [
          encryptString(
            JSON.stringify({ api_key: "beam_fresh_test_key" }),
            vaultSecretFromEnv(),
          ),
        ],
      );
      globals.__beamStudioPgPool = pool;

      const { buildServer } = await import("../server.js");
      const { createStudioBrowserSession, STUDIO_SESSION_COOKIE } =
        await import("../auth/browser-session.js");
      const services = {
        oauth: { hasSession: async () => true },
        beamApi: {
          getJson: async (path: string) =>
            path.startsWith("/api/organizations")
              ? { organizations: [{ id: "fresh_a", role: "admin" }] }
              : path.startsWith("/api/projects")
                ? { projects: [] }
                : {
                    id: "fresh-user",
                    email: "fresh@localhost",
                    accountType: "admin",
                  },
        },
      };
      server = await buildServer({
        pgPool: pool,
        sessions: {
          get: (cookie: string | null) => (cookie ? services : null),
          shutdown: () => {},
        } as never,
      });
      const headers = {
        "x-organization-id": "fresh_a",
        origin: "http://localhost:5173",
        cookie: `${STUDIO_SESSION_COOKIE}=${createStudioBrowserSession("fresh-database-test-secret")}`,
      };
      const { instanceClaimCode } =
        await import("@beam-studio/shared/instance-claim");
      const claimed = await server.inject({
        method: "POST",
        url: "/studio/instance/claim",
        headers,
        payload: { organizationId: "fresh_a", claimCode: instanceClaimCode() },
      });
      assert.equal(claimed.statusCode, 201, claimed.body);
      const get = async (path: string) => {
        const response = await server!.inject({
          method: "GET",
          url: path,
          headers,
        });
        assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
        return response.json();
      };

      const state = await get("/studio/state");
      assert.equal(state.organizationId, "fresh_a");
      assert.deepEqual(
        state.apiKeys.map((key: { id: string }) => key.id),
        ["fresh_key"],
        "Beam API keys come from credentials",
      );
      for (const key of ["transfers", "schedules", "runs", "logs"]) {
        assert.deepEqual(state[key], [], key);
      }
      assert.equal(state.summary.transferCount, 0);
      assert.equal(state.summary.runCount, 0);

      assert.deepEqual(await get("/studio/schedules"), {
        schedules: [],
        transfers: [],
      });
      assert.deepEqual(await get("/studio/transfers"), { transfers: [] });
      for (const view of ["", "?view=queue", "?view=dead-letter"]) {
        assert.deepEqual(await get(`/studio/runs${view}`), { runs: [] });
      }
      assert.deepEqual(await get("/studio/reports/runs"), { runs: [] });
      assert.equal((await get("/studio/dashboard")).organizationId, "fresh_a");
      const context = await get("/studio/assistant/context");
      assert.deepEqual(context.transfers, []);
      assert.deepEqual(context.schedules, []);
      assert.deepEqual(
        context.beamConnections.map((key: { id: string }) => key.id),
        ["fresh_key"],
      );

      const missingRun = await server.inject({
        method: "GET",
        url: "/studio/runs/run_missing",
        headers,
      });
      assert.equal(missingRun.statusCode, 404);

      for (const request of [
        {
          method: "POST" as const,
          url: "/studio/schedules",
          payload: { transferTemplateId: "tpl_missing", frequency: "daily" },
        },
        {
          method: "POST" as const,
          url: "/studio/api-keys",
          payload: { name: "Key", baseUrl: "https://b1m.ai", apiKey: "k" },
        },
        { method: "DELETE" as const, url: "/studio/api-keys/fresh_key" },
        { method: "POST" as const, url: "/studio/runs/run_missing/cancel" },
      ]) {
        const response: LightMyRequestResponse = await server.inject({
          ...request,
          headers,
        });
        assert.equal(
          response.statusCode,
          410,
          `${request.method} ${request.url}: ${response.body}`,
        );
        assert.equal(response.json().code, "legacy_product_retired");
      }
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM secrets.credentials WHERE id='fresh_key'",
          )
        ).rows[0].count,
        1,
        "the legacy delete route does not touch credentials",
      );
    } finally {
      await server?.close();
      globals.__beamStudioDb?.close?.();
      delete globals.__beamStudioDb;
      globals.__beamStudioPgPool = previousPool;
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
