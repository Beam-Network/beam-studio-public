import {
  calculateNextRunAt,
  isWithinExecutionWindow,
  type OverlapPolicy,
} from "@beam-studio/core/scheduling";

export type ScheduleRuntimeConfig = {
  frequency: string;
  nextRunAt: string | null;
  endAt: string | null;
  timezone: string;
  maxRunDurationSeconds: number | null;
  creditBudgetLimit: number | null;
  estimatedCreditCost: number;
  maxRuns: number | null;
  windowStartTime: string | null;
  windowEndTime: string | null;
  windowDays: number[];
  overlapPolicy: OverlapPolicy;
  budgetAlertThreshold: number;
};

export type ScheduleRuntimeState = {
  runCount: number;
  skippedCount: number;
  creditsConsumed: number;
  alertState: string | null;
};

export type ScheduleDecision =
  | {
      kind: "disable";
      reason:
        | "missing_next_run_at"
        | "expired"
        | "max_runs_reached"
        | "credit_budget_reached"
        | "credit_budget_insufficient";
    }
  | {
      kind: "skip";
      nextRunAt: string | null;
      reason: "active_run" | "execution_window";
      state: ScheduleRuntimeState;
      terminalReason: "completed" | null;
    }
  | {
      kind: "enqueue";
      cancelActive: boolean;
      serializeBehindActive: boolean;
      nextRunAt: string | null;
      state: ScheduleRuntimeState;
      terminalReason:
        | "completed"
        | "max_runs_reached"
        | "credit_budget_reached"
        | null;
    };

export function evaluateScheduleOccurrence(input: {
  activeRunCount: number;
  config: ScheduleRuntimeConfig;
  state: ScheduleRuntimeState;
  timestamp: string;
}): ScheduleDecision {
  const { activeRunCount, config, state, timestamp } = input;
  const scheduledAt = config.nextRunAt;
  if (!scheduledAt) {
    return { kind: "disable", reason: "missing_next_run_at" };
  }
  if (config.endAt && Date.parse(scheduledAt) > Date.parse(config.endAt)) {
    return { kind: "disable", reason: "expired" };
  }
  if (config.maxRuns && state.runCount >= config.maxRuns) {
    return { kind: "disable", reason: "max_runs_reached" };
  }
  if (
    config.creditBudgetLimit &&
    hundredths(state.creditsConsumed) >= hundredths(config.creditBudgetLimit)
  ) {
    return { kind: "disable", reason: "credit_budget_reached" };
  }
  if (
    config.creditBudgetLimit &&
    config.estimatedCreditCost > 0 &&
    hundredths(state.creditsConsumed) + hundredths(config.estimatedCreditCost) >
      hundredths(config.creditBudgetLimit)
  ) {
    return { kind: "disable", reason: "credit_budget_insufficient" };
  }

  const nextRunAt = calculateNextRunAt(scheduledAt, config.frequency, {
    after: new Date(timestamp),
    endAt: config.endAt,
    timezone: config.timezone,
    windowStartTime: config.windowStartTime,
    windowEndTime: config.windowEndTime,
    windowDays: config.windowDays,
  });

  if (!isWithinExecutionWindow(new Date(scheduledAt), config)) {
    return {
      kind: "skip",
      nextRunAt,
      reason: "execution_window",
      state: {
        ...state,
        skippedCount: state.skippedCount + 1,
      },
      terminalReason: nextRunAt ? null : "completed",
    };
  }

  if (activeRunCount > 0 && config.overlapPolicy === "skip_new") {
    return {
      kind: "skip",
      nextRunAt,
      reason: "active_run",
      state: {
        ...state,
        skippedCount: state.skippedCount + 1,
      },
      terminalReason: nextRunAt ? null : "completed",
    };
  }

  const nextState = stateAfterEnqueue(config, state);
  const terminalReason = terminalReasonAfterEnqueue(
    config,
    nextState,
    nextRunAt,
  );

  return {
    kind: "enqueue",
    cancelActive:
      activeRunCount > 0 && config.overlapPolicy === "cancel_old",
    serializeBehindActive:
      activeRunCount > 0 && config.overlapPolicy === "queue_new",
    nextRunAt: terminalReason ? null : nextRunAt,
    state: nextState,
    terminalReason,
  };
}

