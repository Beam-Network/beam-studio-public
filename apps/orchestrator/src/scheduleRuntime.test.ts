import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateScheduleOccurrence,
  normalizeScheduleRuntimeConfig,
  normalizeScheduleRuntimeState,
} from "./scheduleRuntime.js";

const timestamp = "2026-07-27T10:00:00.000Z";

function config(
  overrides: Record<string, unknown> = {},
) {
  return normalizeScheduleRuntimeConfig({
    frequency: "every 1 hour",
    nextRunAt: timestamp,
    timezone: "UTC",
    ...overrides,
  });
}

test("schedule runtime advances skipped occurrences without consuming a run", () => {
  const decision = evaluateScheduleOccurrence({
    activeRunCount: 1,
    config: config({ overlapPolicy: "skip_new" }),
    state: normalizeScheduleRuntimeState({ runCount: 2 }),
    timestamp,
  });

  assert.equal(decision.kind, "skip");
  assert.equal(decision.state.runCount, 2);
  assert.equal(decision.state.skippedCount, 1);
  assert.equal(decision.nextRunAt, "2026-07-27T11:00:00.000Z");
});

test("queue_new enqueues an occurrence but marks it for serialization", () => {
  const decision = evaluateScheduleOccurrence({
    activeRunCount: 1,
    config: config({ overlapPolicy: "queue_new" }),
    state: normalizeScheduleRuntimeState({}),
    timestamp,
  });

  assert.equal(decision.kind, "enqueue");
  assert.equal(decision.serializeBehindActive, true);
  assert.equal(decision.cancelActive, false);
  assert.equal(decision.state.runCount, 1);
});

test("cancel_old requests cancellation before enqueuing the new occurrence", () => {
  const decision = evaluateScheduleOccurrence({
    activeRunCount: 1,
    config: config({ overlapPolicy: "cancel_old" }),
    state: normalizeScheduleRuntimeState({}),
    timestamp,
  });

  assert.equal(decision.kind, "enqueue");
  assert.equal(decision.cancelActive, true);
  assert.equal(decision.serializeBehindActive, false);
});

test("max runs disables before or immediately after the final occurrence", () => {
  const before = evaluateScheduleOccurrence({
    activeRunCount: 0,
    config: config({ maxRuns: 2 }),
    state: normalizeScheduleRuntimeState({ runCount: 2 }),
    timestamp,
  });
  assert.deepEqual(before, { kind: "disable", reason: "max_runs_reached" });

  const final = evaluateScheduleOccurrence({
    activeRunCount: 0,
    config: config({ maxRuns: 2 }),
    state: normalizeScheduleRuntimeState({ runCount: 1 }),
    timestamp,
  });
  assert.equal(final.kind, "enqueue");
  assert.equal(final.nextRunAt, null);
  assert.equal(final.terminalReason, "max_runs_reached");
});

test("credit budgets block unaffordable runs and emit threshold state", () => {
  const blocked = evaluateScheduleOccurrence({
    activeRunCount: 0,
    config: config({
      creditBudgetLimit: 10,
      estimatedCreditCost: 4,
    }),
    state: normalizeScheduleRuntimeState({ creditsConsumed: 8 }),
    timestamp,
  });
  assert.deepEqual(blocked, {
    kind: "disable",
    reason: "credit_budget_insufficient",
  });

  const alerted = evaluateScheduleOccurrence({
    activeRunCount: 0,
    config: config({
      budgetAlertThreshold: 75,
      creditBudgetLimit: 10,
      estimatedCreditCost: 4,
    }),
    state: normalizeScheduleRuntimeState({ creditsConsumed: 4 }),
    timestamp,
  });
  assert.equal(alerted.kind, "enqueue");
  assert.equal(alerted.state.creditsConsumed, 8);
  assert.equal(alerted.state.alertState, "budget_threshold_reached");
});

test("credit budgets are summed and compared exactly at two decimals", () => {
  // 0.1 + 0.2 is 0.30000000000000004 in floating point.
  const fits = evaluateScheduleOccurrence({
    activeRunCount: 0,
    config: config({ creditBudgetLimit: 0.3, estimatedCreditCost: 0.2 }),
    state: normalizeScheduleRuntimeState({ creditsConsumed: 0.1 }),
    timestamp,
  });
  assert.equal(fits.kind, "enqueue");
  assert.equal(fits.state.creditsConsumed, 0.3);

  const reached = evaluateScheduleOccurrence({
    activeRunCount: 0,
    config: config({ creditBudgetLimit: 0.3, estimatedCreditCost: 0.01 }),
    state: normalizeScheduleRuntimeState({ creditsConsumed: 0.1 + 0.2 }),
    timestamp,
  });
  assert.deepEqual(reached, { kind: "disable", reason: "credit_budget_reached" });
});

test("execution windows are applied while calculating the next occurrence", () => {
  const decision = evaluateScheduleOccurrence({
    activeRunCount: 0,
    config: config({
      frequency: "every 1 hour",
      windowDays: [1, 2],
      windowEndTime: "10:00",
      windowStartTime: "10:00",
    }),
    state: normalizeScheduleRuntimeState({}),
    timestamp,
  });
  assert.equal(decision.kind, "enqueue");
  assert.equal(decision.nextRunAt, "2026-07-28T10:00:00.000Z");
});

test("an occurrence outside its execution window is skipped", () => {
  const decision = evaluateScheduleOccurrence({
    activeRunCount: 0,
    config: config({
      windowDays: [2],
      windowEndTime: "12:00",
      windowStartTime: "12:00",
    }),
    state: normalizeScheduleRuntimeState({}),
    timestamp,
  });

  assert.equal(decision.kind, "skip");
  assert.equal(decision.reason, "execution_window");
  assert.equal(decision.state.runCount, 0);
  assert.equal(decision.state.skippedCount, 1);
  assert.equal(decision.nextRunAt, "2026-07-28T12:00:00.000Z");
});
