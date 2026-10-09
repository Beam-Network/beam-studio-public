import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checksumManifest,
  validateActionManifest,
  type ActionManifest,
} from "@beam-studio/core";
import {
  assertRegistryVersionInstallable,
  createRegistryClient,
  freshSignedArtifactUrl,
  normalizeRegistryRepository,
  registryClientUrl,
  RegistryClientError,
  validSignedArtifactUrl,
} from "./registry-client.js";

const waitManifest: ActionManifest = {
  name: "@beam/wait",
  version: "1.2.3",
  displayName: "Wait",
  description: "Pause without contacting an external service.",
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
  configSchema: {
    type: "object",
    properties: { milliseconds: { type: "number", minimum: 0 } },
  },
  inputs: {},
  outputs: { waitedMs: { type: "number" } },
  permissions: [],
  trustLevel: "verified",
  catalog: {
    category: "Workflow",
    maturity: "deprecated",
    owner: "Beam",
    tags: ["wait", "timer"],
    changelog: [],
  },
};

const artifactChecksum = `sha256:${"a".repeat(64)}`;
const artifactReference =
  "https://registry.test/v1/packages/%40beam/wait/versions/1.2.3/artifact";

const studioSourceRoot = dirname(fileURLToPath(import.meta.url));

test("Registry consumer normalizes installed-facing states and immutable wait identity", async () => {
  const requestedUrls: string[] = [];
  const client = createRegistryClient({
    baseUrl: "https://registry.test",
    fetchImpl: async (input) => {
      requestedUrls.push(String(input));
      return Response.json({
        categories: [
          {
            id: "workflow",
            slug: "workflow",
            name: "Workflow",
            packageCount: 1,
          },
        ],
        packages: [
          {
            id: "pkg_wait",
            packageName: "@beam/wait",
            scope: "@beam",
            name: "wait",
            status: "deprecated",
            trustLevel: "verified",
            latestVersion: "1.2.3",
            versions: [waitVersionFixture()],
            advisories: [
              {
                id: "BSA-2026-001",
                title: "Timer precision issue",
                severity: "moderate",
                status: "active",
                affectedVersions: ["<=1.2.3"],
                patchedVersions: ["1.2.4"],
              },
            ],
            updatedAt: "2026-08-06T12:00:00.000Z",
          },
        ],
      });
    },
  });

  const result = await client.list();
  const item = result.packages[0];
  assert.ok(item);
  assert.equal(item.packageName, "@beam/wait");
  assert.equal(item.status, "deprecated");
  assert.equal(item.vulnerable, true);
  assert.equal(item.advisories[0]?.id, "BSA-2026-001");
  assert.equal(item.latestManifestChecksum, checksumManifest(waitManifest));
  assert.equal(item.latestArtifactChecksum, artifactChecksum);
  assert.equal(item.latestArtifactReference, artifactReference);
  assert.equal(item.latestSourceRegistry, "public-registry");
  assert.equal(item.versions[0]?.trustLevel, "verified");
  assert.equal(requestedUrls[0], "https://registry.test/v1/registry");
});

test("Registry resolve preserves exact wait version, checksums, source, trust, and artifact", async () => {
  let requestedUrl = "";
  const client = createRegistryClient({
    baseUrl: "https://registry.test/",
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return Response.json({
        package: {
          packageName: "@beam/wait",
          status: "active",
          trustLevel: "verified",
        },
        requestedRange: "latest",
        resolvedVersion: "1.2.3",
        version: waitVersionFixture(),
      });
    },
  });

  const resolved = await client.resolve("@beam/wait", "latest");
  assert.doesNotThrow(() => assertRegistryVersionInstallable(resolved));
  assert.equal(resolved.resolvedVersion, "1.2.3");
  assert.equal(
    resolved.version.manifestChecksum,
    checksumManifest(waitManifest),
  );
  assert.equal(resolved.version.artifactChecksum, artifactChecksum);
  assert.equal(resolved.version.artifactReference, artifactReference);
  assert.equal(resolved.version.sourceRegistry, "public-registry");
  assert.equal(resolved.version.trustLevel, "verified");
  assert.equal(
    requestedUrl,
    "https://registry.test/v1/resolve/%40beam/wait?range=latest",
  );
});

