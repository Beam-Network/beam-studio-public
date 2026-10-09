import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import type { SqlDatabase } from "./sql-database.js";
import { compileNamedParameters } from "./sql-named-parameters.js";
import {
  logPostgresConnectionError,
  stderrPostgresErrorLogger,
  type PostgresErrorLogger,
} from "./postgres.js";

const RESULT_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

export type SynchronousPostgresOptions = {
  queryTimeoutMs?: number;
  /** Service logger for connection failures; stderr JSON without one. */
  logger?: PostgresErrorLogger;
  /** Names the connection in log lines, e.g. `mcp-store`. */
  name?: string;
};

/**
 * The bridge's worker thread holds one pg.Client. A PostgreSQL restart ends
 * that connection, and without care it used to end the process too: the
 * client emitted `error` with no listener, the worker died of it, and the
 * Worker's own `error` event had no listener in the main thread either (S22).
 * Now the client is dropped when its connection fails and the next query opens
 * a new one, the failure is reported to the main thread for logging, and a
 * dead worker is replaced before the next query instead of letting it wait
 * out the whole timeout.
 */
const workerSource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const { Client } = require(workerData.pgModulePath);
  const encoder = new TextEncoder();
  let current = null;

  const compile = ${compileNamedParameters.toString()};

  function describe(error) {
    const described = {};
    for (const key of ["name", "message", "code", "severity", "errno", "syscall", "hostname", "address", "port"]) {
      const value = error && error[key];
      if (typeof value === "string" || typeof value === "number") described[key] = value;
    }
    return described;
  }

  function connection() {
    if (current) return current.ready;
    const client = new Client({
      connectionString: workerData.connectionString,
      connectionTimeoutMillis: workerData.queryTimeoutMs,
      query_timeout: workerData.queryTimeoutMs,
      statement_timeout: workerData.queryTimeoutMs
    });
    const entry = { client, ready: null };
    const drop = () => {
      if (current === entry) current = null;
    };
    client.on("error", (error) => {
      const wasCurrent = current === entry;
      drop();
      if (wasCurrent) {
        parentPort.postMessage({ event: "connection-error", error: describe(error) });
      }
    });
    client.on("end", drop);
    entry.ready = client.connect().then(
      () => client,
      (error) => {
        drop();
        client.end().catch(() => {});
        throw error;
      }
    );
    current = entry;
    return entry.ready;
  }

  parentPort.on("message", async ({ control, output, sql, parameters, mode }) => {
    const state = new Int32Array(control);
    const bytes = new Uint8Array(output);
    try {
      const client = await connection();
      const query = compile(sql, parameters);
      const result = await client.query(query.text, query.values);
      const value =
        mode === "get" ? result.rows[0] :
        mode === "all" ? result.rows :
        { changes: result.rowCount || 0 };
      const encoded = encoder.encode(JSON.stringify({ value }));
      if (encoded.length > bytes.length) {
        throw new Error("PostgreSQL synchronous result exceeds 16 MiB.");
      }
      bytes.set(encoded);
      Atomics.store(state, 1, encoded.length);
      Atomics.store(state, 0, 1);
    } catch (error) {
      const described = describe(error);
      const encoded = encoder.encode(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        code: described.code,
        severity: described.severity
      }));
      bytes.set(encoded.subarray(0, bytes.length));
      Atomics.store(state, 1, Math.min(encoded.length, bytes.length));
      Atomics.store(state, 0, 2);
    }
    Atomics.notify(state, 0);
  });
`;

export function openSynchronousPostgres(
  databaseUrl: string,
  options: SynchronousPostgresOptions = {},
): SqlDatabase {
  const pgModulePath = createRequire(import.meta.url).resolve("pg");
  const queryTimeoutMs = positiveTimeout(
    options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
  );
  const logger = options.logger ?? stderrPostgresErrorLogger;
  let closed = false;
  let workerFailed = false;
  let worker = createWorker();

  function createWorker() {
    const created = new Worker(workerSource, {
      eval: true,
      workerData: {
        connectionString: databaseUrl,
        pgModulePath,
        queryTimeoutMs,
      },
    });
    created.on("message", (message: unknown) => {
      const event = message as { event?: unknown; error?: unknown };
      if (event?.event !== "connection-error") return;
      logPostgresConnectionError(
        logger,
        event.error,
        "PostgreSQL connection failed; the next query will reconnect",
        options.name,
      );
    });
    // Without these listeners a crashed worker is an uncaught `error` event
    // in the main thread, which ends the process.
    created.on("error", (error) => {
      if (created !== worker || closed) return;
      workerFailed = true;
      logPostgresConnectionError(
        logger,
        error,
        "PostgreSQL synchronous bridge failed; it restarts on the next query",
        options.name,
      );
    });
    created.on("exit", () => {
      if (created === worker && !closed) workerFailed = true;
    });
    // The worker must not hold the event loop open by itself. Queries block the
    // calling thread in Atomics.wait, so the process cannot exit mid-query
    // anyway; without this, a caller that never reaches close() — a failing
    // test suite, for instance — leaves the process alive indefinitely.
    created.unref();
    return created;
  }

  function replaceWorker() {
    const staleWorker = worker;
    workerFailed = false;
    worker = createWorker();
    void staleWorker.terminate();
  }

  function execute(
    sql: string,
    parameters: unknown[] | Record<string, unknown> = {},
    mode: "all" | "get" | "run" = "run",
  ) {
    if (closed) {
      throw new Error("PostgreSQL synchronous bridge is closed.");
    }
    if (workerFailed) {
      replaceWorker();
    }
    const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const output = new SharedArrayBuffer(RESULT_BUFFER_BYTES);
    const state = new Int32Array(control);
    worker.postMessage({ control, output, sql, parameters, mode });
    const waitResult = Atomics.wait(state, 0, 0, queryTimeoutMs);
    if (waitResult === "timed-out") {
      replaceWorker();
      throw new Error(
        `PostgreSQL synchronous query timed out after ${queryTimeoutMs} ms.`,
      );
    }
    const length = Atomics.load(state, 1);
    const decoded = new TextDecoder().decode(
      new Uint8Array(output, 0, length),
    );
    const result = JSON.parse(decoded) as {
      value?: unknown;
      error?: string;
      code?: string;
      severity?: string;
    };
    if (result.error) {
      // The SQLSTATE or socket code is kept so callers can tell an
      // unreachable database (503) from a failed query.
      throw Object.assign(new Error(result.error), {
        ...(result.code ? { code: result.code } : {}),
        ...(result.severity ? { severity: result.severity } : {}),
      });
    }
    return result.value;
  }

  return {
    close() {
      closed = true;
      void worker.terminate();
    },
    exec(sql) {
      execute(sql);
    },
    prepare(sql) {
      return {
        all(parameters?: unknown) {
          return execute(
            sql,
            normalizeParameters(parameters),
            "all",
          ) as Record<string, unknown>[];
        },
        get(parameters?: unknown) {
          return execute(
            sql,
            normalizeParameters(parameters),
            "get",
          ) as Record<string, unknown> | undefined;
        },
        run(parameters?: unknown) {
          return execute(sql, normalizeParameters(parameters), "run") as {
            changes: number;
          };
        },
      };
    },
  };
}

function positiveTimeout(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("queryTimeoutMs must be a positive number.");
  }
  return Math.trunc(value);
}

function normalizeParameters(value: unknown) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (value === undefined) {
    return {};
  }
  return [value];
}
