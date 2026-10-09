import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import * as tar from "tar";
import type {
  ActionArtifact,
  ActionJson,
  ActionManifest,
} from "@beam-studio/core";
import {
  ActionArtifactDownloadError,
  resolveActionPackage,
} from "./actionLoader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

test("requires @beam/transfer to resolve from a Registry artifact", async () => {
  await assert.rejects(
    () =>
      resolveActionPackage(
        {
          actionPackage: "@beam/transfer",
          resolvedVersion: "1.2.0",
          sourceRegistry: "public-registry",
          versionRange: "latest",
        },
        workerOptions("/tmp/unused-beam-action-cache"),
        neverAborted,
      ),
    /must resolve to a Registry artifact with a sha256 checksum/,
  );
});

test("requires Registry transfer artifacts to include a manifest snapshot", async () => {
  await assert.rejects(
    () =>
      resolveActionPackage(
        {
          actionPackage: "@beam/transfer",
          artifactChecksum: `sha256:${"0".repeat(64)}`,
          mediaType: "application/javascript",
          registryArtifactUrl: "https://registry.example/beam-transfer.mjs",
          resolvedVersion: "1.2.0",
          sourceRegistry: "public-registry",
          versionRange: "latest",
        },
        workerOptions("/tmp/unused-beam-action-cache"),
        neverAborted,
      ),
    /missing its manifest snapshot/,
  );
});

test("downloads, verifies, caches, and executes a remote action artifact", async () => {
  const artifact = Buffer.from(`
    export async function execute({ config, inputs }) {
      return {
        outputs: {
          message: String(config.prefix ?? "") + String(inputs.name ?? "")
        }
      };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const firstPackage = await resolveActionPackage(
      {
        actionPackage: "@example/hello",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest(),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir),
      neverAborted,
    );

    const firstResult = await firstPackage.execute(
      { config: { prefix: "hi " }, inputs: { name: "Ada" } },
      actionContext(),
    );
    assert.deepEqual(firstResult.outputs, { message: "hi Ada" });
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
  }

  const cachedPackage = await resolveActionPackage(
    {
      actionPackage: "@example/hello",
      artifactChecksum: checksum,
      manifestSnapshot: remoteManifest(),
      mediaType: "application/javascript",
      registryArtifactUrl: server.url,
      resolvedVersion: "1.2.3",
      sourceRegistry: "public-registry",
      versionRange: "latest",
    },
    workerOptions(cacheDir),
    neverAborted,
  );
  const cachedResult = await cachedPackage.execute(
    { config: { prefix: "bye " }, inputs: { name: "Ada" } },
    actionContext(),
  );
  assert.deepEqual(cachedResult.outputs, { message: "bye Ada" });
});

test("prefers the Registry artifact URL when Hippius metadata is also present", async () => {
  const artifact = Buffer.from(`
    export function execute() {
      return { outputs: { source: "registry" } };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@example/registry-first",
        artifactChecksum: checksum,
        hippiusBucket: "registry-bucket",
        hippiusEndpoint: "http://127.0.0.1:1",
        hippiusKey: "blobs/action.mjs",
        manifestSnapshot: remoteManifest("@example/registry-first"),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir),
      neverAborted,
    );

    const result = await loaded.execute(
      { config: {}, inputs: {} },
      actionContext(),
    );
    assert.deepEqual(result.outputs, { source: "registry" });
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
  }
});

test("rejects a remote action artifact with the wrong checksum", async () => {
  const artifact = Buffer.from("export function execute() { return {}; }");
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    await assert.rejects(
      () =>
        resolveActionPackage(
          {
            actionPackage: "@example/bad",
            artifactChecksum: `sha256:${"0".repeat(64)}`,
            manifestSnapshot: remoteManifest("@example/bad"),
            mediaType: "application/javascript",
            registryArtifactUrl: server.url,
            resolvedVersion: "1.2.3",
            sourceRegistry: "public-registry",
            versionRange: "latest",
          },
          workerOptions(cacheDir),
          neverAborted,
        ),
      /checksum mismatch/,
    );
  } finally {
    await server.close();
  }
});

