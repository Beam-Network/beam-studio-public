import assert from "node:assert/strict";
import { test } from "node:test";

import { calculateNextRunAt } from "./policy.js";

test("calculateNextRunAt advances stale schedules into the future", () => {
  assert.equal(
    calculateNextRunAt("2026-08-31T17:15:00.000Z", "every 30 minutes", {
      after: new Date("2026-09-03T14:46:25.000Z"),
      timezone: "UTC",
    }),
    "2026-09-03T15:15:00.000Z",
  );
});

test("calculateNextRunAt returns null when no future occurrence is allowed", () => {
  assert.equal(
    calculateNextRunAt("2026-08-31T17:15:00.000Z", "every 30 minutes", {
      after: new Date("2026-09-03T14:46:25.000Z"),
      endAt: "2026-09-02T00:00:00.000Z",
      timezone: "UTC",
    }),
    null,
  );
});
