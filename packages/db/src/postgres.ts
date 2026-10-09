import pg from "pg";
import { maskUrlCredentials } from "@beam-studio/shared/logging";
import { readOrchestrationDatabaseConfig } from "./database-url.js";

const { Pool } = pg;

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;
export type PgQueryResult<T extends Record<string, unknown> = Record<string, unknown>> =
  pg.QueryResult<T>;

/** The part of a service logger (pino) the pool error handling writes to. */
export type PostgresErrorLogger = {
  error(payload: unknown, message: string): void;
};

export type PostgresPoolOptions = {
  /**
   * The service logger (from `createServiceLogger`), so the line gets the
   * service's level, redaction and URL credential mask. Without one, failures
   * are written to stderr as a JSON line with the same safe fields.
   */
  logger?: PostgresErrorLogger;
  /** Names the pool in log lines, e.g. `api` or `studio-store`. */
  name?: string;
};

/**
 * Every long-lived pool is created here, and this is what keeps a PostgreSQL
 * restart from killing the process.
 *
 * node-postgres emits `error` on the pool when an idle client's connection
 * dies (`terminating connection due to administrator command`, a network
 * drop), and an `error` event without a listener is thrown by Node as an
 * uncaught exception. The pool has already discarded that client by then; the
 * next query opens a new connection. So the listener is registered here, for
 * every pool, rather than left to each service's startup code, where the API
 * and the MCP server once forgot it (S22).
 */
export function createPostgresPool(
  databaseUrl?: string,
  options: PostgresPoolOptions = {},
) {
  const config = readOrchestrationDatabaseConfig();
  const connectionString = databaseUrl ?? config.postgresUrl;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for PostgreSQL.");
  }
  assertBeamStudioDatabase(connectionString);
  const pool = new Pool({ connectionString });
  // A checked-out client (inside withPostgresTransaction, say) has no pool
  // listener: pg-pool removes it on checkout. When the server ends that
  // connection, the running query rejects and the client then emits
  // `error` ("Connection terminated unexpectedly") with nothing listening.
  // The caller already sees the failure through its query, and release()
  // drops the broken client, so this listener only has to exist.
  pool.on("connect", (client) => {
    client.on("error", ignoreCheckedOutClientError);
  });
  registerPostgresPoolErrorHandler(
    pool,
    options.logger ?? stderrPostgresErrorLogger,
    options.name,
  );
  return pool;
}

function ignoreCheckedOutClientError() {}

function assertBeamStudioDatabase(connectionString: string) {
  if (process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE === "true") {
    return;
  }

  const databaseName = new URL(connectionString).pathname.replace(/^\/+/, "");
  if (databaseName !== "beam_studio") {
    throw new Error(
      `PostgreSQL target database must be "beam_studio"; received "${databaseName || "(none)"}".`,
    );
  }
}

const poolErrorLoggers = new WeakMap<
  PgPool,
  { logger: PostgresErrorLogger; name?: string }
>();

/**
 * Logs idle-connection failures of `pgPool` through `logger` instead of
 * letting them crash the process. {@link createPostgresPool} already calls
 * this; calling it again only replaces the logger, so a pool never logs a
 * failure twice.
 */
export function registerPostgresPoolErrorHandler(
  pgPool: PgPool,
  logger: PostgresErrorLogger,
  name?: string,
) {
  const listening = poolErrorLoggers.has(pgPool);
  poolErrorLoggers.set(pgPool, {
    logger,
    name: name ?? poolErrorLoggers.get(pgPool)?.name,
  });
  if (listening) return;
  pgPool.on("error", (error) => {
    const target = poolErrorLoggers.get(pgPool);
    if (!target) return;
    logPostgresConnectionError(
      target.logger,
      error,
      "PostgreSQL idle connection failed; the pool will reconnect when needed",
      target.name,
    );
  });
}

/**
 * The fields of a PostgreSQL or socket error that are safe to log.
 *
 * Never the error object itself: pg-pool attaches the failed `client` to it,
 * and that client carries the connection parameters, so serializing the whole
 * error could write the database password.
 */
