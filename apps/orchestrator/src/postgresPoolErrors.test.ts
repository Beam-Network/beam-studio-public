import assert from "node:assert/strict";
import test from "node:test";
import {
  registerPostgresPoolErrorHandler,
  type PgPool,
} from "@beam-studio/db";

test("handles idle PostgreSQL client errors without crashing", () => {
  let errorListener: ((error: Error) => void) | undefined;
  const pool = {
    on(event: string, listener: (error: Error) => void) {
      assert.equal(event, "error");
      errorListener = listener;
      return this;
    },
  } as unknown as PgPool;
  const entries: Array<{ payload: unknown; message: string }> = [];

  registerPostgresPoolErrorHandler(pool, {
    error(payload, message) {
      entries.push({ payload, message });
    },
  });

  const databaseError = Object.assign(
    new Error("terminating connection due to administrator command"),
    { code: "57P01", severity: "FATAL" },
  );
  assert.doesNotThrow(() => errorListener?.(databaseError));
  assert.deepEqual(entries, [
    {
      payload: {
        // The safe fields only: the error pg-pool emits carries the client.
        error: {
          name: "Error",
          message: "terminating connection due to administrator command",
          code: "57P01",
          severity: "FATAL",
        },
        postgresCode: "57P01",
        postgresSeverity: "FATAL",
      },
      message:
        "PostgreSQL idle connection failed; the pool will reconnect when needed",
    },
  ]);
});
