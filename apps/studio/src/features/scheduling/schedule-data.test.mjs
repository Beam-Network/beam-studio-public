import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDateTime,
  formatDuration,
  scheduleBudget,
  scheduleHistory,
  scheduleProjection,
  scheduleRunProgress,
  scheduleSignals,
  scheduleState,
} from "./schedule-data.ts";

function schedule(overrides = {}) {
  return {
    id: "sch_1",
    transferTemplateId: "tr_1",
    transferName: "Nightly backup",
    frequency: "every 1 hour",
    enabled: true,
    status: "active",
    startAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-10T00:00:00.000Z",
    timezone: "UTC",
    nextRunAt: "2026-08-07T00:00:00.000Z",
    maxRunDurationSeconds: 3600,
    creditBudgetLimit: 20,
    creditsConsumed: 12,
    maxRuns: 20,
    runCount: 12,
    successCount: 10,
    failureCount: 2,
    successRate: 83,
    avgRunDurationSeconds: 120,
    lastRunAt: "2026-08-06T00:00:00.000Z",
    lastError: "network unavailable",
    windowStartTime: null,
    windowEndTime: null,
    windowDays: [],
    overlapPolicy: "skip_new",
    estimatedCreditCost: 1.5,
    estimatedRunCount: 8,
    estimatedTotalCreditCost: 12,
    estimateHorizonDays: null,
    previewRunAt: ["2026-08-07T00:00:00.000Z"],
    risks: ["Max run count limits the projected schedule."],
    budgetAlertThreshold: 80,
    alertState: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

test("formats scheduler dates, durations, and fractional credits", () => {
  assert.equal(
    formatDateTime("2026-08-06T12:30:00.000Z", "UTC"),
    "Aug 6, 2026, 12:30 PM",
  );
  assert.equal(formatDateTime(null, "UTC"), "Not set");
  assert.equal(formatDuration(5400), "1h 30m");
  assert.equal(
    scheduleBudget(
      schedule({
        creditBudgetLimit: 1,
        creditsConsumed: 0.07,
        estimatedCreditCost: 0.02,
        estimatedTotalCreditCost: 0.25,
      }),
    ).remainingLabel,
    "0.93 credits",
  );
  assert.equal(
    scheduleProjection(schedule({ estimatedTotalCreditCost: 0.49 }))
      .estimatedCreditCostLabel,
    "0.49 credits",
  );
});

test("an estimate that could not be priced reads as unavailable, not free", () => {
  const budget = scheduleBudget(
    schedule({ estimatedCreditCost: null, estimatedTotalCreditCost: null }),
  );
  assert.equal(budget.estimatedPerRun, null);
  assert.equal(budget.estimatedPerRunLabel, "Estimate unavailable");
  assert.equal(budget.projectedLabel, "Estimate unavailable");
  assert.equal(
    scheduleProjection(schedule({ estimatedTotalCreditCost: null }))
      .estimatedCreditCostLabel,
    "Estimate unavailable",
  );
  assert.equal(
    scheduleBudget(schedule({ estimatedCreditCost: 0 })).estimatedPerRunLabel,
    "0 credits",
  );
});

test("builds run and credit progress without exceeding 100 percent", () => {
  assert.deepEqual(scheduleRunProgress(schedule()), {
    completed: 12,
    label: "12 / 20",
    limit: 20,
    percentage: 60,
    remaining: 8,
  });
  assert.deepEqual(scheduleBudget(schedule({ creditsConsumed: 25 })), {
    consumed: 25,
    consumedLabel: "25 credits",
    estimatedPerRun: 1.5,
    estimatedPerRunLabel: "1.5 credits",
    limit: 20,
    limitLabel: "20 credits",
    percentage: 100,
    projected: 12,
    projectedLabel: "12 credits",
    remaining: 0,
    remainingLabel: "0 credits",
  });
});

test("normalizes paused, completed, expired, and budget terminal states", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  assert.equal(scheduleState(schedule({ enabled: false }), now).key, "paused");
  assert.equal(scheduleState(schedule({ runCount: 20 }), now).key, "completed");
  assert.equal(
    scheduleState(schedule({ endAt: "2026-08-05T00:00:00.000Z" }), now).key,
    "expired",
  );
  assert.equal(
    scheduleState(schedule({ creditsConsumed: 20 }), now).key,
    "budget_terminal",
  );
});

test("projection model carries horizon, costs, occurrences, and risks", () => {
  const projection = scheduleProjection(
    schedule({ endAt: null, estimateHorizonDays: 30 }),
  );
  assert.equal(projection.estimatedRunLabel, "8 runs");
  assert.equal(projection.estimatedCreditCostLabel, "12 credits");
  assert.equal(projection.horizonLabel, "30-day rolling horizon");
  assert.deepEqual(projection.occurrenceLabels, ["Aug 7, 2026, 12:00 AM"]);
  assert.deepEqual(projection.risks, [
    "Max run count limits the projected schedule.",
  ]);
});

test("surfaces budget, overlap, failure, timeout, end-date, and projection signals", () => {
  const signals = scheduleSignals(
    schedule({
      alertState: "budget_threshold_reached",
      lastError: "run timed out",
    }),
    new Date("2026-08-06T12:00:00.000Z"),
  );
  const keys = signals.map((signal) => signal.key);
  assert.deepEqual(keys, [
    "budget-alert",
    "overlap-policy",
    "timeout",
    "end-date",
    "projection-risk-0",
  ]);
});

test("attributes exact history and makes ambiguous fallback explicit", () => {
  const current = schedule();
  const exact = scheduleHistory(
    current,
    [current],
    [{ id: "run_1", scheduleId: "sch_1", status: "completed" }],
  );
  assert.equal(exact.mode, "exact");
  assert.equal(exact.runs.length, 1);

  const inferred = scheduleHistory(
    current,
    [current],
    [
      { id: "run_2", trigger: "schedule", status: "completed" },
      { id: "run_3", trigger: "manual", status: "completed" },
    ],
  );
  assert.equal(inferred.mode, "transfer_fallback");
  assert.deepEqual(
    inferred.runs.map((run) => run.id),
    ["run_2"],
  );

  const ambiguous = scheduleHistory(
    current,
    [current, schedule({ id: "sch_2" })],
    [{ id: "run_4", trigger: "schedule", status: "completed" }],
  );
  assert.equal(ambiguous.mode, "unavailable");
  assert.match(ambiguous.notice, /multiple schedules/);
});
