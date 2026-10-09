import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { PgPool } from "@beam-studio/db";
import { localizeResultArtifacts } from "./services/workerFileArtifacts.js";
import { downloadWorkerFile } from "./services/workerFileResolver.js";
import {
  startWorkerFileServer,
  type WorkerFileServer,
} from "./services/workerFileServer.js";

let server: WorkerFileServer;

beforeEach(async () => {
  server = await startWorkerFileServer({
    workerId: "worker-test",
    host: "127.0.0.1",
    port: 0,
    signingSecret: "test-secret",
    maxTtlSeconds: 60,
    cleanupIntervalMs: 10_000,
  });
});

afterEach(async () => {
  await server.close();
});

test("serves published worker files with HEAD and GET", async () => {
  const published = await server.publishLocalFile({
    source: Buffer.from("hello worker"),
    mediaType: "text/plain",
  });

  const headResponse = await fetch(
    server.signedUrl(published.exportId, { method: "HEAD" }),
    { method: "HEAD" },
  );
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("accept-ranges"), "bytes");
  assert.equal(headResponse.headers.get("content-length"), "12");
  assert.equal(headResponse.headers.get("content-type"), "text/plain");
  assert.equal(headResponse.headers.get("etag"), `"${published.etag}"`);

  const getResponse = await fetch(server.signedUrl(published.exportId));
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get("content-length"), "12");
  assert.equal(await getResponse.text(), "hello worker");
});

test("supports simple, suffix, and open byte ranges", async () => {
  const published = await server.publishLocalFile({
    source: Buffer.from("0123456789"),
  });
  const url = server.signedUrl(published.exportId);

  const simpleRange = await fetch(url, { headers: { Range: "bytes=2-5" } });
  assert.equal(simpleRange.status, 206);
  assert.equal(simpleRange.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await simpleRange.text(), "2345");

  const suffixRange = await fetch(url, { headers: { Range: "bytes=-3" } });
  assert.equal(suffixRange.status, 206);
  assert.equal(suffixRange.headers.get("content-range"), "bytes 7-9/10");
  assert.equal(await suffixRange.text(), "789");

  const openRange = await fetch(url, { headers: { Range: "bytes=6-" } });
  assert.equal(openRange.status, 206);
  assert.equal(openRange.headers.get("content-range"), "bytes 6-9/10");
  assert.equal(await openRange.text(), "6789");
});

test("rejects invalid ranges with 416", async () => {
  const published = await server.publishLocalFile({
    source: Buffer.from("abc"),
  });

  const response = await fetch(server.signedUrl(published.exportId), {
    headers: { Range: "bytes=9-10" },
  });

  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */3");
});

test("rejects invalid, expired, and missing exports", async () => {
  const published = await server.publishLocalFile({
    source: Buffer.from("abc"),
  });

  const invalidSignature = new URL(server.signedUrl(published.exportId));
  invalidSignature.searchParams.set("sig", "bad");
  assert.equal((await fetch(invalidSignature)).status, 403);

  const expiredUrl = server.signedUrl(published.exportId, { ttlSeconds: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await fetch(expiredUrl)).status, 403);

  assert.equal((await fetch(server.signedUrl("exp_missing"))).status, 404);
});

test("localizes memory artifacts as worker file sources", async () => {
  const result = await localizeResultArtifacts(
    {
      outputs: {
        uri: "memory://artifacts/merged.csv",
        csv: "id,name\n1,Ada\n",
      },
      artifacts: [
        {
          name: "merged.csv",
          type: "dataset",
          uri: "memory://artifacts/merged.csv",
          mediaType: "text/csv",
        },
      ],
    },
    {
      config: {},
      inputs: {},
      fileServer: server,
    },
  );

  const artifact = result.artifacts?.[0];
  assert.ok(artifact?.uri.startsWith("beam-worker://worker-test/"));
  assert.equal(result.outputs?.uri, artifact?.uri);
  const fileExport = artifact?.metadata?.fileExport as
    | Record<string, unknown>
    | undefined;
  assert.equal(fileExport?.supportsRange, true);
});