export function describePostgresError(error: unknown) {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  const value = error as Record<string, unknown>;
  const described: Record<string, string | number> = {};
  for (const key of [
    "name",
    "message",
    "code",
    "severity",
    "errno",
    "syscall",
    "hostname",
    "address",
    "port",
  ]) {
    const field = value[key];
    if (typeof field === "string" || typeof field === "number") {
      described[key] = field;
    }
  }
  return described;
}

export function logPostgresConnectionError(
  logger: PostgresErrorLogger,
  error: unknown,
  message: string,
  pool?: string,
) {
  const described = describePostgresError(error);
  try {
    logger.error(
      {
        ...(pool ? { pool } : {}),
        error: described,
        postgresCode: described.code,
        postgresSeverity: described.severity,
      },
      message,
    );
  } catch {
    // Logging must never be what turns a recoverable failure into a crash.
  }
}

/** Used when a pool is created without a service logger (CLIs, tests). */
export const stderrPostgresErrorLogger: PostgresErrorLogger = {
  error(payload, message) {
    process.stderr.write(
      `${maskUrlCredentials(
        JSON.stringify({
          level: "error",
          time: Date.now(),
          ...(payload && typeof payload === "object" ? payload : {}),
          msg: message,
        }),
      )}\n`,
    );
  },
};

/** Socket errors that mean the server could not be reached or went away. */
const UNAVAILABLE_ERRNO_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
]);

/** SQLSTATEs for a server that is shutting down, starting or saturated. */
const UNAVAILABLE_SQLSTATES = new Set([
  "57P01", // admin_shutdown: terminated by pg_terminate_backend or a stop
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now: starting up or shutting down
  "53300", // too_many_connections
]);

const UNAVAILABLE_MESSAGES = [
  "Connection terminated",
  "connection timeout",
  "timeout exceeded when trying to connect",
  "is not queryable",
  "the database system is starting up",
  "the database system is shutting down",
  // SQLSTATE 55000 is generic (object_not_in_prerequisite_state), so only this
  // message marks it as an outage: the database refuses new connections, e.g.
  // ALTER DATABASE ... ALLOW_CONNECTIONS false during maintenance.
  "is not currently accepting connections",
];

/**
 * Whether `error` means PostgreSQL is unreachable or restarting, rather than a
 * problem with the query. Such a request is answered 503 and can be retried.
 */
export function isPostgresUnavailableError(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current && typeof current === "object" && depth < 5;
    current = (current as { cause?: unknown }).cause, depth += 1
  ) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (typeof code === "string") {
      if (UNAVAILABLE_ERRNO_CODES.has(code)) return true;
      if (UNAVAILABLE_SQLSTATES.has(code) || code.startsWith("08")) {
        return true;
      }
    }
    if (
      typeof message === "string" &&
      UNAVAILABLE_MESSAGES.some((fragment) => message.includes(fragment))
    ) {
      return true;
    }
    if (current instanceof AggregateError) {
      if (current.errors.some((inner) => isPostgresUnavailableError(inner))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * `SELECT 1` bounded by `timeoutMs`, for health endpoints: a pool whose server
 * is unreachable can otherwise wait on a connection attempt for a long time.
 */
export async function checkPostgres(pool: PgPool, timeoutMs = 2_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(
            new Error(`PostgreSQL did not answer within ${timeoutMs} ms.`),
            { code: "ETIMEDOUT" },
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });
  const query = pool.query("SELECT 1");
  // A query that settles after the timeout must not become an unhandled
  // rejection.
  query.catch(() => {});
  try {
    await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function withPostgresTransaction<T>(
  pool: PgPool,
  callback: (client: PgClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function pgOne<T extends Record<string, unknown>>(
  client: PgPool | PgClient,
  sql: string,
  values: unknown[] = [],
) {
  const result = await client.query<T>(sql, values);
  return result.rows[0];
}

export async function pgMany<T extends Record<string, unknown>>(
  client: PgPool | PgClient,
  sql: string,
  values: unknown[] = [],
) {
  const result = await client.query<T>(sql, values);
  return result.rows;
}
