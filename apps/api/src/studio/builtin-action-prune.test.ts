import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import {
  persistRegistryBuiltinActionsPg,
  pruneRemovedBuiltinActionsPg,
} from "./store.js";

const source = process.env.BEAM_TEST_POSTGRES_URL;

test(
  "startup prunes builtin catalog rows the Studio no longer ships, and nothing else",
  { skip: !source },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const database = `builtin_prune_${randomBytes(6).toString("hex")}`;
    const maintenance = createPostgresPool(source);
    let pool: PgPool | undefined;
    try {
      await maintenance.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      await persistRegistryBuiltinActionsPg(pool, new Date().toISOString());
      await pool.query(
        "INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Org')",
      );

      const scope = await pool.query<{ id: string }>(
        "SELECT id FROM actions.scopes WHERE name='@beam'",
      );
      const scopeId = scope.rows[0]?.id;
      assert.ok(scopeId);
      async function seed(
        packageName: string,
        metadata: Record<string, unknown>,
        organizationId: string | null = null,
      ) {
        const id = `pkg_${packageName.replace(/[^a-z0-9]+/g, "_")}`;
        await pool!.query(
          `INSERT INTO actions.packages(id,scope_id,name,package_name,display_name,metadata_json,organization_id)
           VALUES($1,$2,$3,$4,$3,$5::jsonb,$6)`,
          [
            id,
            scopeId,
            packageName.split("/")[1],
            packageName,
            JSON.stringify(metadata),
            organizationId,
          ],
        );
        await pool!.query(
          `INSERT INTO actions.package_versions(id,package_id,version,manifest_json,manifest_checksum,artifact_checksum)
           VALUES($1,$2,'1.0.0','{}'::jsonb,'checksum','checksum')`,
          [`${id}_1`, id],
        );
      }
      // Rows left by earlier releases: an API-seeded builtin and a
      // `db:studio:init` row that carries only the builtin marker.
      await seed("@beam/csv-merge", { source: "builtin", owner: "Beam" });
      await seed("@beam/s3-write", { builtin: true });
      // Rows the prune must keep.
      await seed("@beam/registry-only", { source: "public-registry" });
      await seed("@beam/org-private", { source: "builtin" }, "org");
      await seed("@beam/unmarked", {});

      const before = await pool.query<{ count: string }>(
        "SELECT count(*) FROM actions.packages WHERE metadata_json->>'source'='builtin' AND organization_id IS NULL",
      );

      assert.deepEqual(await pruneRemovedBuiltinActionsPg(pool), [
        "@beam/csv-merge",
        "@beam/s3-write",
      ]);
      // Idempotent: a second startup has nothing left to remove.
      assert.deepEqual(await pruneRemovedBuiltinActionsPg(pool), []);

      const names = new Set(
        (
          await pool.query<{ package_name: string }>(
            "SELECT package_name FROM actions.packages",
          )
        ).rows.map((row) => row.package_name),
      );
      for (const kept of [
        "@beam/upload",
        "@beam/download",
        "@beam/fan-out",
        "@beam/registry-only",
        "@beam/org-private",
        "@beam/unmarked",
      ]) {
        assert.ok(names.has(kept), `${kept} was kept`);
      }
      assert.equal(names.has("@beam/csv-merge"), false);
      assert.equal(names.has("@beam/s3-write"), false);
      const after = await pool.query<{ count: string }>(
        "SELECT count(*) FROM actions.packages WHERE metadata_json->>'source'='builtin' AND organization_id IS NULL",
      );
      assert.equal(
        Number(after.rows[0]?.count),
        Number(before.rows[0]?.count) - 1,
      );
      const orphanVersions = await pool.query(
        "SELECT 1 FROM actions.package_versions v LEFT JOIN actions.packages p ON p.id=v.package_id WHERE p.id IS NULL",
      );
      assert.equal(orphanVersions.rows.length, 0);
    } finally {
      await pool?.end();
      await maintenance
        .query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
        .catch(() => undefined);
      await maintenance.end();
      if (previousAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previousAllow;
    }
  },
);
