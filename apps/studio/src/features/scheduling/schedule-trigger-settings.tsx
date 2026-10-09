import {
  useId,
  useMemo,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import {
  intervalMsForFrequency,
  projectSchedule,
} from "@beam-studio/core/scheduling";
import { formatCredits, toHundredths } from "@/lib/format-credits";
import {
  normalizeScheduleTriggerConfig,
  type ScheduleTriggerConfig,
} from "./schedule-config";

export function ScheduleTriggerSettings({
  completedRunCount = 0,
  creditsConsumed = 0,
  estimatedCreditCostReadOnly = false,
  estimatedCreditCostUnavailable = false,
  value,
  onChange,
}: {
  completedRunCount?: number;
  creditsConsumed?: number;
  /** The per-run estimate is priced from the selected transfer, not entered. */
  estimatedCreditCostReadOnly?: boolean;
  /** The read-only estimate could not be priced. */
  estimatedCreditCostUnavailable?: boolean;
  value: Record<string, unknown> | null | undefined;
  onChange(config: ScheduleTriggerConfig): void;
}) {
  const overlapPolicyName = useId();
  const config = normalizeScheduleTriggerConfig(value);
  const frequency = frequencyParts(config.frequency);
  const projection = useMemo(
    () =>
      projectSchedule({
        frequency: config.frequency,
        nextRunAt: config.nextRunAt,
        endAt: config.endAt,
        maxRuns: config.maxRuns,
        completedRunCount,
        timezone: config.timezone,
        windowStartTime: config.windowStartTime,
        windowEndTime: config.windowEndTime,
        windowDays: config.windowDays,
        maxOccurrences: 5,
        horizonDays: 30,
      }),
    [
      config.endAt,
      config.frequency,
      config.maxRuns,
      config.nextRunAt,
      config.timezone,
      config.windowDays,
      config.windowEndTime,
      config.windowStartTime,
      completedRunCount,
    ],
  );
  const risks = [
    ...projection.risks,
    maxDurationRisk(config),
    config.creditBudgetLimit && !config.estimatedCreditCost
      ? estimatedCreditCostUnavailable
        ? "The transfer's credit estimate is unavailable, so the budget cannot be checked."
        : "Credit budget requires an estimated credit cost per run."
      : null,
    creditBudgetRisk(config, projection.estimatedRunCount, creditsConsumed),
  ].filter((risk): risk is string => Boolean(risk));

  function updateConfig(patch: Partial<ScheduleTriggerConfig>) {
    onChange({ ...config, ...patch });
  }

  return (
    <div className="grid gap-3">
      <SchedulePanel
        description="How often this trigger should enqueue a new run."
        title="Frequency"
      >
        <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 max-sm:grid-cols-1">
          <TextInput
            min="1"
            type="number"
            value={frequency.value}
            onChange={(event) =>
              updateConfig({
                frequency: buildFrequency(event.target.value, frequency.unit),
              })
            }
          />
          <NativeSelect
            value={frequency.unit}
            onChange={(event) =>
              updateConfig({
                frequency: buildFrequency(frequency.value, event.target.value),
              })
            }
          >
            <option value="minute">Minutes</option>
            <option value="hour">Hours</option>
            <option value="day">Days</option>
          </NativeSelect>
        </div>
        <Hint>Saved as {config.frequency}.</Hint>
      </SchedulePanel>

      <SchedulePanel
        description="Choose when the trigger starts and whether it should expire."
        title="Timing"
      >
        <Field label="Next run">
          <TextInput
            type="datetime-local"
            value={formatDateTimeInput(new Date(config.nextRunAt))}
            onChange={(event) =>
              updateConfig({
                nextRunAt: dateTimeInputToIso(
                  event.target.value,
                  config.nextRunAt,
                ),
              })
            }
          />
        </Field>
        <ToggleRow
          checked={Boolean(config.endAt)}
          label="Set an end date"
          onCheckedChange={(checked) =>
            updateConfig({
              endAt: checked ? addDaysIso(config.nextRunAt, 7) : null,
            })
          }
        />
        {config.endAt ? (
          <Field label="End time">
            <TextInput
              min={formatDateTimeInput(new Date(config.nextRunAt))}
              type="datetime-local"
              value={formatDateTimeInput(new Date(config.endAt))}
              onChange={(event) =>
                updateConfig({
                  endAt: dateTimeInputToIso(
                    event.target.value,
                    config.endAt ?? config.nextRunAt,
                  ),
                })
              }
            />
          </Field>
        ) : null}
        <Field label="Timezone">
          <TextInput
            value={config.timezone}
            onChange={(event) => updateConfig({ timezone: event.target.value })}
          />
        </Field>
      </SchedulePanel>

      <SchedulePanel
        description="Bound run duration, total runs and credit usage."
        title="Limits"
      >
        <OptionalNumberField
          label="Max run duration"
          suffix="Minutes"
          value={
            config.maxRunDurationSeconds
              ? Math.round(config.maxRunDurationSeconds / 60)
              : null
          }
          onChange={(value) =>
            updateConfig({
              maxRunDurationSeconds: value ? value * 60 : null,
            })
          }
        />
        <OptionalNumberField
          label="Max runs"
          suffix="Runs"
          value={config.maxRuns}
          onChange={(maxRuns) => updateConfig({ maxRuns })}
        />
        <OptionalNumberField
          label="Credit budget"
          min={0.01}
          step={0.01}
          suffix="Credits"
          value={config.creditBudgetLimit}
          onChange={(creditBudgetLimit) => updateConfig({ creditBudgetLimit })}
        />
        {estimatedCreditCostReadOnly ? (
          <div className="grid gap-1 rounded-control border bg-background p-3">
            <span className="text-sm font-medium">Estimated cost per run</span>
            <span className="text-sm tabular-nums text-muted-foreground">
              {estimatedCreditCostUnavailable
                ? "Estimate unavailable"
                : formatCredits(config.estimatedCreditCost)}
            </span>
            <Hint>
              {estimatedCreditCostUnavailable
                ? "The published price for the selected transfer could not be read."
                : "Priced for the selected transfer from the published price."}
            </Hint>
          </div>
        ) : (
          <OptionalNumberField
            label="Estimated cost per run"
            min={0.01}
            step={0.01}
            suffix="Credits"
            value={config.estimatedCreditCost || null}
            onChange={(estimatedCreditCost) =>
              updateConfig({ estimatedCreditCost: estimatedCreditCost ?? 0 })
            }
          />
        )}
        <Field label="Budget alert">
          <div className="grid grid-cols-[minmax(0,1fr)_56px] items-center gap-2">
            <TextInput
              max="100"
              min="1"
              type="number"
              value={String(config.budgetAlertThreshold)}
              onChange={(event) =>
                updateConfig({
                  budgetAlertThreshold: Math.min(
                    Math.max(Number(event.target.value) || 80, 1),
                    100,
                  ),
                })
              }
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        </Field>
      </SchedulePanel>

      <SchedulePanel
        description="Restrict runs to selected hours or days."
        title="Execution window"
      >
        <ToggleRow
          checked={usesExecutionWindow(config)}
          label="Restrict execution"
          onCheckedChange={(checked) =>
            updateConfig(
              checked
                ? { windowStartTime: "09:00", windowEndTime: "17:00" }
                : {
                    windowStartTime: null,
                    windowEndTime: null,
                    windowDays: [],
                  },
            )
          }
        />
        {usesExecutionWindow(config) ? (
          <>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <Field label="Window start">
                <TextInput
                  type="time"
                  value={config.windowStartTime ?? ""}
                  onChange={(event) =>
                    updateConfig({
                      windowStartTime: event.target.value || null,
                    })
                  }
                />
              </Field>
              <Field label="Window end">
                <TextInput
                  type="time"
                  value={config.windowEndTime ?? ""}
                  onChange={(event) =>
                    updateConfig({ windowEndTime: event.target.value || null })
                  }
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <DayOption
                checked={config.windowDays.length === weekdayOptions.length}
                label="All"
                strong
                onChange={(checked) =>
                  updateConfig({
                    windowDays: checked
                      ? weekdayOptions.map((day) => day.value)
                      : [],
                  })
                }
              />
              {weekdayOptions.map((day) => (
                <DayOption
                  checked={config.windowDays.includes(day.value)}
                  key={day.value}
                  label={day.label}
                  onChange={(checked) =>
                    updateConfig({
                      windowDays: checked
                        ? [...config.windowDays, day.value].sort()
                        : config.windowDays.filter(
                            (value) => value !== day.value,
                          ),
                    })
                  }
                />
              ))}
            </div>
          </>
        ) : (
          <Hint>No execution window.</Hint>
        )}
      </SchedulePanel>

      <SchedulePanel
        description="Decide what happens when a previous run is still active."
        title="Overlap policy"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {overlapPolicyOptions.map((option) => (
            <label
              className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-control border bg-background p-3 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/10"
              key={option.value}
            >
              <input
                checked={config.overlapPolicy === option.value}
                className="mt-1 accent-primary"
                name={overlapPolicyName}
                type="radio"
                value={option.value}
                onChange={() => updateConfig({ overlapPolicy: option.value })}
              />
              <span>
                <span className="block text-sm font-medium">
                  {option.label}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </SchedulePanel>

      <SchedulePanel
        description="Preview the effect of the current trigger configuration."
        title="Schedule behavior"
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <ProjectionValue
            label="Projected runs"
            value={`${projection.estimatedRunCount}${
              projection.estimateHorizonDays
                ? ` in ${projection.estimateHorizonDays} days`
                : ""
            }`}
          />
          <ProjectionValue
            label="Next runs"
            value={
              projection.occurrences.length
                ? projection.occurrences
                    .map((occurrence) => new Date(occurrence).toLocaleString())
                    .join(" / ")
                : "None"
            }
          />
          {config.estimatedCreditCost ? (
            <ProjectionValue
              label="Projected remaining credit cost"
              value={formatCredits(
                projection.estimatedRunCount * config.estimatedCreditCost,
              )}
            />
          ) : null}
          {risks.length ? (
            <ProjectionValue label="Risks" value={risks.join(" / ")} />
          ) : null}
        </dl>
      </SchedulePanel>
    </div>
  );
}

function DayOption({
  checked,
  label,
  strong = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  strong?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label
      className={`inline-flex items-center gap-2 rounded-control border bg-background px-3 py-2 text-sm ${
        strong ? "font-semibold" : ""
      }`}
    >
      <input
        checked={checked}
        className="accent-primary"
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function NativeSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className="h-10 w-full rounded-control border bg-background px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
      {...props}
    />
  );
}

function OptionalNumberField({
  label,
  min = 1,
  onChange,
  step = 1,
  suffix,
  value,
}: {
  label: string;
  min?: number;
  onChange(value: number | null): void;
  step?: number;
  suffix: string;
  value: number | null;
}) {
  return (
    <div className="grid gap-2 rounded-control border bg-background p-3">
      <ToggleRow
        checked={value !== null}
        label={label}
        onCheckedChange={(checked) => onChange(checked ? min : null)}
      />
      {value !== null ? (
        <div className="grid grid-cols-[minmax(0,1fr)_80px] items-center gap-2">
          <TextInput
            min={min}
            step={step}
            type="number"
            value={String(value)}
            onChange={(event) =>
              onChange(
                Number(event.target.value) > 0
                  ? Number(event.target.value)
                  : min,
              )
            }
          />
          <span className="text-sm text-muted-foreground">{suffix}</span>
        </div>
      ) : null}
    </div>
  );
}

function ProjectionValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-words leading-6">{value}</dd>
    </div>
  );
}

function SchedulePanel({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="grid gap-3 rounded-surface border bg-muted/20 p-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className="h-10 w-full rounded-control border bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      {...props}
    />
  );
}

function ToggleRow({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange(checked: boolean): void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm font-medium">
      {label}
      <input
        checked={checked}
        className="size-4 accent-primary"
        type="checkbox"
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    </label>
  );
}

function addDaysIso(value: string, days: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function buildFrequency(value: string, unit: string) {
  const amount = Math.max(Number(value) || 1, 1);
  const normalizedUnit = amount === 1 ? unit : `${unit}s`;
  return `every ${amount} ${normalizedUnit}`;
}

function dateTimeInputToIso(value: string, fallback: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function formatDateTimeInput(date: Date) {
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}T${String(
    date.getHours(),
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function frequencyParts(frequency: string) {
  const match = /^every\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i.exec(
    frequency,
  );
  if (!match) {
    return { value: "1", unit: "hour" };
  }
  const unit = match[2]?.toLowerCase() ?? "hour";
  return {
    value: match[1] ?? "1",
    unit: unit.startsWith("minute")
      ? "minute"
      : unit.startsWith("day")
        ? "day"
        : "hour",
  };
}

function maxDurationRisk(config: ScheduleTriggerConfig) {
  const intervalMs = intervalMsForFrequency(config.frequency);
  if (
    config.maxRunDurationSeconds &&
    intervalMs &&
    config.maxRunDurationSeconds * 1_000 > intervalMs
  ) {
    return "Frequency is shorter than the max run duration.";
  }
  return null;
}

function creditBudgetRisk(
  config: ScheduleTriggerConfig,
  projectedRunCount: number,
  creditsConsumed: number,
) {
  if (!config.creditBudgetLimit || !config.estimatedCreditCost) {
    return null;
  }
  const projectedTotal =
    toHundredths(Math.max(creditsConsumed, 0)) +
    projectedRunCount * toHundredths(config.estimatedCreditCost);
  if (projectedTotal > toHundredths(config.creditBudgetLimit)) {
    return "Projected credit use exceeds the configured budget.";
  }
  return null;
}

function usesExecutionWindow(config: ScheduleTriggerConfig) {
  return Boolean(
    config.windowStartTime || config.windowEndTime || config.windowDays.length,
  );
}

const overlapPolicyOptions: Array<{
  value: ScheduleTriggerConfig["overlapPolicy"];
  label: string;
  description: string;
}> = [
  {
    value: "skip_new",
    label: "Skip new run",
    description: "Keep the active run and ignore the new scheduled run.",
  },
  {
    value: "cancel_old",
    label: "Cancel old run",
    description: "Cancel the active run before starting the new scheduled run.",
  },
  {
    value: "allow_parallel",
    label: "Allow parallel",
    description: "Start the new run even if another run is still active.",
  },
  {
    value: "queue_new",
    label: "Queue new run",
    description: "Keep the new run queued until it can be processed.",
  },
];

const weekdayOptions = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];