test("verifies supplied Registry publisher signatures before execution", async () => {
  const artifact = Buffer.from(
    `export function execute() { return { outputs: { waited: true } }; }`,
  );
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const signature = crypto
    .sign(null, artifact, privateKey)
    .toString("base64url");
  const publisherPublicKey = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const step = {
      actionPackage: "@beam/wait",
      artifactChecksum: checksum,
      manifestSnapshot: remoteManifest("@beam/wait"),
      mediaType: "application/javascript",
      publisherPublicKey,
      signature,
      publisherSignatureAlgorithm: "ed25519",
      registryArtifactUrl: server.url,
      resolvedVersion: "1.2.3",
      sourceRegistry: "public-registry",
      versionRange: "latest",
    };
    const loaded = await resolveActionPackage(
      step,
      workerOptions(cacheDir),
      neverAborted,
    );
    const result = await loaded.execute(
      { config: {}, inputs: {} },
      actionContext(),
    );
    assert.deepEqual(result.outputs, { waited: true });

    await assert.rejects(
      () =>
        resolveActionPackage(
          { ...step, signature: Buffer.alloc(64).toString("base64") },
          workerOptions(cacheDir),
          neverAborted,
        ),
      /publisher signature verification failed/,
    );
  } finally {
    await server.close();
  }
});

test("rejects unsupported native runtimes before artifact download", async () => {
  const artifact = Buffer.from(`export function execute() { return {}; }`);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    await assert.rejects(
      () =>
        resolveActionPackage(
          {
            actionPackage: "@beam/wait",
            artifactChecksum: checksum,
            manifestSnapshot: remoteManifest("@beam/wait", {
              execution: {
                isolation: "sandboxed-esm",
                runtime: "native" as never,
                supportedPlacements: ["local-workers"],
                taskMode: "single-worker",
              },
            }),
            mediaType: "application/javascript",
            registryArtifactUrl: server.url,
            resolvedVersion: "1.2.3",
            sourceRegistry: "public-registry",
            versionRange: "latest",
          },
          workerOptions(cacheDir),
          neverAborted,
        ),
      /unsupported native runtime.*strongly isolated runtime/,
    );
    assert.equal(server.requests(), 0);
  } finally {
    await server.close();
  }
});

test("rejects archive entrypoints that escape the extraction directory", async () => {
  const sourceDir = await tempDir();
  const archivePath = path.join(await tempDir(), "wait-action.tgz");
  await writeFile(
    path.join(sourceDir, "beam-action.json"),
    JSON.stringify({
      ...remoteManifest("@beam/wait"),
      entrypoint: "../escape.mjs",
    }),
  );
  await tar.c({ cwd: sourceDir, file: archivePath, gzip: true }, [
    "beam-action.json",
  ]);
  const artifact = await readFile(archivePath);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    await assert.rejects(
      () =>
        resolveActionPackage(
          {
            actionPackage: "@beam/wait",
            artifactChecksum: checksum,
            manifestSnapshot: remoteManifest("@beam/wait"),
            mediaType: "application/gzip",
            registryArtifactUrl: server.url,
            resolvedVersion: "1.2.3",
            sourceRegistry: "public-registry",
            versionRange: "latest",
          },
          workerOptions(cacheDir),
          neverAborted,
        ),
      /entrypoint is outside the extracted artifact/,
    );
  } finally {
    await server.close();
  }
});

test("rejects a bad publisher signature before extracting an archive", async () => {
  const sourceDir = await tempDir();
  const archivePath = path.join(await tempDir(), "wait-action.tgz");
  await mkdir(path.join(sourceDir, "dist"));
  await writeFile(
    path.join(sourceDir, "beam-action.json"),
    JSON.stringify({
      ...remoteManifest("@beam/wait"),
      entrypoint: "dist/index.mjs",
    }),
  );
  await writeFile(
    path.join(sourceDir, "dist/index.mjs"),
    `export function execute() { return { outputs: { waited: true } }; }`,
  );
  await tar.c({ cwd: sourceDir, file: archivePath, gzip: true }, [
    "beam-action.json",
    "dist/index.mjs",
  ]);
  const artifact = await readFile(archivePath);
  const digest = crypto.createHash("sha256").update(artifact).digest("hex");
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    await assert.rejects(
      () =>
        resolveActionPackage(
          {
            actionPackage: "@beam/wait",
            artifactChecksum: `sha256:${digest}`,
            manifestSnapshot: remoteManifest("@beam/wait"),
            mediaType: "application/gzip",
            publisherPublicKey: publicKey
              .export({ format: "pem", type: "spki" })
              .toString(),
            publisherSignature: Buffer.alloc(64).toString("base64"),
            registryArtifactUrl: server.url,
            resolvedVersion: "1.2.3",
            sourceRegistry: "public-registry",
            versionRange: "latest",
          },
          workerOptions(cacheDir),
          neverAborted,
        ),
      /publisher signature verification failed/,
    );
    await assert.rejects(() => access(path.join(cacheDir, digest)));
  } finally {
    await server.close();
  }
});

