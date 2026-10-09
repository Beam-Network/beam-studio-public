import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres")) {
  throw new Error(
    "Fresh organization acceptance requires isolated PostgreSQL.",
  );
}

// Studio learns organizations from Beam, so right after pairing the session
// knows the organization but identity.organizations has no row for it. Any
// write that can be an organization's first must create that row itself
// rather than fail the foreign key with a 500.
test(
  "first writes of an organization known only from the session succeed on a fresh database",
  { skip: !source?.startsWith("postgres"), timeout: 60_000 },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const previousUrl = process.env.DATABASE_URL;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `fresh_org_${randomBytes(6).toString("hex")}`;
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
      globals.__beamStudioPgPool = pool;

      const organizationRows = async (id: string) =>
        (
          await pool!.query(
            "SELECT count(*)::int AS count FROM identity.organizations WHERE id = $1",
            [id],
          )
        ).rows[0].count as number;
      for (const id of ["paired_org", "chat_org"]) {
        assert.equal(await organizationRows(id), 0, `${id} starts absent`);
      }

      const { buildServer } = await import("../server.js");
      const { createStudioBrowserSession, STUDIO_SESSION_COOKIE } =
        await import("../auth/browser-session.js");
      const services = {
        oauth: { hasSession: async () => true },
        beamApi: {
          getJson: async (path: string) =>
            path.startsWith("/api/organizations")
              ? {
                  organizations: [
                    { id: "paired_org", role: "admin" },
                    { id: "chat_org", role: "admin" },
                  ],
                }
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
      const headersFor = (organizationId: string) => ({
        "x-organization-id": organizationId,
        origin: "http://localhost:5173",
        cookie: `${STUDIO_SESSION_COOKIE}=${createStudioBrowserSession("fresh-organization-test-secret")}`,
      });

      const { instanceClaimCode } =
        await import("@beam-studio/shared/instance-claim");
      const claimed = await server.inject({
        method: "POST",
        url: "/studio/instance/claim",
        headers: headersFor("paired_org"),
        payload: {
          organizationId: "paired_org",
          claimCode: instanceClaimCode(),
        },
      });
      assert.equal(claimed.statusCode, 201, claimed.body);
      const admitted = await server.inject({
        method: "POST",
        url: "/studio/instance/access/organizations",
        headers: headersFor("paired_org"),
        payload: { organizationId: "chat_org" },
      });
      assert.equal(admitted.statusCode, 200, admitted.body);
      for (const id of ["paired_org", "chat_org"]) {
        assert.equal(await organizationRows(id), 0, `${id} still absent`);
      }

      // S14: MCP token creation was a 500 (23503 on tokens_organization_id_fkey).
      const created = await server.inject({
        method: "POST",
        url: "/studio/mcp/tokens",
        headers: headersFor("paired_org"),
        payload: { name: "First token", scopes: ["read:runs"] },
      });
      assert.equal(created.statusCode, 201, created.body);
      const { token, record } = created.json();
      assert.match(token, /\S+/);
      assert.equal(record.organizationId, "paired_org");
      assert.equal(await organizationRows("paired_org"), 1);

      const listed = await server.inject({
        method: "GET",
        url: "/studio/mcp",
        headers: headersFor("paired_org"),
      });
      assert.equal(listed.statusCode, 200, listed.body);
      assert.deepEqual(
        listed.json().tokens.map((entry: { id: string }) => entry.id),
        [record.id],
      );

      // A second token for the now-known organization still works.
      const second = await server.inject({
        method: "POST",
        url: "/studio/mcp/tokens",
        headers: headersFor("paired_org"),
        payload: { name: "Second token", scopes: ["read:runs"] },
      });
      assert.equal(second.statusCode, 201, second.body);

      // Same foreign key on assistant.conversations.
      const conversation = await server.inject({
        method: "POST",
        url: "/studio/assistant/conversations",
        headers: headersFor("chat_org"),
        payload: { title: "First conversation" },
      });
      assert.equal(conversation.statusCode, 200, conversation.body);
      assert.equal(await organizationRows("chat_org"), 1);
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
