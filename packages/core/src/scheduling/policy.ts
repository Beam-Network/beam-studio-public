import { parseScheduleFrequency, type ScheduleFrequency } from "./frequency.js";

export type OverlapPolicy =
  | "skip_new"
  | "cancel_old"
  | "allow_parallel"
  | "queue_new";

export type ScheduleWindowOptions = {
  timezone?: string | null;
  windowStartTime?: string | null;
  windowEndTime?: string | null;
  windowDays?: number[] | null;
};

export type ScheduleProjectionOptions = ScheduleWindowOptions & {
  frequency: string;
  startAt?: string | null;
  nextRunAt?: string | null;
  endAt?: string | null;
  maxRuns?: number | null;
  completedRunCount?: number | null;
  maxOccurrences?: number;
  horizonDays?: number;
};

export type ScheduleProjection = {
  occurrences: string[];
  estimatedRunCount: number;
  estimateHorizonDays: number | null;
  openEnded: boolean;
  risks: string[];
};

export function intervalMsForFrequency(
  frequency: string | ScheduleFrequency,
): number | null {
  const parsed =
    typeof frequency === "string" ? parseScheduleFrequency(frequency) : frequency;
  if (!parsed || parsed.kind !== "interval") {
    return null;
  }

  if (parsed.unit === "minutes") {
    return parsed.every * 60_000;
  }

  if (parsed.unit === "hours") {
    return parsed.every * 60 * 60_000;
  }

  return parsed.every * 24 * 60 * 60_000;
}

export function calculateNextRunAt(
  previousValue: string | null | undefined,
  frequency: string,
  options: ScheduleWindowOptions & { after?: Date; endAt?: string | null } = {},
) {
  const intervalMs = intervalMsForFrequency(frequency);
  if (!intervalMs) {
    return null;
  }

  const after = options.after ?? new Date();
  let nextTime = previousValue ? new Date(previousValue).getTime() : after.getTime();
  if (!Number.isFinite(nextTime)) {
    nextTime = after.getTime();
  }

  do {
    nextTime += intervalMs;
  } while (nextTime <= after.getTime());

  const next = findNextAllowedOccurrence(new Date(nextTime), intervalMs, options);
  if (!next) {
    return null;
  }

  if (options.endAt && next.getTime() > new Date(options.endAt).getTime()) {
    return null;
  }

  return next.toISOString();
}

export function projectSchedule(
  options: ScheduleProjectionOptions,
): ScheduleProjection {
  const intervalMs = intervalMsForFrequency(options.frequency);
  const risks: string[] = [];
  const maxOccurrences = options.maxOccurrences ?? 10;
  const now = new Date();
  const startTime = options.nextRunAt ?? options.startAt ?? now.toISOString();
  const start = new Date(startTime);
  const end = options.endAt
    ? new Date(options.endAt)
    : new Date(
        now.getTime() + Math.max(options.horizonDays ?? 30, 1) * 24 * 60 * 60_000,
      );
  const openEnded = !options.endAt;
  const estimateHorizonDays = openEnded ? (options.horizonDays ?? 30) : null;

  if (!intervalMs) {
    return {
      occurrences: [],
      estimatedRunCount: 0,
      estimateHorizonDays,
      openEnded,
      risks: ["Invalid or manual frequency."],
    };
  }

  if (openEnded) {
    risks.push("Schedule has no end date; estimate uses a rolling horizon.");
  }

  if (options.endAt && start.getTime() > end.getTime()) {
    risks.push("Start date is after the schedule end date.");
  }

  const remainingRuns =
    options.maxRuns && options.maxRuns > 0
      ? Math.max(0, options.maxRuns - Math.max(options.completedRunCount ?? 0, 0))
      : Number.POSITIVE_INFINITY;
  const hardLimit = Math.min(
    Number.isFinite(remainingRuns) ? remainingRuns : 10_000,
    10_000,
  );

  const occurrences: string[] = [];
  let estimatedRunCount = 0;
  let cursor = start;
  let guard = 0;

  while (
    cursor.getTime() <= end.getTime() &&
    estimatedRunCount < hardLimit &&
    guard < 20_000
  ) {
    const allowed = findNextAllowedOccurrence(cursor, intervalMs, options);
    if (!allowed || allowed.getTime() > end.getTime()) {
      break;
    }

    estimatedRunCount += 1;
    if (occurrences.length < maxOccurrences) {
      occurrences.push(allowed.toISOString());
    }
    cursor = new Date(allowed.getTime() + intervalMs);
    guard += 1;
  }

  if (options.maxRuns && estimatedRunCount >= remainingRuns) {
    risks.push("Max run count limits the projected schedule.");
  }

  if (usesExecutionWindow(options) && estimatedRunCount === 0) {
    risks.push("Execution window prevents runs in the projected period.");
  }

  return {
    occurrences,
    estimatedRunCount,
    estimateHorizonDays,
    openEnded,
    risks,
  };
}

export function isWithinExecutionWindow(
  date: Date,
  options: ScheduleWindowOptions,
) {
  if (!usesExecutionWindow(options)) {
    return true;
  }

  const zoned = zonedDateParts(date, options.timezone);
  if (
    options.windowDays?.length &&
    !options.windowDays.includes(zoned.dayOfWeek)
  ) {
    return false;
  }

  const start = normalizeClockTime(options.windowStartTime);
  const end = normalizeClockTime(options.windowEndTime);
  if (!start && !end) {
    return true;
  }

  const current = `${String(zoned.hour).padStart(2, "0")}:${String(
    zoned.minute,
  ).padStart(2, "0")}`;
  if (start && end && start > end) {
    return current >= start || current <= end;
  }

  if (start && current < start) {
    return false;
  }

  if (end && current > end) {
    return false;
  }

  return true;
}

export function normalizeClockTime(value: string | null | undefined) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value?.trim() ?? "");
  if (!match) {
    return null;
  }

  return `${match[1]?.padStart(2, "0")}:${match[2]}`;
}

export function parseWindowDays(value: string | null | undefined) {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
}

function findNextAllowedOccurrence(
  start: Date,
  intervalMs: number,
  options: ScheduleWindowOptions,
) {
  let next = start;
  for (let guard = 0; guard < 20_000; guard += 1) {
    if (isWithinExecutionWindow(next, options)) {
      return next;
    }

    next = new Date(next.getTime() + intervalMs);
  }

  return null;
}

function usesExecutionWindow(options: ScheduleWindowOptions) {
  return Boolean(
    options.windowStartTime ||
      options.windowEndTime ||
      options.windowDays?.length,
  );
}

function zonedDateParts(date: Date, timezone?: string | null) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return { year, month, day, hour, minute, dayOfWeek };
}
