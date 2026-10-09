import { setTimeout as delay } from "node:timers/promises";

const MIGRATION_LOCK_ID = 872_048_731;
const TRANSIENT_CODES = new Set(["40P01", "55P03"]);

/**
 * One transaction/lock boundary for CLI initialization and runtime startup.
 * Retry only after rollback; invalid DDL and statement timeouts remain fatal.
 * @param {{ query: (sql: string, values?: unknown[]) => Promise<unknown> }} client
 * @param {string} sql
 * @param {{maxAttempts?: number, lockTimeoutMs?: number, statementTimeoutMs?: number,
 * onRetry?: (info: {code: string, attempt: number}) => void | Promise<void>}} options
 */
export async function applyTargetSchema(client, sql, options = {}) {
  const maxAttempts = options.maxAttempts ?? 4;
  const lockTimeoutMs = options.lockTimeoutMs ?? 3_000;
  const statementTimeoutMs = options.statementTimeoutMs ?? 60_000;
  for (const value of [maxAttempts, lockTimeoutMs, statementTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Schema application limits must be positive integers.");
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await client.query("BEGIN");
    try {
      await client.query(
        "SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)",
        [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`],
      );
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        MIGRATION_LOCK_ID,
      ]);
      if (sql.trim()) await client.query(sql);
      await client.query("COMMIT");
      return;
    } catch (error) {
      // A failed rollback cannot be retried safely on this connection.
      await client.query("ROLLBACK");
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (!TRANSIENT_CODES.has(code)) throw error;
      if (attempt === maxAttempts)
        throw Object.assign(
          new Error(
            `Schema application exhausted ${maxAttempts} attempts after PostgreSQL ${code}.`,
            { cause: error },
          ),
          { code },
        );
      await options.onRetry?.({ code, attempt });
      await delay(100 * 2 ** (attempt - 1));
    }
  }
}
