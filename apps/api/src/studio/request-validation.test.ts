import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres")) {
  throw new Error(
    "Request validation acceptance requires isolated PostgreSQL.",
  );
}

// Malformed Studio requests must be client errors that name what was wrong,
// never a TypeError or an unhandled lookup surfacing as a 500.
test(
  "Studio rejects malformed endpoint and credential requests with 400",
  { skip: !source?.startsWith("postgres"), timeout: 60_000 },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const previousUrl = process.env.DATABASE_URL;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `request_validation_${randomBytes(6).toString("hex")}`;
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
      // The legacy transfer endpoints live in the pre-cutover tables.
      await pool.query(
        readFileSync(
          new URL(
            "../../../../packages/db/src/postgres-migrations/0008_legacy_product_state.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await pool.query(`
        INSERT INTO identity.organizations(id, slug, name)
          VALUES ('org_v', 'org-v', 'Org V'), ('org_x', 'org-x', 'Org X');
        UPDATE studio.instance
           SET state = 'claimed', owner_organization_id = 'org_v'
         WHERE id = 'singleton';
        INSERT INTO studio.instance_organizations(organization_id, role, status)
          VALUES ('org_v', 'owner', 'admitted');
        INSERT INTO secrets.credential_types(id, slug, display_name) VALUES
          ('credential_type:beam_api_key', 'beam_api_key', 'Beam API key'),
          ('credential_type:s3_compatible_access_key', 's3_compatible_access_key', 'S3 access key');
        INSERT INTO secrets.provider_profiles(id, credential_type_id, driver, display_name) VALUES
          ('beam', 'credential_type:beam_api_key', 'beam', 'Beam'),
          ('s3', 'credential_type:s3_compatible_access_key', 's3-compatible', 'Amazon S3');
        INSERT INTO transfer_templates(id, organization_id, name, api_key_id, created_at, updated_at)
          VALUES ('tpl_v', 'org_v', 'Transfer', 'key', now(), now());
        INSERT INTO transfer_sources(id, transfer_template_id, name, provider, bucket, object_key, created_at, updated_at)
          VALUES ('src_keep', 'tpl_v', 'Source', 's3', 'b', 'k', now(), now()),
                 ('src_drop', 'tpl_v', 'Source', 's3', 'b', 'k', now(), now());
        INSERT INTO transfer_destinations(id, transfer_template_id, name, provider, bucket, object_key, created_at, updated_at)
          VALUES ('dst_drop', 'tpl_v', 'Destination', 's3', 'b', 'k', now(), now());
        -- A second transfer in the same organization and one in another.
        INSERT INTO transfer_templates(id, organization_id, name, api_key_id, created_at, updated_at)
          VALUES ('tpl_w', 'org_v', 'Other transfer', 'key_v2', now(), now()),
                 ('tpl_x', 'org_x', 'Foreign transfer', 'key_x', now(), now());
        INSERT INTO transfer_sources(id, transfer_template_id, name, provider, bucket, object_key, created_at, updated_at)
          VALUES ('src_x', 'tpl_x', 'Foreign source', 's3', 'b', 'k', now(), now());
        -- Legacy local keys carry no organization.
        INSERT INTO beam_api_keys(id, name, base_url, encrypted_api_key, created_at, updated_at)
          VALUES ('key', 'Key V', 'https://beam.example', 'x', now(), now()),
                 ('key_v2', 'Key V2', 'https://beam.example', 'x', now(), now()),
                 ('key_x', 'Key X', 'https://beam.example', 'x', now(), now()),
                 ('key_unbound', 'Unbound key', 'https://beam.example', 'x', now(), now());
        INSERT INTO runs(id, transfer_template_id, status, trigger, created_at, updated_at)
          VALUES ('run_done', 'tpl_v', 'completed', 'manual', now(), now());
      `);
      globals.__beamStudioPgPool = pool;

      const { buildServer } = await import("../server.js");
      const { createStudioBrowserSession, STUDIO_SESSION_COOKIE } =
        await import("../auth/browser-session.js");
      const services = {
        oauth: { hasSession: async () => true },
        beamApi: {
          getJson: async (path: string) =>
            path.startsWith("/api/organizations")
              ? { organizations: [{ id: "org_v", role: "admin" }] }
              : path.startsWith("/api/projects")
                ? { projects: [] }
                : { id: "user-v", email: "v@localhost", accountType: "admin" },
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
        "x-organization-id": "org_v",
        origin: "http://localhost:5173",
        cookie: `${STUDIO_SESSION_COOKIE}=${createStudioBrowserSession("request-validation-test-secret")}`,
      };
      const send = (request: InjectOptions) =>
        server!.inject({ ...request, headers });
      const rows = async (table: string, id: string) =>
        (
          await pool!.query(
            `SELECT count(*)::int AS count FROM ${table} WHERE id = $1`,
            [id],
          )
        ).rows[0].count as number;

      // S15: a DELETE without a body was `Cannot read properties of undefined
      // (reading 'kind')`. The kind now follows the endpoint id.
      const noBody = await send({
        method: "DELETE",
        url: "/studio/transfers/tpl_v/endpoints/dst_drop",
      });
      assert.equal(noBody.statusCode, 200, noBody.body);
      assert.deepEqual(noBody.json(), { deleted: true });
      assert.equal(await rows("transfer_destinations", "dst_drop"), 0);

      const byQuery = await send({
        method: "DELETE",
        url: "/studio/transfers/tpl_v/endpoints/src_drop?kind=source",
      });
      assert.equal(byQuery.statusCode, 200, byQuery.body);
      assert.equal(await rows("transfer_sources", "src_drop"), 0);

      for (const request of [
        {
          method: "DELETE" as const,
          url: "/studio/transfers/tpl_v/endpoints/src_keep",
          payload: { kind: "sideways" },
        },
        {
          method: "DELETE" as const,
          url: "/studio/transfers/tpl_v/endpoints/src_keep?kind=sideways",
        },
        {
          method: "PATCH" as const,
          url: "/studio/transfers/tpl_v/endpoints/src_keep",
          payload: { kind: "sideways", name: "Renamed" },
        },
        {
          method: "POST" as const,
          url: "/studio/transfers/tpl_v/endpoints",
          payload: { kind: "sideways", name: "New" },
        },
      ]) {
        const response = await send(request);
        const label = `${request.method} ${request.url}`;
        assert.equal(response.statusCode, 400, `${label}: ${response.body}`);
        assert.equal(response.json().code, "endpoint_kind_invalid", label);
        assert.deepEqual(
          response.json().details.acceptedValues,
          ["source", "destination"],
          label,
        );
      }
      assert.equal(
        await rows("transfer_sources", "src_keep"),
        1,
        "an invalid kind deletes nothing",
      );

      // A body-less write reaches the route's own handling instead of a
      // TypeError on `request.body`.
      const bodyless = await send({
        method: "POST",
        url: "/studio/credentials/test",
      });
      assert.notEqual(bodyless.statusCode, 500, bodyless.body);

      // S17: `beam_api_key` is the credential type; the kind is the provider
      // profile id, `beam`.
      for (const url of ["/studio/credentials", "/studio/credentials/test"]) {
        const typeAsKind = await send({
          method: "POST",
          url,
          payload: {
            name: "Beam key",
            kind: "beam_api_key",
            payload: { api_key: "not-a-real-key" },
          },
        });
        assert.equal(typeAsKind.statusCode, 400, `${url}: ${typeAsKind.body}`);
        const body = typeAsKind.json();
        assert.equal(body.code, "credential_provider_unsupported");
        assert.match(body.error, /use the provider "beam"/);
        assert.deepEqual(body.details.acceptedValues, ["beam", "s3"]);
        assert.deepEqual(body.details.suggestedValues, ["beam"]);

        const unknown = await send({
          method: "POST",
          url,
          payload: { name: "Nope", kind: "nope", payload: {} },
        });
        assert.equal(unknown.statusCode, 400, `${url}: ${unknown.body}`);
        assert.equal(unknown.json().code, "credential_provider_unsupported");
        assert.deepEqual(unknown.json().details.acceptedValues, ["beam", "s3"]);
        assert.equal(unknown.json().details.suggestedValues, undefined);
      }
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM secrets.credentials",
          )
        ).rows[0].count,
        0,
        "a rejected kind stores nothing",
      );

      // S20: user-input validation is a 400 with a stable code, not a 500.
      const expect400 = async (
        request: InjectOptions,
        code: string,
        field?: string,
      ) => {
        const response = await send(request);
        const label = `${request.method} ${request.url}`;
        assert.equal(response.statusCode, 400, `${label}: ${response.body}`);
        const body = response.json();
        assert.equal(body.code, code, label);
        assert.equal(typeof body.error, "string", label);
        assert.notEqual(body.error, "Internal server error", label);
        if (field) assert.equal(body.details?.field, field, label);
        return body;
      };

      await expect400(
        { method: "POST", url: "/studio/credentials" },
        "credential_name_required",
        "name",
      );
      for (const request of [
        {
          method: "POST" as const,
          url: "/studio/credentials",
          payload: { name: "Empty kind", kind: "", payload: {} },
        },
        {
          method: "POST" as const,
          url: "/studio/credentials/test",
          payload: { kind: "  ", payload: {} },
        },
        {
          method: "PATCH" as const,
          url: "/studio/credentials/cred_missing",
          payload: { name: "Empty kind", kind: "", payload: {} },
        },
      ]) {
        const body = await expect400(
          request,
          "credential_provider_required",
          "kind",
        );
        assert.deepEqual(body.details.acceptedValues, ["beam", "s3"]);
      }

      await expect400(
        { method: "POST", url: "/studio/mcp/tokens", payload: {} },
        "mcp_token_name_required",
        "name",
      );
      await expect400(
        {
          method: "POST",
          url: "/studio/mcp/tokens",
          payload: {
            name: "Bad expiry",
            scopes: ["read:runs"],
            expiresAt: "next tuesday-ish",
          },
        },
        "expiration_date_invalid",
        "expiresAt",
      );

      await expect400(
        {
          method: "POST",
          url: "/studio/workflows",
          payload: { apiKeyId: "key" },
        },
        "workflow_name_required",
        "name",
      );
      const created = await send({
        method: "POST",
        url: "/studio/workflows",
        payload: { name: "Validation", apiKeyId: "key" },
      });
      assert.equal(created.statusCode, 201, created.body);
      const workflowId = created.json().id as string;
      await expect400(
        {
          method: "PATCH",
          url: `/studio/workflows/${workflowId}`,
          payload: { name: "   " },
        },
        "workflow_name_required",
        "name",
      );
      const policy = await expect400(
        {
          method: "PATCH",
          url: `/studio/workflows/${workflowId}`,
          payload: { failurePolicy: "sometimes" },
        },
        "workflow_failure_policy_invalid",
        "failurePolicy",
      );
      assert.deepEqual(policy.details.acceptedValues, [
        "stop_on_failure",
        "continue_on_failure",
      ]);

      await expect400(
        {
          method: "POST",
          url: "/studio/transfers/tpl_v/endpoints",
          payload: { bucket: "b", objectKey: "k" },
        },
        "endpoint_name_required",
        "name",
      );
      await expect400(
        {
          method: "POST",
          url: "/studio/registry/install",
          payload: { packageName: "not-scoped" },
        },
        "action_package_name_invalid",
        "packageName",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM mcp.tokens WHERE organization_id = 'org_v'",
          )
        ).rows[0].count,
        0,
        "a refused token request stores nothing",
      );

      // An endpoint is edited or deleted only through its own transfer.
      const endpointName = async (id: string) =>
        (
          await pool!.query("SELECT name FROM transfer_sources WHERE id = $1", [
            id,
          ])
        ).rows[0]?.name as string | undefined;
      const rename = {
        kind: "source",
        name: "Hijacked",
        bucket: "b",
        objectKey: "k",
      };
      for (const request of [
        // Same organization, another transfer's URL.
        {
          method: "PATCH" as const,
          url: "/studio/transfers/tpl_w/endpoints/src_keep",
          payload: rename,
        },
        {
          method: "DELETE" as const,
          url: "/studio/transfers/tpl_w/endpoints/src_keep?kind=source",
        },
        // Another organization's endpoint through this organization's transfer.
        {
          method: "PATCH" as const,
          url: "/studio/transfers/tpl_v/endpoints/src_x",
          payload: rename,
        },
        {
          method: "DELETE" as const,
          url: "/studio/transfers/tpl_v/endpoints/src_x?kind=source",
        },
        {
          method: "PATCH" as const,
          url: "/studio/transfers/tpl_v/endpoints/src_missing",
          payload: rename,
        },
      ]) {
        const response = await send(request);
        const label = `${request.method} ${request.url}`;
        assert.equal(response.statusCode, 404, `${label}: ${response.body}`);
        assert.equal(response.json().code, "endpoint_not_found", label);
      }
      // Another organization's endpoint through its own transfer's URL.
      const foreign = await send({
        method: "PATCH",
        url: "/studio/transfers/tpl_x/endpoints/src_x",
        payload: rename,
      });
      assert.equal(foreign.statusCode, 404, foreign.body);
      assert.equal(foreign.json().code, "transfer_not_found");
      assert.equal(await endpointName("src_keep"), "Source");
      assert.equal(await endpointName("src_x"), "Foreign source");
      const own = await send({
        method: "PATCH",
        url: "/studio/transfers/tpl_v/endpoints/src_keep",
        payload: { ...rename, name: "Renamed" },
      });
      assert.equal(own.statusCode, 200, own.body);
      assert.equal(await endpointName("src_keep"), "Renamed");

      // Legacy local keys are listed only to the organization using them.
      const store = await import("./store.js");
      const keyIds = async (organizationId: string) =>
        (await store.listApiKeys({ organizationId }))
          .map((key) => key.id)
          .sort();
      assert.deepEqual(await keyIds("org_v"), ["key", "key_v2"]);
      assert.deepEqual(await keyIds("org_x"), ["key_x"]);
      assert.deepEqual(await keyIds("org_stranger"), []);
      assert.deepEqual(await keyIds("__local__"), [
        "key",
        "key_unbound",
        "key_v2",
        "key_x",
      ]);

      // Workflow PATCH: typed 404, boolean `enabled`, visible API key only.
      const missing = await send({
        method: "PATCH",
        url: "/studio/workflows/wft_missing",
        payload: { name: "Nope" },
      });
      assert.equal(missing.statusCode, 404, missing.body);
      assert.equal(missing.json().code, "workflow_not_found");
      await expect400(
        {
          method: "PATCH",
          url: `/studio/workflows/${workflowId}`,
          payload: { enabled: "yes" },
        },
        "workflow_enabled_invalid",
        "enabled",
      );
      for (const apiKeyId of ["key_x", "key_unbound", "key_nonexistent"]) {
        await expect400(
          {
            method: "PATCH",
            url: `/studio/workflows/${workflowId}`,
            payload: { apiKeyId },
          },
          "api_key_not_found",
          "apiKeyId",
        );
      }
      const storedKey = async () =>
        (
          await pool!.query(
            "SELECT api_key_id, enabled FROM workflow.templates WHERE id = $1",
            [workflowId],
          )
        ).rows[0] as { api_key_id: string | null; enabled: boolean };
      assert.equal((await storedKey()).api_key_id, "key");
      const rebound = await send({
        method: "PATCH",
        url: `/studio/workflows/${workflowId}`,
        payload: { apiKeyId: "key_v2", enabled: false },
      });
      assert.equal(rebound.statusCode, 200, rebound.body);
      assert.deepEqual(await storedKey(), {
        api_key_id: "key_v2",
        enabled: false,
      });

      // A manual retry of a run that has not failed is a conflict, refused
      // before any credit is reserved; an unknown run is not found.
      const notFailed = await send({
        method: "POST",
        url: "/studio/runs/run_done/retry",
      });
      assert.equal(notFailed.statusCode, 409, notFailed.body);
      assert.equal(notFailed.json().code, "run_not_retryable");
      const unknownRun = await send({
        method: "POST",
        url: "/studio/runs/run_missing/retry",
      });
      assert.equal(unknownRun.statusCode, 404, unknownRun.body);
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