test("retries transient remote action download failures", async () => {
  const artifact = Buffer.from(
    "export function execute() { return { outputs: { ok: true } }; }",
  );
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact, { failFirstRequests: 1 });

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@example/retry",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest("@example/retry"),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir),
      neverAborted,
    );

    assert.equal(loaded.source, "remote");
    assert.equal(server.requests(), 2);
  } finally {
    await server.close();
  }
});

test("an expired signed artifact URL is reported with its code and not retried", async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response
      .writeHead(403, { "Content-Type": "application/json" })
      .end(JSON.stringify({ code: "artifact_url_expired" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(
      resolveActionPackage(
        {
          actionPackage: "@example/expired",
          artifactChecksum: `sha256:${"a".repeat(64)}`,
          manifestSnapshot: remoteManifest("@example/expired"),
          mediaType: "application/javascript",
          registryArtifactUrl: `http://127.0.0.1:${port}/artifact.mjs?exp=1&sig=old`,
          resolvedVersion: "1.2.3",
          sourceRegistry: "public-registry",
          versionRange: "latest",
        },
        workerOptions(await tempDir()),
        neverAborted,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ActionArtifactDownloadError);
        assert.equal(error.status, 403);
        assert.equal(error.code, "artifact_url_expired");
        // The signature never reaches an error message.
        assert.doesNotMatch(error.message, /sig=old/);
        return true;
      },
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rejects remote action permissions before downloading the artifact", async () => {
  const artifact = Buffer.from("export function execute() { return {}; }");
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    await assert.rejects(
      () =>
        resolveActionPackage(
          {
            actionPackage: "@example/filesystem",
            artifactChecksum: checksum,
            manifestSnapshot: remoteManifest("@example/filesystem", {
              permissions: ["filesystem:read"],
            }),
            mediaType: "application/javascript",
            registryArtifactUrl: server.url,
            resolvedVersion: "1.2.3",
            sourceRegistry: "public-registry",
            versionRange: "latest",
          },
          workerOptions(cacheDir),
          neverAborted,
        ),
      /does not allow/,
    );
    assert.equal(server.requests(), 0);
  } finally {
    await server.close();
  }
});

test("rejects blocked remote action manifests", async () => {
  const artifact = Buffer.from("export function execute() { return {}; }");
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    await assert.rejects(
      () =>
        resolveActionPackage(
          {
            actionPackage: "@example/blocked",
            artifactChecksum: checksum,
            manifestSnapshot: remoteManifest("@example/blocked", {
              trustLevel: "blocked",
            }),
            mediaType: "application/javascript",
            registryArtifactUrl: server.url,
            resolvedVersion: "1.2.3",
            sourceRegistry: "public-registry",
            versionRange: "latest",
          },
          workerOptions(cacheDir),
          neverAborted,
        ),
      /blocked/,
    );
    assert.equal(server.requests(), 0);
  } finally {
    await server.close();
  }
});

test("executes remote actions without process env or global fetch", async () => {
  const artifact = Buffer.from(`
    export function execute() {
      return {
        outputs: {
          hasProcess: typeof process !== "undefined",
          hasFetch: typeof fetch !== "undefined"
        }
      };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@example/sandbox-globals",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest("@example/sandbox-globals"),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir),
      neverAborted,
    );

    const result = await loaded.execute(
      { config: {}, inputs: {} },
      actionContext(),
    );
    assert.deepEqual(result.outputs, {
      hasProcess: false,
      hasFetch: false,
    });
  } finally {
    await server.close();
  }
});

test("rejects remote actions that import Node modules", async () => {
  const artifact = Buffer.from(`
    import fs from "node:fs";
    export function execute() {
      return { outputs: { ok: Boolean(fs) } };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@example/import-fs",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest("@example/import-fs"),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir),
      neverAborted,
    );

    await assert.rejects(
      async () => loaded.execute({ config: {}, inputs: {} }, actionContext()),
      /does not allow imports/,
    );
  } finally {
    await server.close();
  }
});

