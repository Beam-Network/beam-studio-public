import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { FastifyInstance } from "fastify";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { createApiLogger } from "./logging.js";

// S22: stopping PostgreSQL ended the API process (`Unhandled 'error' event`
// on the pool), so clients saw connection resets. The API must log the lost
// connections, answer 503 while the database is down and serve requests again
// once it is back, without a restart.

function capture() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        raw.push(line);
        lines.push(JSON.parse(line));
      }
      done();
    },
  });
  return { stream, lines, raw };
}

test("the API pool error line carries no database password", () => {
  const { stream, lines, raw } = capture();
  const logger = createApiLogger("t", { LOG_LEVEL: "info" }, stream);
  const secretUrl =
    "postgres://beam:s22-api-log-password@postgres:5432/beam_studio";
  const pool = createPostgresPool(secretUrl, { logger, name: "api" });
  // What pg-pool emits: the error carries the failed client, whose
  // connection parameters hold the password.
  const error = Object.assign(
    new Error(`terminating connection to ${secretUrl}`),
    {
      code: "57P01",
      severity: "FATAL",
      client: {
        password: "s22-api-log-password",
        connectionParameters: {
          user: "beam",
          password: "s22-api-log-password",
          connectionString: secretUrl,
        },
      },
    },
  );

  assert.doesNotThrow(() => pool.emit("error", error));
  void pool.end();

  assert.equal(lines.length, 1, raw.join("\n"));
  assert.equal(
    lines[0]!.msg,
    "PostgreSQL idle connection failed; the pool will reconnect when needed",
  );
  assert.equal(lines[0]!.pool, "api");
  assert.equal(lines[0]!.postgresCode, "57P01");
  assert.equal(raw.join("\n").includes("s22-api-log-password"), false);
  assert.match(raw[0]!, /postgres:\/\/beam:\[REDACTED\]@postgres/);
});

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
 * A TCP proxy in front of PostgreSQL in its own thread (the Studio store's
 * synchronous bridge blocks the main thread during a query), so the test can
 * take the database down and back up without touching the shared server.
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

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres")) {
  throw new Error("The PostgreSQL outage test requires isolated PostgreSQL.");
}

test(
  "the API survives terminated connections and a database outage",
  { skip: !source?.startsWith("postgres"), timeout: 90_000 },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const previousUrl = process.env.DATABASE_URL;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    // Scratch database; only its backends are ever terminated.
    const admin = createPostgresPool(source);
    const database = `s22_api_${randomBytes(6).toString("hex")}`;
    const direct = new URL(source!);
    const proxy = await startProxy({
      host: direct.hostname,
      port: Number(direct.port || 5432),
    });
    const globals = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
      __beamStudioDb?: { close?: () => void };
    };
    const previousPool = globals.__beamStudioPgPool;
    const { stream, lines, raw } = capture();
    const logger = createApiLogger("t", { LOG_LEVEL: "info" }, stream);
    let pool: PgPool | undefined;
    let server: FastifyInstance | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const directUrl = new URL(source!);
      directUrl.pathname = `/${database}`;
      const seed = createPostgresPool(directUrl.toString());
      try {
        await ensurePostgresMigrations(seed);
        await seed.query(
          "INSERT INTO identity.organizations(id,slug,name) VALUES('s22_org','s22-org','S22')",
        );
        await seed.query(
          "UPDATE studio.instance SET state='claimed', owner_organization_id='s22_org' WHERE id='singleton'",
        );
        await seed.query(
          "INSERT INTO studio.instance_organizations(organization_id,role,status) VALUES('s22_org','owner','admitted')",
        );
      } finally {
        await seed.end();
      }

      const url = new URL(directUrl);
      url.hostname = "127.0.0.1";
      url.port = String(proxy.port);
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString(), { logger, name: "api" });
      globals.__beamStudioPgPool = pool;

      const { buildServer } = await import("./server.js");
      const { createInstanceAdmission } =
        await import("./auth/instance-admission.js");
      const { createStudioBrowserSession, STUDIO_SESSION_COOKIE } =
        await import("./auth/browser-session.js");
      const services = {
        oauth: { hasSession: async () => true },
        beamApi: {
          getJson: async (path: string) =>
            path.startsWith("/api/organizations")
              ? { organizations: [{ id: "s22_org", role: "admin" }] }
              : path.startsWith("/api/projects")
                ? { projects: [] }
                : {
                    id: "s22-user",
                    email: "s22@localhost",
                    accountType: "admin",
                  },
        },
      };
      server = await buildServer({
        pgPool: pool,
        logger,
        admission: createInstanceAdmission({ pool, ttlMs: 0 }),
        sessions: {
          get: (cookie: string | null) => (cookie ? services : null),
          shutdown: () => {},
        } as never,
      });
      const headers = {
        "x-organization-id": "s22_org",
        origin: "http://localhost:5173",
        cookie: `${STUDIO_SESSION_COOKIE}=${createStudioBrowserSession("s22-outage-test-secret")}`,
      };
      const get = (url: string) =>
        server!.inject({ method: "GET", url, headers });
      // /studio/state reads through both the pool and the store's synchronous
      // bridge; /studio/workflows through the pool.
      const assertServing = async (when: string) => {
        for (const path of ["/studio/state", "/studio/workflows"]) {
          const response = await get(path);
          assert.equal(
            response.statusCode,
            200,
            `${when} ${path}: ${response.body}`,
          );
        }
        const health = await get("/health");
        assert.equal(health.statusCode, 200, `${when} /health: ${health.body}`);
        assert.deepEqual(health.json().checks, {
          telemetry: "ok",
          database: "ok",
        });
      };

      await assertServing("before");

      // What `docker stop postgres` does to open connections.
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [database],
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (lines.some((line) => line.pool === "api")) break;
        await sleep(50);
      }
      const idleFailure = lines.find((line) => line.pool === "api");
      assert.ok(
        idleFailure,
        `the lost connection is logged: ${raw.join("\n")}`,
      );
      assert.equal(
        idleFailure.msg,
        "PostgreSQL idle connection failed; the pool will reconnect when needed",
      );
      assert.equal(idleFailure.postgresCode, "57P01");
      await sleep(200);
      await assertServing("after terminated connections");

      // The database is unreachable: JSON errors, not connection resets.
      await proxy.down();
      for (const path of ["/studio/state", "/studio/workflows"]) {
        const response = await get(path);
        assert.equal(response.statusCode, 503, `${path}: ${response.body}`);
        const body = response.json();
        assert.equal(body.code, "database_unavailable");
        assert.equal(body.retryable, true);
      }
      const down = await get("/health");
      assert.equal(down.statusCode, 503, down.body);
      assert.deepEqual(down.json().checks, {
        telemetry: "ok",
        database: "unavailable",
      });
      assert.equal(down.json().code, "database_unavailable");
      assert.equal((await get("/studio/health")).statusCode, 503);

      // Back up: the same process serves again.
      await proxy.up();
      await assertServing("after the outage");

      if (url.password) {
        assert.equal(
          raw.join("\n").includes(`:${url.password}@`),
          false,
          "no log line carries the connection password",
        );
      }
    } finally {
      await server?.close();
      globals.__beamStudioDb?.close?.();
      delete globals.__beamStudioDb;
      globals.__beamStudioPgPool = previousPool;
      await pool?.end();
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
