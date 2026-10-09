import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import pg from "pg";
import {
  createPostgresPool,
  describePostgresError,
  isPostgresUnavailableError,
  registerPostgresPoolErrorHandler,
  withPostgresTransaction,
  type PgPool,
  type PostgresErrorLogger,
} from "./postgres.js";
import { openSynchronousPostgres } from "./sync-postgres.js";

// S22: a PostgreSQL restart ended the API and MCP processes with an
// unhandled `error` event. Every pool and the synchronous bridge must log a
// lost connection and serve the next query from a new one.

type Entry = { payload: Record<string, unknown>; message: string };

function captureLogger() {
  const entries: Entry[] = [];
  const logger: PostgresErrorLogger = {
    error(payload, message) {
      entries.push({ payload: payload as Record<string, unknown>, message });
    },
  };
  return { entries, logger };
}

const UNREACHABLE_URL =
  "postgres://beam:s22-pool-password@127.0.0.1:1/beam_studio";

test("a factory pool logs an idle client error instead of crashing", () => {
  const { entries, logger } = captureLogger();
  const pool = createPostgresPool(UNREACHABLE_URL, { logger, name: "api" });
  // pg-pool attaches the failed client to the error it emits; that client
  // carries the connection parameters, password included.
  const client = new pg.Client({ connectionString: UNREACHABLE_URL });
  const error = Object.assign(
    new Error("terminating connection due to administrator command"),
    { code: "57P01", severity: "FATAL", client },
  );

  assert.doesNotThrow(() => pool.emit("error", error, client));

  assert.equal(entries.length, 1);
  assert.equal(
    entries[0]!.message,
    "PostgreSQL idle connection failed; the pool will reconnect when needed",
  );
  assert.deepEqual(entries[0]!.payload, {
    pool: "api",
    error: {
      name: "Error",
      message: "terminating connection due to administrator command",
      code: "57P01",
      severity: "FATAL",
    },
    postgresCode: "57P01",
    postgresSeverity: "FATAL",
  });
  assert.equal(
    JSON.stringify(entries).includes("s22-pool-password"),
    false,
    "the logged fields never carry the client or its password",
  );
  void pool.end();
});

test("a pool created without a logger still handles idle errors", () => {
  const pool = createPostgresPool(UNREACHABLE_URL);
  const write = process.stderr.write;
  const written: string[] = [];
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.doesNotThrow(() =>
      pool.emit("error", new Error("Connection terminated unexpectedly")),
    );
  } finally {
    process.stderr.write = write;
  }
  assert.equal(written.length, 1);
  const line = JSON.parse(written[0]!);
  assert.equal(line.level, "error");
  assert.equal(line.error.message, "Connection terminated unexpectedly");
  void pool.end();
});

test("registering a service logger replaces the default, never doubles it", () => {
  const first = captureLogger();
  const second = captureLogger();
  const pool = createPostgresPool(UNREACHABLE_URL, { logger: first.logger });
  registerPostgresPoolErrorHandler(pool, second.logger, "worker");

  pool.emit("error", new Error("Connection terminated unexpectedly"));

  assert.equal(pool.listenerCount("error"), 1);
  assert.equal(first.entries.length, 0);
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0]!.payload.pool, "worker");
  void pool.end();
});

test("a checked-out client losing its connection does not crash", () => {
  const pool = createPostgresPool(UNREACHABLE_URL);
  const client = new EventEmitter();
  pool.emit("connect", client);
  // pg-pool removes its own listener while a client is checked out, so this
  // listener is the only thing between the event and an uncaught exception.
  assert.doesNotThrow(() =>
    client.emit("error", new Error("Connection terminated unexpectedly")),
  );
  void pool.end();
});

test("unavailable-database errors are told apart from query errors", () => {
  for (const error of [
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    }),
    Object.assign(new Error("getaddrinfo ENOTFOUND postgres"), {
      code: "ENOTFOUND",
    }),
    Object.assign(
      new Error("terminating connection due to administrator command"),
      { code: "57P01" },
    ),
    Object.assign(new Error("the database system is starting up"), {
      code: "57P03",
    }),
    Object.assign(new Error("connection failure"), { code: "08006" }),
    Object.assign(
      new Error(
        'database "beam_studio" is not currently accepting connections',
      ),
      { code: "55000" },
    ),
    new Error("Connection terminated unexpectedly"),
    new Error("Client has encountered a connection error and is not queryable"),
    new Error("wrapped", {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    }),
    new AggregateError([
      Object.assign(new Error("connect ECONNREFUSED ::1:5432"), {
        code: "ECONNREFUSED",
      }),
    ]),
  ]) {
    assert.equal(isPostgresUnavailableError(error), true, error.message);
  }
  for (const error of [
    Object.assign(new Error("duplicate key"), { code: "23505" }),
    Object.assign(new Error('relation "x" does not exist'), { code: "42P01" }),
    Object.assign(new Error("sequence is not yet defined in this session"), {
      code: "55000",
    }),
    new Error("Invalid workflow"),
    null,
    "ECONNREFUSED",
  ]) {
    assert.equal(isPostgresUnavailableError(error), false, String(error));
  }
});

test("describePostgresError keeps only primitive, non-secret fields", () => {
  const described = describePostgresError(
    Object.assign(new Error("boom"), {
      code: "ECONNREFUSED",
      errno: -61,
      syscall: "connect",
      address: "127.0.0.1",
      port: 5432,
      client: { password: "never" },
      config: { connectionString: "postgres://u:never@h/db" },
    }),
  );
  assert.deepEqual(described, {
    name: "Error",
    message: "boom",
    code: "ECONNREFUSED",
    errno: -61,
    syscall: "connect",
    address: "127.0.0.1",
    port: 5432,
  });
});

