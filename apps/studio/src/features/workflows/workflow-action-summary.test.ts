import assert from "node:assert/strict";
import test from "node:test";
import { waitDurationSummary } from "./workflow-action-summary";

test("wait summaries use readable units without losing duration precision", () => {
  for (const [seconds, expected] of [
    [0, "Wait 0 seconds"],
    [1, "Wait 1 second"],
    [5, "Wait 5 seconds"],
    [0.25, "Wait 0.25 seconds"],
    [60, "Wait 1 minute"],
    [90, "Wait 90 seconds"],
    [120, "Wait 2 minutes"],
    [3600, "Wait 1 hour"],
    [7200, "Wait 2 hours"],
  ] as const) {
    assert.equal(
      waitDurationSummary("@beam/wait", { durationSeconds: seconds }),
      expected,
    );
  }
  assert.equal(
    waitDurationSummary("@example/wait", { duration_seconds: "5" }),
    "Wait 5 seconds",
  );
});

test("unknown units, invalid durations, and other actions keep their generic summary", () => {
  for (const config of [
    {},
    { duration: 5 },
    { durationMs: 5000 },
    { durationSeconds: "" },
    { durationSeconds: "  " },
    { durationSeconds: -1 },
    { durationSeconds: NaN },
    { durationSeconds: Infinity },
    { durationSeconds: "${workflow.input.delay}" },
    { durationSeconds: false },
  ]) {
    assert.equal(waitDurationSummary("@beam/wait", config), undefined);
  }
  assert.equal(
    waitDurationSummary("@beam/transfer", { durationSeconds: 5 }),
    undefined,
  );
});
