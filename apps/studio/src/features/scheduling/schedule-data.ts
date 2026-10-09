import { formatCredits, toHundredths } from "@/lib/format-credits";

/** Shown where a credit estimate could not be priced. */
export const ESTIMATE_UNAVAILABLE = "Estimate unavailable";

export type ScheduleTone = "success" | "muted" | "warning" | "destructive";

export type ScheduleRecord = {
  id: string;
  transferTemplateId: string;
  transferName: string | null;
  frequency: string;
  enabled: boolean;
  status: string;
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  nextRunAt: string | null;
  maxRunDurationSeconds: number | null;
  creditBudgetLimit: number | null;
  creditsConsumed: number;
  maxRuns: number | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgRunDurationSeconds: number;
  lastRunAt: string | null;
  lastError: string | null;
  windowStartTime: string | null;
  windowEndTime: string | null;
  windowDays: number[];
  overlapPolicy: "skip_new" | "cancel_old" | "allow_parallel" | "queue_new";
  /** Per run at the published price, or null when it could not be priced. */
  estimatedCreditCost: number | null;
  estimatedRunCount: number;
  /** The per-run estimate over the projected runs, or null when unavailable. */
  estimatedTotalCreditCost: number | null;
  estimateHorizonDays: number | null;
  previewRunAt: string[];
  risks: string[];
  budgetAlertThreshold: number;
  alertState: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleRunRecord = {
  id: string;
  scheduleId?: string | null;
  transferTemplateId?: string | null;
  transferName?: string | null;
  status: string;
  trigger?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  queuedAt?: string | null;
  createdAt?: string | null;
  error?: string | null;
  cancelReason?: string | null;
  timedOutAt?: string | null;
  creditCost?: number | null;
  attempts?: number | null;
};

export type TransferSummary = {
  id: string;
  name: string;
  /** Per run at the published price, or null when it could not be priced. */
  estimatedCreditCost?: number | null;
};

export type SchedulesPayload = {
  schedules: ScheduleRecord[];
  transfers?: TransferSummary[];
};

export type ScheduleState = {
  key: "active" | "paused" | "completed" | "expired" | "budget_terminal";
  label: string;
  reason: string;
  terminal: boolean;
  tone: ScheduleTone;
};

export type ScheduleSignal = {
  key: string;
  title: string;
  detail: string;
  tone: ScheduleTone;
};

export function scheduleState(
  schedule: ScheduleRecord,
  now: Date = new Date(),
): ScheduleState {
  const status = normalizeStateValue(schedule.status);
  const explicitBudgetTerminal =
    status === "credit_budget_reached" ||
    status === "credit_budget_insufficient" ||
    status === "budget_exhausted";
  if (explicitBudgetTerminal) {
    return {
      key: "budget_terminal",
      label: "Budget reached",
      reason:
        status === "credit_budget_insufficient"
          ? "The next estimated run would exceed the credit budget."
          : "The schedule has consumed its credit budget.",
      terminal: true,
      tone: "destructive",
    };
  }

  const endTime = timestamp(schedule.endAt);
  if (status === "expired" || (endTime !== null && endTime <= now.getTime())) {
    return {
      key: "expired",
      label: "Expired",
      reason: "The schedule end date has passed.",
      terminal: true,
      tone: "muted",
    };
  }

  const maxRunsReached =
    status === "max_runs_reached" ||
    Boolean(schedule.maxRuns && schedule.runCount >= schedule.maxRuns);
  if (maxRunsReached) {
    return {
      key: "completed",
      label: "Completed",
      reason: "The schedule reached its maximum run count.",
      terminal: true,
      tone: "success",
    };
  }

  const budgetReached = Boolean(
    schedule.creditBudgetLimit &&
    toHundredths(schedule.creditsConsumed) >=
      toHundredths(schedule.creditBudgetLimit),
  );
  if (budgetReached) {
    return {
      key: "budget_terminal",
      label: "Budget reached",
      reason: "The schedule has consumed its credit budget.",
      terminal: true,
      tone: "destructive",
    };
  }

  if (
    status === "completed" ||
    (schedule.enabled && !schedule.nextRunAt && schedule.runCount > 0)
  ) {
    return {
      key: "completed",
      label: "Completed",
      reason: "No more occurrences are scheduled.",
      terminal: true,
      tone: "success",
    };
  }

  if (!schedule.enabled || status === "paused" || status === "disabled") {
    return {
      key: "paused",
      label: "Paused",
      reason: "Automatic execution is paused.",
      terminal: false,
      tone: "muted",
    };
  }

  return {
    key: "active",
    label: "Active",
    reason: "The schedule is ready for its next occurrence.",
    terminal: false,
    tone: "success",
  };
}

export function scheduleRunProgress(schedule: ScheduleRecord) {
  const completed = Math.max(0, schedule.runCount || 0);
  const limit =
    schedule.maxRuns && schedule.maxRuns > 0 ? schedule.maxRuns : null;
  return {
    completed,
    label: limit
      ? `${completed} / ${limit}`
      : `${completed} ${plural(completed, "run")}`,
    limit,
    percentage: limit ? clampPercentage((completed / limit) * 100) : null,
    remaining: limit ? Math.max(0, limit - completed) : null,
  };
}

export function scheduleBudget(schedule: ScheduleRecord) {
  const limit = positiveNumber(schedule.creditBudgetLimit);
  const consumed = Math.max(0, schedule.creditsConsumed || 0);
  const estimatedPerRun = creditEstimate(schedule.estimatedCreditCost);
  const projected = creditEstimate(schedule.estimatedTotalCreditCost);
  const remaining =
    limit === null
      ? null
      : Math.max(0, toHundredths(limit) - toHundredths(consumed)) / 100;
  return {
    consumed,
    consumedLabel: formatCredits(consumed),
    estimatedPerRun,
    estimatedPerRunLabel: creditEstimateLabel(estimatedPerRun),
    limit,
    limitLabel: limit === null ? "No budget" : formatCredits(limit),
    percentage:
      limit === null ? null : clampPercentage((consumed / limit) * 100),
    projected,
    projectedLabel: creditEstimateLabel(projected),
    remaining,
    remainingLabel: remaining === null ? "Unlimited" : formatCredits(remaining),
  };
}

export function scheduleProjection(schedule: ScheduleRecord) {
  const estimatedRunCount = Math.max(0, schedule.estimatedRunCount || 0);
  const estimatedCreditCost = creditEstimate(schedule.estimatedTotalCreditCost);
  return {
    estimatedCreditCost,
    estimatedCreditCostLabel: creditEstimateLabel(estimatedCreditCost),
    estimatedRunCount,
    estimatedRunLabel: `${estimatedRunCount} ${plural(estimatedRunCount, "run")}`,
    horizonLabel: schedule.estimateHorizonDays
      ? `${schedule.estimateHorizonDays}-day rolling horizon`
      : "Through the configured end date",
    occurrenceLabels: schedule.previewRunAt.map((occurrence) =>
      formatDateTime(occurrence, schedule.timezone),
    ),
    risks: [...schedule.risks],
  };
}

export function scheduleSignals(
  schedule: ScheduleRecord,
  now: Date = new Date(),
): ScheduleSignal[] {
  const signals: ScheduleSignal[] = [];
  const state = scheduleState(schedule, now);
  const budget = scheduleBudget(schedule);

  if (state.key === "budget_terminal") {
    signals.push({
      key: "budget-terminal",
      title: state.label,
      detail: state.reason,
      tone: "destructive",
    });
  } else if (
    schedule.alertState === "budget_threshold_reached" ||
    (budget.percentage !== null &&
      budget.percentage >= schedule.budgetAlertThreshold)
  ) {
    signals.push({
      key: "budget-alert",
      title: "Budget alert threshold reached",
      detail: `${formatPercentage(budget.percentage ?? 0)} of the credit budget has been consumed.`,
      tone: "warning",
    });
  }

  signals.push({
    key: "overlap-policy",
    title: `Overlap: ${overlapPolicyLabel(schedule.overlapPolicy)}`,
    detail: overlapPolicyDescription(schedule.overlapPolicy),
    tone: schedule.overlapPolicy === "allow_parallel" ? "warning" : "muted",
  });

  const timedOut = /timed?\s*out|timeout/i.test(schedule.lastError ?? "");
  if (timedOut) {
    signals.push({
      key: "timeout",
      title: "Latest run timed out",
      detail:
        schedule.lastError ??
        "The latest execution exceeded its maximum run duration.",
      tone: "destructive",
    });
  } else if (schedule.failureCount > 0 || schedule.lastError) {
    signals.push({
      key: "failure",
      title: schedule.failureCount
        ? `${schedule.failureCount} failed ${plural(schedule.failureCount, "run")}`
        : "Latest run failed",
      detail: schedule.lastError ?? "One or more scheduled runs failed.",
      tone: "destructive",
    });
  }

  if (schedule.endAt) {
    const endDatePassed =
      (timestamp(schedule.endAt) ?? Number.POSITIVE_INFINITY) <= now.getTime();
    signals.push({
      key: "end-date",
      title: endDatePassed ? "End date passed" : "End date set",
      detail: endDatePassed
        ? "This schedule will not create another run after its configured end date."
        : `Automatic execution stops ${formatDateTime(schedule.endAt, schedule.timezone)}.`,
      tone: "muted",
    });
  }

  for (const [index, risk] of schedule.risks.entries()) {
    signals.push({
      key: `projection-risk-${index}`,
      title: "Projection risk",
      detail: risk,
      tone: "warning",
    });
  }

  return signals;
}

export function scheduleHistory(
  schedule: ScheduleRecord,
  schedules: ScheduleRecord[],
  runs: ScheduleRunRecord[],
) {
  const exactRuns = runs.filter((run) => run.scheduleId === schedule.id);
  const transferSchedules = schedules.filter(
    (candidate) => candidate.transferTemplateId === schedule.transferTemplateId,
  );
  if (exactRuns.length || runs.some((run) => run.scheduleId != null)) {
    return {
      mode: "exact" as const,
      notice: null,
      runs: newestRuns(exactRuns),
    };
  }

  if (transferSchedules.length === 1) {
    return {
      mode: "transfer_fallback" as const,
      notice:
        "Run attribution is inferred from scheduled executions for this transfer because the current Studio run payload does not expose schedule IDs.",
      runs: newestRuns(
        runs.filter((run) => normalizeStateValue(run.trigger) === "schedule"),
      ),
    };
  }

  return {
    mode: "unavailable" as const,
    notice:
      "Exact execution history is unavailable because this transfer has multiple schedules and the current Studio run payload does not expose schedule IDs.",
    runs: [] as ScheduleRunRecord[],
  };
}

function creditEstimate(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

function creditEstimateLabel(credits: number | null) {
  return credits === null ? ESTIMATE_UNAVAILABLE : formatCredits(credits);
}

export function formatDateTime(
  value: string | null | undefined,
  timezone?: string | null,
) {
  if (!value) {
    return "Not set";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(date);
  }
}

export function formatDuration(seconds: number | null | undefined) {
  const value = Math.max(0, Number(seconds) || 0);
  if (!value) {
    return "Not limited";
  }
  if (value < 60) {
    return `${value} ${plural(value, "second")}`;
  }
  const minutes = Math.round(value / 60);
  if (minutes < 60) {
    return `${minutes} ${plural(minutes, "minute")}`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder
    ? `${hours}h ${remainder}m`
    : `${hours} ${plural(hours, "hour")}`;
}

export function formatPercentage(value: number) {
  const rounded = Math.round(clampPercentage(value) * 10) / 10;
  return `${rounded}%`;
}

export function overlapPolicyLabel(policy: ScheduleRecord["overlapPolicy"]) {
  return {
    skip_new: "Skip new run",
    cancel_old: "Cancel old run",
    allow_parallel: "Allow parallel",
    queue_new: "Queue new run",
  }[policy];
}

export function executionWindowLabel(schedule: ScheduleRecord) {
  if (
    !schedule.windowStartTime &&
    !schedule.windowEndTime &&
    !schedule.windowDays.length
  ) {
    return "Any time";
  }
  const days = schedule.windowDays.length
    ? schedule.windowDays
        .map((day) => weekdayLabels[day] ?? String(day))
        .join(", ")
    : "Every day";
  const hours =
    schedule.windowStartTime || schedule.windowEndTime
      ? `${schedule.windowStartTime ?? "00:00"}–${schedule.windowEndTime ?? "23:59"}`
      : "all day";
  return `${days}, ${hours}`;
}

function overlapPolicyDescription(policy: ScheduleRecord["overlapPolicy"]) {
  return {
    skip_new: "A due occurrence is skipped while another run is active.",
    cancel_old: "The active run is cancelled before a new run starts.",
    allow_parallel: "New runs may start while an earlier run is still active.",
    queue_new: "A due occurrence waits behind the active run.",
  }[policy];
}

function newestRuns(runs: ScheduleRunRecord[]) {
  return [...runs].sort(
    (left, right) =>
      (timestamp(right.createdAt) ?? 0) - (timestamp(left.createdAt) ?? 0),
  );
}

function clampPercentage(value: number) {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function positiveNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function normalizeStateValue(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
}

function timestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function plural(value: number, singular: string) {
  return value === 1 ? singular : `${singular}s`;
}

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
