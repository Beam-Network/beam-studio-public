import assert from "node:assert/strict";
import test from "node:test";
import { runSummaryHint } from "./run-summary";

test("a cancelled run is not reported as completed", () => {
  assert.equal(
    runSummaryHint({ runCount: 1, completedRunCount: 0, failedRunCount: 0 }),
    "0 of 1 completed",
  );
});

test("every run completed", () => {
  assert.equal(
    runSummaryHint({ runCount: 3, completedRunCount: 3, failedRunCount: 0 }),
    "all completed",
  );
});

test("failures lead the hint", () => {
  assert.equal(
    runSummaryHint({ runCount: 3, completedRunCount: 1, failedRunCount: 2 }),
    "2 failed",
  );
});

test("no runs yet", () => {
  assert.equal(
    runSummaryHint({ runCount: 0, completedRunCount: 0, failedRunCount: 0 }),
    "none yet",
  );
});