test("downloads a worker file through runtime heartbeat resolution", async () => {
  const published = await server.publishLocalFile({
    source: Buffer.from("resolved content"),
    mediaType: "text/plain",
  });
  const pool = {
    query: async () => ({
      rows: [
        {
          status: "active",
          reachability: "local",
          heartbeat_at: new Date().toISOString(),
          metadata_json: {
            fileServer: server.metadata,
          },
        },
      ],
    }),
  } as unknown as PgPool;

  const downloaded = await downloadWorkerFile(pool, published.uri, {
    signingSecret: "test-secret",
  });

  assert.equal(downloaded.content, "resolved content");
  assert.equal(downloaded.bytes, 16);
  assert.equal(downloaded.mediaType, "text/plain");
  assert.equal(downloaded.metadata.sourceWorkerId, "worker-test");
});

test("requesting an expired export removes its temporary file", async () => {
  const tempFilePath = join(
    await mkdtemp(join(tmpdir(), "beam-export-")),
    "payload.bin",
  );
  await writeFile(tempFilePath, "expired payload");

  // A long sweep interval: the request itself has to do the cleanup, because
  // it drops the registry entry the sweep would otherwise find.
  const expiring = await startWorkerFileServer({
    workerId: "worker-expiry",
    host: "127.0.0.1",
    port: 0,
    signingSecret: "test-secret",
    maxTtlSeconds: 60,
    cleanupIntervalMs: 600_000,
  });
  try {
    const published = await expiring.publishLocalFile({
      source: { tempFilePath, deleteOnCleanup: true },
      ttlSeconds: 1,
    });
    const url = expiring.signedUrl(published.exportId, { ttlSeconds: 60 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const response = await fetch(url);
    assert.equal(response.status, 404);
    await response.arrayBuffer();

    assert.equal(
      existsSync(tempFilePath),
      false,
      "the expired export must not strand its temporary file",
    );
  } finally {
    await expiring.close();
    await rm(tempFilePath, { force: true });
  }
});

test("shutdown removes owned temporary files and leaves borrowed ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beam-export-"));
  const owned = join(directory, "owned.bin");
  const borrowed = join(directory, "borrowed.bin");
  await writeFile(owned, "owned");
  await writeFile(borrowed, "borrowed");

  const closing = await startWorkerFileServer({
    workerId: "worker-close",
    host: "127.0.0.1",
    port: 0,
    signingSecret: "test-secret",
    maxTtlSeconds: 60,
    cleanupIntervalMs: 600_000,
  });
  await closing.publishLocalFile({
    source: { tempFilePath: owned, deleteOnCleanup: true },
  });
  await closing.publishLocalFile({
    source: { tempFilePath: borrowed, deleteOnCleanup: false },
  });

  await closing.close();

  assert.equal(existsSync(owned), false, "owned files are removed on shutdown");
  assert.equal(
    existsSync(borrowed),
    true,
    "files the worker does not own are left alone",
  );
  await rm(directory, { force: true, recursive: true });
});

test("a failing cleanup is reported instead of rejecting unhandled", async () => {
  const errors: unknown[] = [];
  const directory = await mkdtemp(join(tmpdir(), "beam-export-"));
  const locked = join(directory, "locked");
  await mkdir(locked);
  const tempFilePath = join(locked, "payload.bin");
  await writeFile(tempFilePath, "payload");

  const failing = await startWorkerFileServer({
    workerId: "worker-cleanup-error",
    host: "127.0.0.1",
    port: 0,
    signingSecret: "test-secret",
    maxTtlSeconds: 60,
    cleanupIntervalMs: 600_000,
    onCleanupError: (error) => errors.push(error),
  });
  await failing.publishLocalFile({
    source: { tempFilePath, deleteOnCleanup: true },
  });

  // The file stays readable, so publishing works, but its directory is not
  // writable, so the unlink fails. The failure must be reported rather than
  // escaping as an unhandled rejection.
  await chmod(locked, 0o500);
  try {
    await failing.close();
    assert.equal(errors.length, 1, "the cleanup failure is observed");
    assert.equal(existsSync(tempFilePath), true);
  } finally {
    await chmod(locked, 0o700);
    await rm(directory, { force: true, recursive: true });
  }
});