test("executes allowlisted first-party ESM bundles with CommonJS dependencies", async () => {
  const artifact = Buffer.from(`
    import { createHash } from "node:crypto";
    import { readFileSync } from "node:fs";

    var __require = ((fallback) =>
      typeof require !== "undefined" ? require : fallback
    )(function(moduleName) {
      if (typeof require !== "undefined") {
        return require.apply(this, arguments);
      }
      throw new Error(
        'Dynamic require of "' + moduleName + '" is not supported'
      );
    });

    const { Agent } = __require("node:https");

    export async function execute(_input, context) {
      let outsideReadDenied = false;
      try {
        readFileSync("/etc/hosts");
      } catch (error) {
        outsideReadDenied = error?.code === "ERR_ACCESS_DENIED";
      }
      const secret = await context.secrets.get("cred_test");
      return {
        outputs: {
          digest: createHash("sha256").update("beam").digest("hex"),
          httpsAgent: Agent.name,
          outsideReadDenied,
          inheritedEnvKeys: Object.keys(process.env).length,
          previousState: context.state.get().marker ?? null,
          secret
        }
      };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@beam/trusted-runtime-test",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest("@beam/trusted-runtime-test", {
          execution: {
            defaultPlacement: "local-workers",
            isolation: "trusted-node",
            runtime: "node",
            supportedPlacements: ["local-workers"],
            taskMode: "single-worker",
          },
          permissions: ["secrets:read"],
          trustLevel: "verified",
        }),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir, {
        trustedNodeActionPackages: ["@beam/trusted-runtime-test"],
      }),
      neverAborted,
    );

    const result = await loaded.execute(
      { config: {}, inputs: {} },
      actionContext({}, { marker: "persisted" }),
    );
    assert.deepEqual(result.outputs, {
      digest:
        "ae4b867cf2eeb128ceab8c7df148df2eacfe2be35dbd40856a77bfc74f882236",
      httpsAgent: "Agent",
      outsideReadDenied: true,
      inheritedEnvKeys: 0,
      previousState: "persisted",
      secret: null,
    });
  } finally {
    await server.close();
  }
});

test("rejects trusted Node actions that are not explicitly allowlisted", async () => {
  const artifact = Buffer.from(`
    import { createHash } from "node:crypto";
    export function execute() {
      return { outputs: { ok: Boolean(createHash) } };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    await assert.rejects(
      () =>
        resolveActionPackage(
          {
            actionPackage: "@beam/not-allowlisted",
            artifactChecksum: checksum,
            manifestSnapshot: remoteManifest("@beam/not-allowlisted", {
              execution: {
                isolation: "trusted-node",
                runtime: "node",
                supportedPlacements: ["local-workers"],
                taskMode: "single-worker",
              },
              trustLevel: "verified",
            }),
            mediaType: "application/javascript",
            registryArtifactUrl: server.url,
            resolvedVersion: "1.2.3",
            sourceRegistry: "public-registry",
            versionRange: "latest",
          },
          workerOptions(cacheDir),
          neverAborted,
        ),
      /not allowlisted/,
    );
    assert.equal(server.requests(), 0);
  } finally {
    await server.close();
  }
});

test("does not grant a trusted Node network allowlist without a declared permission", async () => {
  const target = await artifactServer(Buffer.from("local-only"));
  const artifact = Buffer.from(`
    import http from "node:http";
    export function execute() {
      let denied = false;
      try {
        http.get(${JSON.stringify(target.url)});
      } catch (error) {
        denied = error?.code === "ERR_ACCESS_DENIED";
      }
      return { outputs: { denied } };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@beam/wait",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest("@beam/wait", {
          execution: {
            isolation: "trusted-node",
            runtime: "node",
            supportedPlacements: ["local-workers"],
            taskMode: "single-worker",
          },
          trustLevel: "verified",
        }),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir, {
        trustedNodeActionPackages: ["@beam/wait"],
        trustedNodeAllowedNetwork: [new URL(target.url).host],
      }),
      neverAborted,
    );
    const result = await loaded.execute(
      { config: {}, inputs: {} },
      actionContext(),
    );
    assert.deepEqual(result.outputs, { denied: true });
    assert.equal(target.requests(), 0);
  } finally {
    await Promise.all([server.close(), target.close()]);
  }
});

test("blocks constructor escapes to the sandbox host process", async () => {
  const artifact = Buffer.from(`
    export function execute() {
      let globalEscapeDenied = false;
      let functionEscapeDenied = false;
      try {
        globalThis.constructor.constructor("return process")();
      } catch {
        globalEscapeDenied = true;
      }
      try {
        (() => {}).constructor("return process")();
      } catch {
        functionEscapeDenied = true;
      }
      return { outputs: { globalEscapeDenied, functionEscapeDenied } };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@example/escaped-process",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest("@example/escaped-process"),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir),
      neverAborted,
    );

    const result = await loaded.execute(
      { config: {}, inputs: {} },
      actionContext(),
    );
    assert.deepEqual(result.outputs, {
      functionEscapeDenied: true,
      globalEscapeDenied: true,
    });
  } finally {
    await server.close();
  }
});

test("kills remote action sandboxes after their timeout", async () => {
  const artifact = Buffer.from(`
    export function execute() {
      while (true) {}
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@example/infinite-loop",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest("@example/infinite-loop"),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir, { actionSandboxTimeoutMs: 100 }),
      neverAborted,
    );

    await assert.rejects(
      async () => loaded.execute({ config: {}, inputs: {} }, actionContext()),
      /sandbox timed out/,
    );
  } finally {
    await server.close();
  }
});

test("cooperatively aborts remote actions before sandbox cleanup", async () => {
  const artifact = Buffer.from(`
    export async function execute(_input, context) {
      await new Promise((resolve) => {
        context.signal.addEventListener("abort", async () => {
          await context.state.patch({ cleanupComplete: true });
          resolve();
        }, { once: true });
        void context.state.patch({ started: true });
      });
      return { outputs: { cleanupComplete: true } };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);
  const controller = new AbortController();
  const context = {
    ...actionContext(),
    signal: controller.signal,
  };
  const patch = context.state.patch;
  context.state.patch = async (value) => {
    await patch(value);
    if (value.started) controller.abort(new Error("Step timed out."));
  };

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@example/cooperative-abort",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest("@example/cooperative-abort"),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir, { actionSandboxTimeoutMs: 5_000 }),
      neverAborted,
    );
    const execution = Promise.resolve(
      loaded.execute({ config: {}, inputs: {} }, context),
    );
    await assert.rejects(execution, /sandbox was aborted/);
    assert.equal(context.state.get().cleanupComplete, true);
  } finally {
    await server.close();
  }
});

