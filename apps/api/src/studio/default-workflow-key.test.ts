import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { builtinBeamEnvironmentTemplates } from "@beam-studio/shared";
import {
  defaultWorkflowKeyPg,
  keyMatchesEnvironment,
} from "./default-workflow-key.js";

const prod = builtinBeamEnvironmentTemplates.prod;
test("default selection matches endpoint and environment, never a development key by accident", () => {
  assert.equal(
    keyMatchesEnvironment({ baseUrl: prod.baseUrl }, prod, prod.baseUrl),
    true,
  );
  assert.equal(keyMatchesEnvironment({}, prod, prod.baseUrl), true);
  assert.equal(
    keyMatchesEnvironment({ environment: "dev" }, prod, prod.baseUrl),
    false,
  );
  assert.equal(
    keyMatchesEnvironment(
      { baseUrl: "https://different.example" },
      prod,
      prod.baseUrl,
    ),
    false,
  );
  assert.equal(
    keyMatchesEnvironment({ baseUrl: "bad" }, prod, prod.baseUrl),
    false,
  );
  assert.equal(
    keyMatchesEnvironment(
      { baseUrl: prod.baseUrl, natsUrl: "nats://different:4222" },
      prod,
      prod.baseUrl,
    ),
    false,
  );
});

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
test(
  "workflow creation automatically selects a scoped usable default and preserves explicit choices",
  { skip: !source?.startsWith("postgres") },
  async () => {
    const previousUrl = process.env.DATABASE_URL;
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const globals = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
    };
    const previousPool = globals.__beamStudioPgPool;
    const admin = createPostgresPool(source);
    const database = `workflow_defaults_${randomBytes(6).toString("hex")}`;
    let pool: PgPool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      globals.__beamStudioPgPool = pool;
      await pool.query(
        "INSERT INTO identity.organizations(id,slug,name) VALUES('default-org','default-org','Default'),('foreign-org','foreign-org','Foreign')",
      );
      await pool.query(
        "INSERT INTO identity.projects(id,organization_id,slug,name) VALUES('project','default-org','project','Project')",
      );
      await pool.query(
        "INSERT INTO secrets.credential_types(id,slug,display_name) VALUES('beam-default-test','beam_api_key','Beam key') ON CONFLICT(slug) DO NOTHING",
      );
      const type = (
        await pool.query(
          "SELECT id FROM secrets.credential_types WHERE slug='beam_api_key'",
        )
      ).rows[0].id;
      for (const [id, org, project, metadata, version] of [
        [
          "prod-key",
          "default-org",
          null,
          { baseUrl: prod.baseUrl, environment: "prod" },
          true,
        ],
        [
          "dev-key",
          "default-org",
          null,
          { baseUrl: "http://127.0.0.1:8001", environment: "dev" },
          true,
        ],
        [
          "a-project-key",
          "default-org",
          "project",
          { baseUrl: prod.baseUrl },
          true,
        ],
        ["a-foreign-key", "foreign-org", null, { baseUrl: prod.baseUrl }, true],
        ["a-expired-key", "default-org", null, { baseUrl: prod.baseUrl }, true],
        ["a-revoked-key", "default-org", null, { baseUrl: prod.baseUrl }, true],
        [
          "a-versionless-key",
          "default-org",
          null,
          { baseUrl: prod.baseUrl },
          false,
        ],
      ] as const) {
        await pool.query(
          "INSERT INTO secrets.credentials(id,organization_id,project_id,credential_type_id,name,metadata_json,created_at) VALUES($1,$2,$3,$4,$1,$5::jsonb,'2026-01-01')",
          [id, org, project, type, JSON.stringify(metadata)],
        );
        if (version)
          await pool.query(
            "INSERT INTO secrets.credential_versions(id,credential_id,version,encrypted_payload,encryption_key_id) VALUES($1,$2,1,'test-placeholder','local')",
            [`${id}-v1`, id],
          );
      }
      await pool.query(
        "UPDATE secrets.credentials SET expires_at=now()-interval '1 day' WHERE id='a-expired-key'",
      );
      await pool.query(
        "UPDATE secrets.credential_versions SET revoked_at=now() WHERE credential_id='a-revoked-key'",
      );
      const input = {
        organizationId: "default-org",
        template: prod,
        defaultBaseUrl: prod.baseUrl,
      };
      assert.equal(await defaultWorkflowKeyPg(pool, input), "prod-key");
      assert.equal(
        await defaultWorkflowKeyPg(pool, { ...input, projectId: "project" }),
        "prod-key",
      );
      const store = await import("./store.js");
      const created = await store.createWorkflowTemplate({
        organizationId: "default-org",
        name: "Automatic",
      });
      assert.equal(
        (await store.getWorkflowTemplate(created, "default-org"))?.template
          .apiKeyId,
        "prod-key",
      );
      const overridden = await store.createWorkflowTemplate({
        organizationId: "default-org",
        name: "Explicit",
        apiKeyId: "dev-key",
      });
      assert.equal(
        (await store.getWorkflowTemplate(overridden, "default-org"))?.template
          .apiKeyId,
        "dev-key",
      );
      await pool.query(
        "UPDATE secrets.credentials SET expires_at=now()-interval '1 day' WHERE id='prod-key'",
      );
      assert.equal(await defaultWorkflowKeyPg(pool, input), null);
      assert.equal(
        await defaultWorkflowKeyPg(pool, { ...input, projectId: "project" }),
        "a-project-key",
      );
      // The Studio instance key comes first, however much newer it is.
      await pool.query(
        "INSERT INTO secrets.credentials(id,organization_id,credential_type_id,name,metadata_json,external_source,created_at) VALUES('z-instance-key','default-org',$1,'Studio instance key','{}'::jsonb,'beam_studio_instance','2026-06-01')",
        [type],
      );
      await pool.query(
        "INSERT INTO secrets.credential_versions(id,credential_id,version,encrypted_payload,encryption_key_id) VALUES('z-instance-key-v1','z-instance-key',1,'test-placeholder','local')",
      );
      await pool.query(
        "UPDATE secrets.credentials SET expires_at=NULL WHERE id='prod-key'",
      );
      assert.equal(await defaultWorkflowKeyPg(pool, input), "z-instance-key");
      assert.equal(
        await defaultWorkflowKeyPg(pool, { ...input, projectId: "project" }),
        "z-instance-key",
      );
    } finally {
      globals.__beamStudioPgPool = previousPool;
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      if (previousAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previousAllow;
    }
  },
);
