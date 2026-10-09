import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

test(
  "the instance key is stored once, rotated as a new version, adopted by keyless workflows and revoked",
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
    const database = `instance_key_${randomBytes(6).toString("hex")}`;
    let pool: PgPool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      globals.__beamStudioPgPool = pool;
      await pool.query(`
        INSERT INTO identity.organizations(id, slug, name)
          VALUES ('org_owner', 'org-owner', 'Owner'), ('org_other', 'org-other', 'Other');
        INSERT INTO secrets.credential_types(id, slug, display_name)
          VALUES ('credential_type:beam_api_key', 'beam_api_key', 'Beam API key')
          ON CONFLICT (slug) DO NOTHING;
        INSERT INTO secrets.provider_profiles(id, credential_type_id, driver, display_name)
          SELECT 'beam', id, 'beam', 'Beam' FROM secrets.credential_types
           WHERE slug = 'beam_api_key'
          ON CONFLICT (id) DO NOTHING;
        INSERT INTO workflow.templates(id, organization_id, name, api_key_id)
          VALUES ('wf_keyless', 'org_owner', 'Keyless', NULL),
                 ('wf_chosen', 'org_owner', 'Chosen', 'chosen-key'),
                 ('wf_other', 'org_other', 'Other org', NULL);
      `);

      const store = await import("./store.js");
      assert.ok(
        (await pool.query("SELECT instance_id FROM studio.instance")).rows[0]
          ?.instance_id,
        "the installation has an instance id",
      );

      const first = await store.storeInstanceKeyCredential({
        organizationId: "org_owner",
        beamKeyId: "key_1",
        name: "Studio: studio.example.com",
        secret: "b1m_first_secret",
      });
      assert.equal(first.rotated, false);
      assert.equal(
        (await store.instanceKeySecret("org_owner"))?.secret,
        "b1m_first_secret",
      );
      const templates = await pool.query(
        "SELECT id, api_key_id FROM workflow.templates ORDER BY id",
      );
      assert.deepEqual(
        Object.fromEntries(
          templates.rows.map((row) => [row.id, row.api_key_id]),
        ),
        {
          wf_chosen: "chosen-key",
          wf_keyless: first.credentialId,
          wf_other: null,
        },
      );
      const listed = (
        await store.listBillingApiKeys({
          organizationId: "org_owner",
        })
      ).find((key) => key.id === first.credentialId);
      assert.equal(listed?.instanceDefault, true);

      const rotation = await store.storeInstanceKeyCredential({
        organizationId: "org_owner",
        beamKeyId: "key_1",
        name: "Studio: studio.example.com",
        secret: "b1m_rotated_secret",
      });
      assert.deepEqual(rotation, {
        credentialId: first.credentialId,
        rotated: true,
      });
      assert.equal(
        (await store.instanceKeySecret("org_owner"))?.secret,
        "b1m_rotated_secret",
      );
      const versions = await pool.query(
        "SELECT version, status FROM secrets.credential_versions WHERE credential_id = $1 ORDER BY version",
        [first.credentialId],
      );
      assert.deepEqual(versions.rows, [
        { version: 1, status: "superseded" },
        { version: 2, status: "active" },
      ]);

      await assert.rejects(
        store.updateCredential({
          id: first.credentialId,
          organizationId: "org_owner",
          name: "Renamed",
          kind: "beam",
          payload: JSON.stringify({ api_key: "b1m_pasted" }),
        }),
        { code: "credential_managed_by_studio" },
      );

      assert.equal(await store.markInstanceKeyRevoked("org_owner"), true);
      assert.equal(await store.readInstanceKeyCredential("org_owner"), null);
      assert.equal(await store.instanceKeySecret("org_owner"), null);
      const revoked = await pool.query(
        "SELECT status FROM secrets.credential_versions WHERE credential_id = $1 AND status = 'active'",
        [first.credentialId],
      );
      assert.equal(revoked.rows.length, 0);

      // A later consent starts a new credential rather than reviving it.
      const next = await store.storeInstanceKeyCredential({
        organizationId: "org_owner",
        beamKeyId: "key_2",
        name: "Studio: studio.example.com",
        secret: "b1m_next_secret",
      });
      assert.equal(next.rotated, false);
      assert.notEqual(next.credentialId, first.credentialId);
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