test("allows approved remote actions to stream worker temp files to disk", async () => {
  const artifact = Buffer.from(`
    export async function execute(_input, context) {
      const file = await context.beam.files.createTempFile({
        name: "random.bin",
        mediaType: "application/octet-stream",
        ttlSeconds: 60
      });
      await file.write("abc");
      await file.write(new Uint8Array([100, 101, 102]));
      const published = await file.publish();
      return {
        outputs: {
          uri: published.uri,
          size: published.size,
          written: file.size
        },
        artifacts: [{
          name: "random.bin",
          type: "file",
          uri: published.uri,
          mediaType: published.mediaType
        }]
      };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const scratchDir = await tempDir();
  const server = await artifactServer(artifact);
  let publishedPath = "";

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@example/random-file",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest("@example/random-file", {
          permissions: ["filesystem:write"],
        }),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir, {
        actionScratchDir: scratchDir,
        actionScratchMaxBytes: 1024,
        allowedActionPermissions: ["filesystem:write"],
        allowScratchWrites: true,
      }),
      neverAborted,
    );

    const result = await loaded.execute(
      { config: {}, inputs: {} },
      actionContext({
        files: {
          async publishTempFile(input: Record<string, unknown>) {
            publishedPath = String(input.tempFilePath);
            assert.equal(await readFile(publishedPath, "utf8"), "abcdef");
            return {
              uri: "beam-worker://worker-test/exp_random",
              exportId: "exp_random",
              workerId: "worker-test",
              size: Number(input.size),
              etag: "sha256:test",
              mediaType: String(input.mediaType),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              supportsRange: true,
            };
          },
        },
      }),
    );

    assert.deepEqual(result.outputs, {
      uri: "beam-worker://worker-test/exp_random",
      size: 6,
      written: 6,
    });
    assert.ok(
      (await realpath(publishedPath)).startsWith(await realpath(scratchDir)),
    );
  } finally {
    await server.close();
  }
});

test("enforces worker temp file disk quotas inside the sandbox", async () => {
  const artifact = Buffer.from(`
    export async function execute(_input, context) {
      const file = await context.beam.files.createTempFile({ name: "too-big.bin" });
      await file.write("12345");
      return { outputs: { ok: true } };
    }
  `);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const scratchDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const loaded = await resolveActionPackage(
      {
        actionPackage: "@example/quota",
        artifactChecksum: checksum,
        manifestSnapshot: remoteManifest("@example/quota", {
          permissions: ["filesystem:write"],
        }),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir, {
        actionScratchDir: scratchDir,
        actionScratchMaxBytes: 4,
        allowedActionPermissions: ["filesystem:write"],
        allowScratchWrites: true,
      }),
      neverAborted,
    );

    await assert.rejects(
      async () => loaded.execute({ config: {}, inputs: {} }, actionContext()),
      /quota exceeded/,
    );
  } finally {
    await server.close();
  }
});

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "beam-action-loader-"));
  tempDirs.push(dir);
  return dir;
}

async function artifactServer(
  artifact: Buffer,
  options: { failFirstRequests?: number } = {},
) {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    if (requestCount <= (options.failFirstRequests ?? 0)) {
      response.writeHead(503);
      response.end("try again");
      return;
    }
    response.writeHead(200, {
      "Content-Length": artifact.byteLength,
      "Content-Type": "application/javascript",
    });
    response.end(artifact);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const port = (address as AddressInfo).port;
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    requests: () => requestCount,
    url: `http://127.0.0.1:${port}/artifact.mjs`,
  };
}

function remoteManifest(
  name = "@example/hello",
  overrides: Partial<ActionManifest> = {},
): ActionManifest {
  return {
    apiVersion: "workflow-actions/v1",
    catalog: {
      category: "Test",
      changelog: [{ notes: ["Initial test action."], version: "1.2.3" }],
      maturity: "stable",
      owner: "Beam",
      tags: ["test"],
    },
    configSchema: {
      additionalProperties: true,
      properties: {},
      type: "object",
    },
    description: "Remote action used by worker loader tests.",
    displayName: "Remote test action",
    execution: {
      defaultPlacement: "local-workers",
      supportedPlacements: ["local-workers"],
      taskMode: "single-worker",
    },
    inputs: {},
    name,
    outputs: {},
    permissions: [],
    runtime: {
      defaultPlacement: "local-workers",
      placements: ["local-workers"],
    },
    version: "1.2.3",
    ...overrides,
  };
}

const neverAborted = new AbortController().signal;

function workerOptions(
  actionCacheDir: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    actionCacheDir,
    concurrency: 1,
    downloadObject: async () => ({}),
    lockTtlMs: 60_000,
    logger: {
      debug() {},
      error() {},
      info() {},
      warn() {},
    },
    maxAttempts: 1,
    uploadObject: async () => ({}),
    deleteObject: async () => ({}),
    workerId: "worker-test",
    ...overrides,
  };
}