test("the synchronous bridge reports an unreachable database without crashing", () => {
  const { entries, logger } = captureLogger();
  const database = openSynchronousPostgres(UNREACHABLE_URL, {
    queryTimeoutMs: 5_000,
    logger,
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => database.prepare("SELECT 1").get(),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "ECONNREFUSED");
          assert.equal(isPostgresUnavailableError(error), true);
          return true;
        },
      );
    }
  } finally {
    database.close?.();
  }
  assert.equal(JSON.stringify(entries).includes("s22-pool-password"), false);
});

/**
 * A TCP proxy in front of PostgreSQL, so a test can take "the database" down
 * and bring it back without touching the shared server. It runs in its own
 * thread: the synchronous bridge blocks the main thread while it waits for a
 * query, so a proxy on the main event loop would never forward it.
 */
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

async function startProxy(target: { host: string; port: number }) {
  const worker = new Worker(proxySource, { eval: true, workerData: target });
  const reply = () =>
    new Promise<number>((resolve) =>
      worker.once("message", (message: { port: number }) =>
        resolve(message.port),
      ),
    );
  const port = await reply();
  let running = true;
  return {
    port,
    async down() {
      if (!running) return;
      running = false;
      worker.postMessage("down");
      await reply();
    },
    async up() {
      if (running) return;
      running = true;
      worker.postMessage("up");
      await reply();
    },
    stop: () => worker.terminate(),
  };
}

async function eventually(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await sleep(50);
  }
  assert.fail(message);
}

/**
 * `probe` once the connection has recovered. Under load a pool can still hand
 * out an idle client whose termination it has not processed yet, or the proxy
 * can take a moment to accept again; each such attempt fails as unavailable.
 * Retrying those (and only those) for a bounded time is what "recovers" means,
 * rather than racing the first query against the reconnect.
 */
async function recovered<T>(
  probe: () => T | Promise<T>,
  message: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await probe();
    } catch (error) {
      if (!isPostgresUnavailableError(error)) throw error;
      lastError = error;
      await sleep(100);
    }
  }
  assert.fail(
    `${message}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

test(
  "pools and the synchronous bridge recover from terminated backends and an outage",
  { skip: !source?.startsWith("postgres"), timeout: 60_000 },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    // Scratch database: backends are terminated only where datname matches it.
    const admin = createPostgresPool(source);
    const database = `s22_pool_${randomBytes(6).toString("hex")}`;
    const direct = new URL(source!);
    const proxy = await startProxy({
      host: direct.hostname,
      port: Number(direct.port || 5432),
    });
    const url = new URL(source!);
    url.hostname = "127.0.0.1";
    url.port = String(proxy.port);
    url.pathname = `/${database}`;
    const poolLog = captureLogger();
    const bridgeLog = captureLogger();
    let pool: PgPool | undefined;
    let bridge: ReturnType<typeof openSynchronousPostgres> | undefined;
    const terminate = () =>
      admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [database],
      );
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      pool = createPostgresPool(url.toString(), {
        logger: poolLog.logger,
        name: "scratch",
      });
      bridge = openSynchronousPostgres(url.toString(), {
        queryTimeoutMs: 5_000,
        logger: bridgeLog.logger,
        name: "scratch-sync",
      });
      const bridgeValue = () =>
        bridge!.prepare("SELECT 1 AS value").get()?.value;

      // Idle connections terminated by the server (what `docker stop` does).
      await Promise.all([pool.query("SELECT 1"), pool.query("SELECT 1")]);
      assert.equal(bridgeValue(), 1);
      await terminate();
      await eventually(
        () => poolLog.entries.length > 0 && bridgeLog.entries.length > 0,
        "both connections report the terminated backend",
      );
      assert.equal(poolLog.entries[0]!.payload.postgresCode, "57P01");
      const poolValue = async () =>
        (await pool!.query("SELECT 1 AS value")).rows[0].value;
      assert.equal(
        await recovered(poolValue, "the pool serves a new connection"),
        1,
      );
      assert.equal(await recovered(bridgeValue, "the bridge reconnects"), 1);

      // A connection terminated while checked out, in a transaction.
      const transaction = withPostgresTransaction(pool, async (client) => {
        await client.query("SELECT pg_sleep(10)");
      });
      await eventually(() => pool!.totalCount > pool!.idleCount, "checked out");
      await sleep(100);
      await terminate();
      await assert.rejects(transaction, (error: unknown) =>
        isPostgresUnavailableError(error),
      );
      assert.equal(
        await recovered(poolValue, "the pool recovers after the transaction"),
        1,
      );

      // The server is unreachable, then back.
      await proxy.down();
      await assert.rejects(pool.query("SELECT 1"), (error: unknown) =>
        isPostgresUnavailableError(error),
      );
      assert.throws(bridgeValue, (error: unknown) =>
        isPostgresUnavailableError(error),
      );
      await proxy.up();
      assert.equal(
        await recovered(poolValue, "the pool recovers after the outage"),
        1,
      );
      assert.equal(
        await recovered(bridgeValue, "the bridge recovers after the outage"),
        1,
      );
    } finally {
      bridge?.close?.();
      await pool?.end();
      await proxy.stop();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
      if (previousAllow === undefined) {
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      } else {
        process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previousAllow;
      }
    }
  },
);
