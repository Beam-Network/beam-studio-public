import type { ServerResponse } from "node:http";
import { isPostgresUnavailableError } from "@beam-studio/db";

export const DATABASE_UNAVAILABLE_MESSAGE =
  "The Studio database is unavailable. Retry shortly.";

/** The first database outage a request ran into, if any. */
export type DatabaseOutage = { error?: unknown };

/**
 * Remembers `error` when it means PostgreSQL is unreachable or restarting.
 * Any other error is left to the normal tool-error path.
 */
export function noteDatabaseOutage(
  outage: DatabaseOutage | undefined,
  error: unknown,
) {
  if (
    outage &&
    outage.error === undefined &&
    isPostgresUnavailableError(error)
  ) {
    outage.error = error;
  }
}

/**
 * The JSON-RPC failure for a request that could not be served: 503 with the
 * retry message when the database is unavailable, otherwise an opaque 500.
 */
export function writeMcpFailure(res: ServerResponse, error: unknown) {
  const databaseUnavailable = isPostgresUnavailableError(error);
  const payload = JSON.stringify(
    {
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: databaseUnavailable
          ? DATABASE_UNAVAILABLE_MESSAGE
          : "Internal server error",
      },
      id: null,
    },
    null,
    2,
  );
  res.writeHead(databaseUnavailable ? 503 : 500, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * The MCP SDK turns anything a tool handler throws into a successful tool
 * result carrying the error text, so a query cut off by a database restart
 * reached the client as a 200 "Connection terminated unexpectedly" instead of
 * the retryable 503 every other request gets during an outage.
 *
 * This intercepts the response the transport is about to write: when the
 * request ran into an outage (see `noteDatabaseOutage`), `onOutage` answers
 * instead and whatever the transport writes afterwards is dropped. The JSON
 * response mode writes nothing before every handler has settled, so the
 * outage is always known by then.
 */
export function answerDatabaseOutageInstead(
  res: ServerResponse,
  outage: DatabaseOutage,
  onOutage: (error: unknown) => void,
) {
  const writeHead = res.writeHead;
  const write = res.write;
  const end = res.end;
  res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    res.writeHead = writeHead;
    if (outage.error === undefined) {
      return (writeHead as (...values: unknown[]) => ServerResponse).apply(
        this,
        args,
      );
    }
    onOutage(outage.error);
    res.write = ((...values: unknown[]) => {
      const callback = values.find((value) => typeof value === "function");
      if (callback) (callback as () => void)();
      return true;
    }) as typeof res.write;
    res.end = ((...values: unknown[]) => {
      const callback = values.find((value) => typeof value === "function");
      if (callback) (callback as () => void)();
      return res;
    }) as typeof res.end;
    return res;
  } as typeof res.writeHead;
  return () => {
    res.writeHead = writeHead;
    res.write = write;
    res.end = end;
  };
}