export function normalizeScheduleRuntimeConfig(
  value: unknown,
): ScheduleRuntimeConfig {
  const config = objectValue(value);
  return {
    frequency: String(config.frequency ?? "every 1 hour"),
    nextRunAt: stringOrNull(config.nextRunAt),
    endAt: stringOrNull(config.endAt),
    timezone: normalizeTimezone(config.timezone),
    maxRunDurationSeconds: positiveInteger(config.maxRunDurationSeconds),
    creditBudgetLimit: positiveNumber(config.creditBudgetLimit),
    estimatedCreditCost:
      positiveNumber(
        config.estimatedCreditCost ?? config.creditCostPerRun,
      ) ?? 0,
    maxRuns: positiveInteger(config.maxRuns),
    windowStartTime: stringOrNull(config.windowStartTime),
    windowEndTime: stringOrNull(config.windowEndTime),
    windowDays: Array.isArray(config.windowDays)
      ? config.windowDays
          .map((day) => Number(day))
          .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : [],
    overlapPolicy: normalizeOverlapPolicy(config.overlapPolicy),
    budgetAlertThreshold: Math.min(
      positiveInteger(config.budgetAlertThreshold) ?? 80,
      100,
    ),
  };
}

export function normalizeScheduleRuntimeState(
  value: unknown,
): ScheduleRuntimeState {
  const state = objectValue(value);
  return {
    runCount: nonNegativeNumber(state.runCount),
    skippedCount: nonNegativeNumber(state.skippedCount),
    creditsConsumed: nonNegativeNumber(state.creditsConsumed),
    alertState: stringOrNull(state.alertState),
  };
}

export function scheduleTriggerStatus(
  nextRunAt: string | null,
  terminalReason: string | null,
) {
  return nextRunAt ? "active" : terminalReason ?? "completed";
}

function stateAfterEnqueue(
  config: ScheduleRuntimeConfig,
  state: ScheduleRuntimeState,
) {
  const creditsConsumed =
    (hundredths(state.creditsConsumed) +
      hundredths(config.estimatedCreditCost)) /
    100;
  const budgetPercentage = config.creditBudgetLimit
    ? (creditsConsumed / config.creditBudgetLimit) * 100
    : 0;
  return {
    ...state,
    runCount: state.runCount + 1,
    creditsConsumed,
    alertState:
      config.creditBudgetLimit &&
      budgetPercentage >= config.budgetAlertThreshold
        ? "budget_threshold_reached"
        : state.alertState,
  };
}

function terminalReasonAfterEnqueue(
  config: ScheduleRuntimeConfig,
  state: ScheduleRuntimeState,
  nextRunAt: string | null,
):
  | "completed"
  | "max_runs_reached"
  | "credit_budget_reached"
  | null {
  if (config.maxRuns && state.runCount >= config.maxRuns) {
    return "max_runs_reached";
  }
  if (
    config.creditBudgetLimit &&
    state.creditsConsumed >= config.creditBudgetLimit
  ) {
    return "credit_budget_reached";
  }
  return nextRunAt ? null : "completed";
}

function normalizeOverlapPolicy(value: unknown): OverlapPolicy {
  return value === "cancel_old" ||
    value === "allow_parallel" ||
    value === "queue_new"
    ? value
    : "skip_new";
}

function normalizeTimezone(value: unknown) {
  const timezone = String(value ?? "").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

function nonNegativeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (typeof value === "string") {
      try {
        return objectValue(JSON.parse(value));
      } catch {
        return {};
      }
    }
    return {};
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

/**
 * Credits have at most two decimals, so a budget is summed and compared in
 * whole hundredths: 0.1 + 0.2 fits a 0.3 budget exactly.
 */
function hundredths(credits: number) {
  return Math.round(credits * 100);
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function stringOrNull(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}
