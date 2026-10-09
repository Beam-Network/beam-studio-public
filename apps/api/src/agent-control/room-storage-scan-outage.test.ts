import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { PgPool } from "@beam-studio/db";
import { RoomStorageTransferManager } from "./room-storage-transfer-manager.js";

// S22: the background scan runs every 2 s. With PostgreSQL stopped its query
// rejected, nothing caught it, and the unhandled rejection ended the API.
test("a room storage scan failing on an unreachable database is logged, not thrown", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const pool = {
    query: async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND postgres"), {
        code: "ENOTFOUND",
      });
    },
  } as unknown as PgPool;
  const warnings: Array<{ payload: unknown; message: string }> = [];
  const manager = new RoomStorageTransferManager(
    pool,
    {} as never,
    {} as never,
    {
      info() {},
      warn(payload, message) {
        warnings.push({ payload, message });
      },
    },
  );
  try {
    manager.start();
    await sleep(50);
  } finally {
    manager.stop();
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(unhandled, []);
  assert.deepEqual(warnings, [
    {
      payload: { code: "database_unavailable" },
      message: "Room storage transfer scan failed; retrying on the next tick",
    },
  ]);
});