function actionContext(
  beamOverrides: Record<string, unknown> = {},
  initialState: Record<string, ActionJson> = {},
) {
  const storage = new Map<string, ActionJson>();
  let state = { ...initialState };
  return {
    artifacts: { publish: async (artifact: ActionArtifact) => artifact },
    attempt: 1,
    beam: {
      objectStorage: {
        download: async () => ({}),
        upload: async () => ({}),
      },
      ...beamOverrides,
    },
    logger: {
      debug() {},
      error() {},
      info() {},
      warn() {},
    },
    secrets: { get: async () => null },
    state: {
      get: () => ({ ...state }),
      patch: async (partial: Record<string, ActionJson>) => {
        state = { ...state, ...partial };
      },
      set: async (next: Record<string, ActionJson>) => {
        state = { ...next };
      },
    },
    stepId: "step_1",
    stepRunId: "wsr_1",
    signal: new AbortController().signal,
    storage: {
      getJson: async (key: string) => storage.get(key),
      putJson: async (key: string, value: ActionJson) => {
        storage.set(key, value);
      },
    },
    workflowRunId: "wfr_1",
  };
}

test("a stalled artifact download is aborted instead of holding the task", async () => {
  // The server accepts the request and then never sends the body. Before the
  // resolution signal existed this blocked the task indefinitely, because the
  // step timeout is only armed once the manifest is known.
  let stalled = false;
  const server = http.createServer((_request, response) => {
    stalled = true;
    response.writeHead(200, { "Content-Type": "application/javascript" });
    // Deliberately never ended.
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  const cacheDir = await tempDir();
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("Step timed out.")), 200);

  try {
    await assert.rejects(
      () =>
        resolveActionPackage(
          {
            actionPackage: "@example/stalled",
            artifactChecksum: `sha256:${"0".repeat(64)}`,
            manifestSnapshot: remoteManifest("@example/stalled"),
            mediaType: "application/javascript",
            registryArtifactUrl: `http://127.0.0.1:${port}/artifact.mjs`,
            resolvedVersion: "1.2.3",
            sourceRegistry: "public-registry",
            versionRange: "latest",
          },
          workerOptions(cacheDir),
          controller.signal,
        ),
      (error: Error) =>
        /timed out|abort/i.test(String(error?.message ?? error)),
    );
    assert.equal(stalled, true, "the request reached the server");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an oversized artifact is refused without buffering it", async () => {
  const artifact = Buffer.alloc(64 * 1024, 7);
  const checksum = `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`;
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    await assert.rejects(
      () =>
        resolveActionPackage(
          {
            actionPackage: "@example/oversized",
            artifactChecksum: checksum,
            manifestSnapshot: remoteManifest("@example/oversized"),
            mediaType: "application/javascript",
            registryArtifactUrl: server.url,
            resolvedVersion: "1.2.3",
            sourceRegistry: "public-registry",
            versionRange: "latest",
          },
          workerOptions(cacheDir, { actionArtifactMaxBytes: 1024 }),
          neverAborted,
        ),
      /over the 1024 byte limit|exceeds the 1024 byte limit/,
    );
  } finally {
    await server.close();
  }
});