test("Registry resolve preserves the pinned v2 manifest and its checksum for installation", async () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "../../../../packages/core/src/workflows/fixtures/registry-v2/v2-single.valid.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ActionManifest;
  const client = createRegistryClient({
    baseUrl: "https://registry.test/",
    fetchImpl: async () =>
      Response.json({
        package: {
          packageName: manifest.name,
          status: "active",
          trustLevel: "verified",
        },
        resolvedVersion: manifest.version,
        version: {
          ...waitVersionFixture(),
          version: manifest.version,
          manifest,
          manifestChecksum: checksumManifest(manifest),
          status: "active",
        },
      }),
  });
  const resolved = await client.resolve(manifest.name, "latest");
  assert.doesNotThrow(() => assertRegistryVersionInstallable(resolved));
  assert.doesNotThrow(() => validateActionManifest(resolved.version.manifest));
  assert.deepEqual(resolved.version.manifest, manifest);
  assert.equal(resolved.version.manifestChecksum, checksumManifest(manifest));
});

test("Registry client preserves API prefixes in base URLs", async () => {
  const requestedUrls: string[] = [];
  const client = createRegistryClient({
    baseUrl: "https://registry.example.test/registry",
    fetchImpl: async (input) => {
      requestedUrls.push(String(input));
      return Response.json({ categories: [], packages: [] });
    },
  });

  await client.list();

  assert.equal(
    requestedUrls[0],
    "https://registry.example.test/registry/v1/registry",
  );
  assert.equal(
    registryClientUrl(
      "https://registry.example.test/registry",
      "/v1/packages/%40beam/transfer/versions/1.2.17/artifact",
    ).toString(),
    "https://registry.example.test/registry/v1/packages/%40beam/transfer/versions/1.2.17/artifact",
  );
});

test("Registry install policy rejects blocked versions and blocking advisories", async () => {
  const client = createRegistryClient({
    baseUrl: "https://registry.test",
    fetchImpl: async () =>
      Response.json({
        package: { status: "active", trustLevel: "verified" },
        resolvedVersion: "1.2.3",
        version: {
          ...waitVersionFixture(),
          advisories: [
            {
              id: "BSA-2026-CRITICAL",
              title: "Unsafe timer package",
              severity: "critical",
              status: "blocked",
              blocking: true,
              patchedVersions: ["1.2.4"],
            },
          ],
        },
      }),
  });
  const resolved = await client.resolve("@beam/wait", "latest");
  assert.throws(
    () => assertRegistryVersionInstallable(resolved),
    (error: unknown) => {
      assert.ok(error instanceof RegistryClientError);
      assert.equal(error.code, "registry_advisory_blocked");
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details.advisoryIds, ["BSA-2026-CRITICAL"]);
      assert.match(error.action, /patched version/i);
      return true;
    },
  );
});

test("Registry transport failures remain structured and actionable", async () => {
  const client = createRegistryClient({
    baseUrl: "https://registry.test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          code: "registry_version_not_found",
          error: "No version satisfies ^9.0.0",
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
  });

  await assert.rejects(client.resolve("@beam/wait", "^9.0.0"), (error) => {
    assert.ok(error instanceof RegistryClientError);
    assert.equal(error.code, "registry_version_not_found");
    assert.equal(error.statusCode, 404);
    assert.equal(error.retryable, false);
    assert.match(error.message, /No version satisfies/);
    assert.match(error.action, /package name and requested version/i);
    return true;
  });
});

test("Registry requests carry the organization key only to the Registry origin over HTTPS", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json({ categories: [], packages: [] });
  }) as typeof fetch;

  await createRegistryClient({
    baseUrl: "https://registry.example.test/registry",
    apiKey: "beam_org_key",
    fetchImpl,
  }).list();
  assert.equal(calls[0]?.url, "https://registry.example.test/registry/v1/registry");
  assert.deepEqual(calls[0]?.init?.headers, {
    authorization: "Bearer beam_org_key",
  });
  // A redirect must not forward the key anywhere.
  assert.equal(calls[0]?.init?.redirect, "error");

  // No key, or a plain-HTTP Registry that is not loopback: anonymous request,
  // unchanged from before machine auth existed.
  await createRegistryClient({
    baseUrl: "https://registry.test",
    fetchImpl,
  }).list();
  await createRegistryClient({
    baseUrl: "http://registry.example",
    apiKey: "beam_org_key",
    fetchImpl,
  }).list();
  assert.equal(calls[1]?.init?.headers, undefined);
  assert.equal(calls[2]?.init?.headers, undefined);

  await createRegistryClient({
    baseUrl: "http://127.0.0.1:8787/registry",
    apiKey: "beam_org_key",
    fetchImpl,
  }).list();
  assert.deepEqual(calls[3]?.init?.headers, {
    authorization: "Bearer beam_org_key",
  });
});

