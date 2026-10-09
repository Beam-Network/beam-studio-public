export type ScheduleTriggerConfig = {
  frequency: string;
  nextRunAt: string;
  endAt: string | null;
  timezone: string;
  maxRunDurationSeconds: number | null;
  creditBudgetLimit: number | null;
  estimatedCreditCost: number;
  maxRuns: number | null;
  windowStartTime: string | null;
  windowEndTime: string | null;
  windowDays: number[];
  overlapPolicy: "skip_new" | "cancel_old" | "allow_parallel" | "queue_new";
  budgetAlertThreshold: number;
};

export function createDefaultScheduleTriggerConfig(): ScheduleTriggerConfig {
  return {
    frequency: "every 1 hour",
    nextRunAt: nextHourIso(),
    endAt: null,
    timezone: defaultTimezone(),
    maxRunDurationSeconds: null,
    creditBudgetLimit: null,
    estimatedCreditCost: 0,
    maxRuns: null,
    windowStartTime: null,
    windowEndTime: null,
    windowDays: [],
    overlapPolicy: "skip_new",
    budgetAlertThreshold: 80,
  };
}

export function normalizeScheduleTriggerConfig(
  value: Record<string, unknown> | null | undefined,
): ScheduleTriggerConfig {
  const fallback = createDefaultScheduleTriggerConfig();
  const config = value ?? {};

  return {
    frequency: stringValue(config.frequency) || fallback.frequency,
    nextRunAt: isoDate(config.nextRunAt) ?? fallback.nextRunAt,
    endAt: isoDate(config.endAt),
    timezone: stringValue(config.timezone) || fallback.timezone,
    maxRunDurationSeconds: positiveIntegerOrNull(
      config.maxRunDurationSeconds,
    ),
    creditBudgetLimit: positiveNumberOrNull(config.creditBudgetLimit),
    estimatedCreditCost:
      positiveNumberOrNull(
        config.estimatedCreditCost ?? config.creditCostPerRun,
      ) ?? 0,
    maxRuns: positiveIntegerOrNull(config.maxRuns),
    windowStartTime: stringValue(config.windowStartTime) || null,
    windowEndTime: stringValue(config.windowEndTime) || null,
    windowDays: Array.isArray(config.windowDays)
      ? config.windowDays
          .map((day) => Number(day))
          .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : [],
    overlapPolicy: normalizeOverlapPolicy(config.overlapPolicy),
    budgetAlertThreshold: clampBudgetAlert(config.budgetAlertThreshold),
  };
}

function clampBudgetAlert(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return 80;
  }
  return Math.min(Math.floor(number), 100);
}

function defaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function isoDate(value: unknown) {
  const text = stringValue(value);
  if (!text) {
    return null;
  }
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function nextHourIso() {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date.toISOString();
}

function normalizeOverlapPolicy(
  value: unknown,
): ScheduleTriggerConfig["overlapPolicy"] {
  return value === "cancel_old" ||
    value === "allow_parallel" ||
    value === "queue_new"
    ? value
    : "skip_new";
}

function positiveNumberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveIntegerOrNull(value: unknown) {
  const number = positiveNumberOrNull(value);
  return number === null ? null : Math.floor(number);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
