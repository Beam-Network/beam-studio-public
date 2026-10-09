import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  isPostgresUnavailableError,
} from "@beam-studio/db";

// S22: a PostgreSQL restart ended the MCP server. Its store reads through the
// synchronous bridge; a lost or refused connection must surface as an error
// the request handler can answer (503), and the next query after the
// database is back must succeed in the same process.

const proxySource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const net = require("node:net");
  const sockets = new Set();
  let server;
  let port = 0;
  function listen() {
    server = net.createServer((incoming) => {
      const outgoing = net.connect(workerData.port, workerData.host);
      for (const socket of [incoming, outgoing]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {
          incoming.destroy();
          outgoing.destroy();
        });
      }
      incoming.pipe(outgoing).pipe(incoming);
    });
    server.listen(port, "127.0.0.1", () => {
      port = server.address().port;
      parentPort.postMessage({ port });
    });
  }
  parentPort.on("message", (command) => {
    if (command === "up") return listen();
    server.close(() => parentPort.postMessage({ port }));
    for (const socket of sockets) socket.destroy();
  });
  listen();
`;

/**
 * A TCP proxy in its own thread (the bridge blocks the main thread during a
 * query), so the test can take the database down without touching the
 * shared server.
 */
async function startProxy(target: { host: string; port: number }) {
  const worker = new Worker(proxySource, { eval: true, workerData: target });
  const reply = () =>
    new Promise<number>((resolve) =>
      worker.once("message", (message: { port: number }) =>
        resolve(message.port),
      ),
    );
  const port = await reply();
  return {
    port,
    async down() {
      worker.postMessage("down");
      await reply();
    },
    async up() {
      worker.postMessage("up");
      await reply();
    },
    stop: () => worker.terminate(),
  };
}

const source =
  process.env.BEAM_TEST_POSTGRES_URL ??
  process.env.MCP_TEST_DATABASE_URL ??
  process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres")) {
  throw new Error("The PostgreSQL outage test requires isolated PostgreSQL.");
}

test(
  "the MCP store survives terminated connections and a database outage",
  { skip: !source?.startsWith("postgres"), timeout: 60_000 },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const previousUrl = process.env.DATABASE_URL;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    // Scratch database; only its backends are ever terminated.
    const admin = createPostgresPool(source);
    const database = `s22_mcp_${randomBytes(6).toString("hex")}`;
    const direct = new URL(source!);
    const proxy = await startProxy({
      host: direct.hostname,
      port: Number(direct.port || 5432),
    });
    let store: typeof import("./studio-store.js") | undefined;
    const unservedToken = "beam_mcp_s22_unserved_organization";
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const directUrl = new URL(source!);
      directUrl.pathname = `/${database}`;
      const seed = createPostgresPool(directUrl.toString());
      try {
        await ensurePostgresMigrations(seed);
        await seed.query(
          "INSERT INTO identity.organizations(id,slug,name) VALUES('s22_mcp_org','s22-mcp-org','S22')",
        );
        await seed.query(
          `INSERT INTO mcp.tokens(id,organization_id,name,token_hash,prefix,scopes_json,created_at,updated_at)
           VALUES('s22_mcp_token','s22_mcp_org','S22',$1,'beam_mcp_s22','["read:runs"]',now(),now())`,
          [createHash("sha256").update(unservedToken).digest("hex")],
        );
      } finally {
        await seed.end();
      }
      const url = new URL(directUrl);
      url.hostname = "127.0.0.1";
      url.port = String(proxy.port);
      process.env.DATABASE_URL = url.toString();

      store = await import("./studio-store.js");
      assert.deepEqual(store.checkStudioDatabase(), { ok: true });
      assert.equal(await store.authenticateMcpToken("beam_mcp_unknown"), null);
      await assert.rejects(
        () => store!.authenticateMcpToken(unservedToken),
        (error: unknown) =>
          error instanceof store!.McpOrganizationNotAdmittedError,
      );

      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [database],
      );
      await sleep(300);
      assert.equal(
        await store.authenticateMcpToken("beam_mcp_unknown"),
        null,
        "the next query after the terminated connection succeeds",
      );

      await proxy.down();
      assert.deepEqual(store.checkStudioDatabase(), { ok: false });
      await assert.rejects(
        () => store!.authenticateMcpToken("beam_mcp_unknown"),
        (error: unknown) => isPostgresUnavailableError(error),
      );
      // An outage is never reported as a refusal: the admission read fails
      // like any other query and the handler answers 503.
      await assert.rejects(
        () => store!.authenticateMcpToken(unservedToken),
        (error: unknown) => isPostgresUnavailableError(error),
      );

      await proxy.up();
      assert.deepEqual(store.checkStudioDatabase(), { ok: true });
      assert.equal(await store.authenticateMcpToken("beam_mcp_unknown"), null);
    } finally {
      store?.closeStudioStore();
      await proxy.stop();
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
