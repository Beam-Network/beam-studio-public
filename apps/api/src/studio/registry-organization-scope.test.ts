import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  checksumManifest,
  type ActionManifest,
} from "@beam-studio/core";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  resolveActionPackageVersionPg,
  type PgPool,
} from "@beam-studio/db";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

function manifest(name: string): ActionManifest {
  return {
    name,
    version: "1.0.0",
    displayName: name,
    description: "Organization-scoped catalog fixture.",
    apiVersion: "workflow-actions/v1",
    runtime: {
      placements: ["local-workers"],
      defaultPlacement: "local-workers",
    },
    execution: {
      runtime: "node",
      isolation: "sandboxed-esm",
      supportedPlacements: ["local-workers"],
      defaultPlacement: "local-workers",
      taskMode: "single-worker",
    },
    configSchema: { type: "object", properties: {} },
    inputs: {},
    outputs: {},
    permissions: [],
    trustLevel: "external",
    catalog: {
      category: "Workflow",
      maturity: "stable",
      owner: "Acme",
      tags: [],
      changelog: [],
    },
  };
}

function resolveResponse(name: string, visibility: string) {
  const value = manifest(name);
  return {
    package: {
      packageName: name,
      status: "active",
      trustLevel: "external",
      visibility,
    },
    resolvedVersion: "1.0.0",
    version: {
      version: "1.0.0",
      manifest: value,
      manifestChecksum: checksumManifest(value),
      artifactChecksum: `sha256:${"c".repeat(64)}`,
      artifactSizeBytes: 10,
      validationStatus: "validated",
      status: "active",
      trustLevel: "external",
      // A signed URL expires; it must never be installed as the reference.
      artifactUrl: `https://api.b1m.ai/registry/v1/artifacts/sha256/${"c".repeat(64)}?exp=1&sig=x`,
    },
  };
}

test(
  "a private Registry package is installed for, listed to and resolved by its organization only",
  { skip: !source?.startsWith("postgres") },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const previousUrl = process.env.DATABASE_URL;
    const previousFetch = globalThis.fetch;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `registry_org_scope_${randomBytes(6).toString("hex")}`;
    const globals = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
    };
    const previousPool = globals.__beamStudioPgPool;
    let pool: PgPool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      globals.__beamStudioPgPool = pool;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/v1/resolve/%40acme/private-tool"))
          return Response.json(
            resolveResponse("@acme/private-tool", "private"),
          );
        if (path.endsWith("/v1/resolve/%40acme/public-tool"))
          return Response.json(resolveResponse("@acme/public-tool", "public"));
        return new Response("{}", { status: 404 });
      }) as typeof fetch;
      const store = await import("./store.js");

      const installed = await store.installPublicRegistryPackage({
        packageName: "@acme/private-tool",
        organizationId: "org_acme",
      });
      assert.doesNotMatch(String(installed.artifactUrl), /sig=/);
      await store.installPublicRegistryPackage({
        packageName: "@acme/public-tool",
        organizationId: "org_acme",
      });
      await assert.rejects(
        store.installPublicRegistryPackage({
          packageName: "@acme/private-tool",
          organizationId: "org_other",
        }),
        (error: unknown) =>
          (error as { code?: string }).code === "registry_package_unavailable",
      );
      await assert.rejects(
        store.installPublicRegistryPackage({
          packageName: "@acme/private-tool",
        }),
        (error: unknown) =>
          (error as { code?: string }).code ===
          "registry_private_package_requires_organization",
      );

      const names = async (organizationId?: string) =>
        (await store.listActionPackages({ organizationId })).map(
          (item) => item.name,
        );
      assert.ok((await names("org_acme")).includes("@acme/private-tool"));
      assert.ok(!(await names("org_other")).includes("@acme/private-tool"));
      assert.ok(!(await names()).includes("@acme/private-tool"));
      // Public packages and builtins stay instance-wide.
      assert.ok((await names("org_other")).includes("@acme/public-tool"));
      assert.ok((await names()).includes("@acme/public-tool"));

      const registryNames = async (organizationId?: string) =>
        (await store.listRegistryPackages(organizationId)).packages.map(
          (item) => item.packageName,
        );
      assert.ok(
        (await registryNames("org_acme")).includes("@acme/private-tool"),
      );
      assert.ok(
        !(await registryNames("org_other")).includes("@acme/private-tool"),
      );

      const resolved = await resolveActionPackageVersionPg(
        pool,
        "@acme/private-tool",
        "1.0.0",
        "org_acme",
      );
      assert.equal(resolved.provenance.registryVisibility, "private");
      assert.doesNotMatch(String(resolved.registryArtifactUrl), /sig=/);
      await assert.rejects(
        resolveActionPackageVersionPg(
          pool,
          "@acme/private-tool",
          "1.0.0",
          "org_other",
        ),
        /could not be resolved/,
      );
    } finally {
      globalThis.fetch = previousFetch;
      globals.__beamStudioPgPool = previousPool;
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      if (previousAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previousAllow;
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
  },
);