test("A signed artifact URL is carried separately and never becomes the durable reference", async () => {
  const signed = `https://api.b1m.ai/registry/v1/artifacts/sha256/${"a".repeat(64)}?exp=1790000000&sig=abc`;
  let requestedUrl = "";
  const client = createRegistryClient({
    baseUrl: "https://registry.test",
    apiKey: "beam_org_key",
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      const {
        artifactReference: _unused,
        provenance: _p,
        ...version
      } = waitVersionFixture();
      return Response.json({
        package: {
          packageName: "@beam/wait",
          status: "active",
          trustLevel: "verified",
          visibility: "private",
        },
        resolvedVersion: "1.2.3",
        version: { ...version, artifactUrl: signed },
      });
    },
  });
  const resolved = await client.resolve("@beam/wait", "1.2.3");
  assert.equal(resolved.packageVisibility, "private");
  assert.equal(resolved.version.artifactUrl, signed);
  assert.equal(resolved.version.artifactReference, null);

  const exact = createRegistryClient({
    baseUrl: "https://registry.test",
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return Response.json({ ...waitVersionFixture(), artifactUrl: signed });
    },
  });
  assert.equal(
    await freshSignedArtifactUrl(exact, {
      packageName: "@beam/wait",
      version: "1.2.3",
      artifactChecksum,
    }),
    signed,
  );
  assert.equal(
    requestedUrl,
    "https://registry.test/v1/packages/%40beam/wait/versions/1.2.3",
  );
  await assert.rejects(
    freshSignedArtifactUrl(exact, {
      packageName: "@beam/wait",
      version: "1.2.3",
      artifactChecksum: `sha256:${"b".repeat(64)}`,
    }),
    (error: unknown) =>
      error instanceof RegistryClientError &&
      error.code === "registry_artifact_checksum_mismatch",
  );
  // An older Registry issues no signed URL: callers keep the plain one.
  const older = createRegistryClient({
    baseUrl: "https://registry.test",
    fetchImpl: async () => Response.json(waitVersionFixture()),
  });
  assert.equal(
    await freshSignedArtifactUrl(older, {
      packageName: "@beam/wait",
      version: "1.2.3",
      artifactChecksum,
    }),
    null,
  );
});

test("Signed artifact URLs and repository links reject unsafe values", () => {
  assert.equal(
    validSignedArtifactUrl("https://user:pass@registry.test/a?sig=x"),
    null,
  );
  assert.equal(validSignedArtifactUrl("javascript:alert(1)"), null);
  assert.equal(validSignedArtifactUrl("http://registry.test/a?sig=x"), null);
  assert.equal(
    validSignedArtifactUrl("http://127.0.0.1:8787/a?sig=x"),
    "http://127.0.0.1:8787/a?sig=x",
  );

  assert.deepEqual(
    normalizeRegistryRepository({
      url: "https://github.com/Beam-Network/beam-actions",
      directory: "actions/wait",
    }),
    {
      url: "https://github.com/Beam-Network/beam-actions",
      directory: "actions/wait",
    },
  );
  assert.equal(
    normalizeRegistryRepository({ url: "javascript:alert(1)" }),
    null,
  );
  assert.equal(
    normalizeRegistryRepository({ url: "http://github.com/a/b" }),
    null,
  );
  assert.equal(
    normalizeRegistryRepository({
      url: "https://github.com/a/b",
      directory: "../etc",
    })?.directory,
    null,
  );
  assert.equal(normalizeRegistryRepository(null), null);
});

test("Studio Registry API remains consumer-only", () => {
  const routeSource = readFileSync(join(studioSourceRoot, "routes.ts"), "utf8");
  const registryClientSource = readFileSync(
    join(studioSourceRoot, "registry-client.ts"),
    "utf8",
  );
  const consumerSources = `${routeSource}\n${registryClientSource}`;
  for (const responsibility of [
    "/studio/registry/publish",
    "/studio/registry/publishers",
    "/studio/registry/moderate",
    "/studio/registry/certify",
  ]) {
    assert.equal(consumerSources.includes(responsibility), false);
  }
});

function waitVersionFixture() {
  return {
    version: "1.2.3",
    manifest: waitManifest,
    manifestChecksum: checksumManifest(waitManifest),
    artifactChecksum,
    artifactSizeBytes: 2048,
    artifactReference,
    mediaType: "application/vnd.beam.action+gzip",
    provenance: {
      source: "public-registry",
      registryArtifactUrl: artifactReference,
    },
    sourceRegistry: "public-registry",
    trustLevel: "verified",
    validationStatus: "verified",
    status: "deprecated",
    publishedBy: "beam",
    publishedAt: "2026-08-06T12:00:00.000Z",
  };
}
