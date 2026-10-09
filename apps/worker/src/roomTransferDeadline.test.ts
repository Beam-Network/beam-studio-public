import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptRoomTransferDeadline,
  initialRoomTransferDeadline,
} from "./services/roomTransferDeadline.js";

const now = Date.parse("2026-09-23T00:00:00.000Z");

test("restart uses the persisted publication deadline with only bounded status-refresh grace", () => {
  assert.equal(initialRoomTransferDeadline(now, "pub", {}), now + 300_000);
  assert.equal(
    initialRoomTransferDeadline(now, "pub", {
      publicationId: "other",
      idleExpiresAt: new Date(now + 60_000).toISOString(),
    }),
    now + 300_000,
  );
  assert.equal(
    initialRoomTransferDeadline(now, "pub", {
      publicationId: "pub",
      idleExpiresAt: new Date(now + 60_000).toISOString(),
    }),
    now + 60_000,
  );
  assert.equal(
    initialRoomTransferDeadline(now, "pub", {
      publicationId: "pub",
      idleExpiresAt: new Date(now - 10_000).toISOString(),
    }),
    now + 30_000,
  );
});

test("only a future monotonic Coordinator deadline within the room idle window renews", () => {
  const current = now + 60_000;
  assert.equal(
    acceptRoomTransferDeadline(
      current,
      new Date(now + 300_000).toISOString(),
      now,
    ),
    now + 300_000,
  );
  for (const candidate of [
    new Date(now + 60_000).toISOString(),
    new Date(now + 30_000).toISOString(),
    new Date(now + 600_000).toISOString(),
    "not-a-date",
  ])
    assert.equal(acceptRoomTransferDeadline(current, candidate, now), current);
});