test("an undeclared oversized body is stopped by the running total", async () => {
  // Chunked transfer sends no Content-Length, so the header check cannot see
  // the size. Only the running byte total stops it, which is why both exist.
  const chunk = Buffer.alloc(16 * 1024, 9);
  let sentChunks = 0;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    const push = () => {
      if (sentChunks >= 16) return void response.end();
      sentChunks += 1;
      if (response.destroyed) return;
      if (response.write(chunk)) setTimeout(push, 10);
      else response.once("drain", push);
    };
    push();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  const cacheDir = await tempDir();

  try {
    await assert.rejects(
      () =>
        resolveActionPackage(
          {
            actionPackage: "@example/undeclared",
            artifactChecksum: `sha256:${"0".repeat(64)}`,
            manifestSnapshot: remoteManifest("@example/undeclared"),
            mediaType: "application/javascript",
            registryArtifactUrl: `http://127.0.0.1:${port}/artifact.mjs`,
            resolvedVersion: "1.2.3",
            sourceRegistry: "public-registry",
            versionRange: "latest",
          },
          workerOptions(cacheDir, { actionArtifactMaxBytes: 1024 }),
          neverAborted,
        ),
      /exceeds the 1024 byte limit/,
    );
    assert.ok(
      sentChunks < 16,
      "the download is cut off rather than read to completion",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cancelling a task stops artifact download retries", async () => {
  // Every attempt fails, so without the abort check the wrapper would keep
  // retrying after the task was already cancelled.
  const artifact = Buffer.from("export function execute() { return {}; }");
  const server = await artifactServer(artifact, { failFirstRequests: 99 });
  const cacheDir = await tempDir();
  const controller = new AbortController();

  try {
    const pending = resolveActionPackage(
      {
        actionPackage: "@example/cancelled",
        artifactChecksum: `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`,
        manifestSnapshot: remoteManifest("@example/cancelled"),
        mediaType: "application/javascript",
        registryArtifactUrl: server.url,
        resolvedVersion: "1.2.3",
        sourceRegistry: "public-registry",
        versionRange: "latest",
      },
      workerOptions(cacheDir),
      controller.signal,
    );
    controller.abort(new Error("Task cancelled."));
    await assert.rejects(
      () => pending,
      (error: Error) =>
        /cancelled|abort/i.test(String(error?.message ?? error)),
    );

    const afterCancel = server.requests();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      server.requests(),
      afterCancel,
      "no further attempt is made after cancellation",
    );
  } finally {
    await server.close();
  }
});

async function archiveFixture(packageName: string) {
  const sourceDir = await tempDir();
  await mkdir(path.join(sourceDir, "dist"), { recursive: true });
  await writeFile(
    path.join(sourceDir, "beam-action.json"),
    JSON.stringify({
      ...remoteManifest(packageName),
      entrypoint: "dist/index.mjs",
    }),
  );
  await writeFile(
    path.join(sourceDir, "dist", "index.mjs"),
    "export function execute() { return { outputs: { ok: true } }; }",
  );
  const archivePath = path.join(await tempDir(), "action.tgz");
  await tar.c({ cwd: sourceDir, file: archivePath, gzip: true }, [
    "beam-action.json",
    "dist",
  ]);
  const artifact = await readFile(archivePath);
  return {
    artifact,
    checksum: `sha256:${crypto.createHash("sha256").update(artifact).digest("hex")}`,
  };
}

function archiveStep(packageName: string, checksum: string, url: string) {
  return {
    actionPackage: packageName,
    artifactChecksum: checksum,
    manifestSnapshot: remoteManifest(packageName),
    mediaType: "application/gzip",
    registryArtifactUrl: url,
    resolvedVersion: "1.2.3",
    sourceRegistry: "public-registry",
    versionRange: "latest",
  };
}

test("an interrupted extraction never becomes a usable cache entry", async () => {
  // Reproduces the poisoned directory an older worker could leave behind: the
  // manifest present, the rest of the tree missing. It must be rebuilt, not
  // trusted and then failed on.
  const { artifact, checksum } = await archiveFixture("@example/interrupted");
  const cacheDir = await tempDir();
  const digest = checksum.replace("sha256:", "");
  const poisoned = path.join(cacheDir, digest);
  await mkdir(poisoned, { recursive: true });
  await writeFile(
    path.join(poisoned, "beam-action.json"),
    JSON.stringify({
      ...remoteManifest("@example/interrupted"),
      entrypoint: "dist/index.mjs",
    }),
  );
  const server = await artifactServer(artifact);

  try {
    const loaded = await resolveActionPackage(
      archiveStep("@example/interrupted", checksum, server.url),
      workerOptions(cacheDir),
      neverAborted,
    );
    assert.equal(loaded.source, "remote");
    assert.equal(
      existsSync(path.join(poisoned, "dist", "index.mjs")),
      true,
      "the partial entry is rebuilt rather than reused",
    );
  } finally {
    await server.close();
  }
});

test("concurrent loads of one checksum converge on a single entry", async () => {
  const { artifact, checksum } = await archiveFixture("@example/concurrent");
  const cacheDir = await tempDir();
  const server = await artifactServer(artifact);

  try {
    const loaded = await Promise.all(
      Array.from({ length: 4 }, () =>
        resolveActionPackage(
          archiveStep("@example/concurrent", checksum, server.url),
          workerOptions(cacheDir),
          neverAborted,
        ),
      ),
    );
    assert.equal(loaded.length, 4);
    for (const entry of loaded) assert.equal(entry.source, "remote");

    // Nothing half-written survives, and exactly one published entry exists.
    const entries = await readdir(cacheDir);
    assert.deepEqual(
      entries.filter((entry) => entry.endsWith(".partial")),
      [],
      "no temporary entry is left behind",
    );
    assert.deepEqual(
      entries.filter((entry) => entry === checksum.replace("sha256:", "")),
      [checksum.replace("sha256:", "")],
    );
  } finally {
    await server.close();
  }
});

test("stale temporary entries are swept from the cache directory", async () => {
  const { artifact, checksum } = await archiveFixture("@example/sweep");
  const cacheDir = await tempDir();
  const orphan = path.join(cacheDir, `${"a".repeat(64)}.abcd.partial`);
  await mkdir(orphan, { recursive: true });
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(orphan, stale, stale);
  const active = path.join(cacheDir, `${"b".repeat(64)}.active.partial`);
  await mkdir(active);
  const server = await artifactServer(artifact);

  try {
    await resolveActionPackage(
      archiveStep("@example/sweep", checksum, server.url),
      workerOptions(cacheDir),
      neverAborted,
    );
    assert.equal(existsSync(orphan), false, "the orphaned entry is removed");
    assert.equal(
      existsSync(active),
      true,
      "another loader's active entry survives",
    );
  } finally {
    await server.close();
  }
});
