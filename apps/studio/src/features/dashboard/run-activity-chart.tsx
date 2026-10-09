import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export type RunActivityPoint = {
  date: string;
  completed: number;
  failed: number;
  other: number;
  total: number;
};

type Series = {
  key: "completed" | "failed" | "other";
  label: string;
  fill: string;
  dot: string;
};

/**
 * Stack order is bottom-up: completed sits on the baseline, other caps the bar.
 * Completed uses the shared success green. Gaps, labels and the data table
 * supplement color to distinguish the series.
 */
const series: Series[] = [
  {
    key: "completed",
    label: "Completed",
    fill: "bg-chart-completed",
    dot: "bg-chart-completed",
  },
  { key: "failed", label: "Failed", fill: "bg-chart-failed", dot: "bg-chart-failed" },
  { key: "other", label: "Other", fill: "bg-chart-other", dot: "bg-chart-other" },
];

const PLOT_HEIGHT = 132;

export function RunActivityChart({
  isPending,
  points,
}: {
  isPending: boolean;
  points: RunActivityPoint[];
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const runTotal = points.reduce((total, point) => total + point.total, 0);
  const max = points.reduce((peak, point) => Math.max(peak, point.total), 0);
  const niceMax = useMemo(() => niceCeiling(max), [max]);
  const activeSeries = series.filter(
    (entry) => entry.key !== "other" || points.some((point) => point.other > 0),
  );

  if (isPending) {
    return (
      <div className="grid gap-3">
        <div className="flex items-end gap-1.5" style={{ height: PLOT_HEIGHT }}>
          {Array.from({ length: 14 }).map((_, index) => (
            <div
              className="flex-1 animate-pulse rounded-t-badge bg-muted"
              key={index}
              style={{ height: `${28 + ((index * 37) % 62)}%` }}
            />
          ))}
        </div>
        <div className="h-3 w-full animate-pulse rounded-control-compact bg-muted" />
      </div>
    );
  }

  return (
    <figure className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <figcaption className="text-sm text-muted-foreground">
          {runTotal
            ? `${formatCount(runTotal, "run")} in the last ${points.length} days`
            : `No runs in the last ${points.length} days`}
        </figcaption>
        <ul className="flex items-center gap-3">
          {activeSeries.map((entry) => (
            <li
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              key={entry.key}
            >
              <span className={cn("size-2 rounded-full", entry.dot)} />
              {entry.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex gap-3">
        <div
          aria-hidden
          className="flex w-7 shrink-0 flex-col justify-between text-right text-[11px] tabular-nums text-muted-foreground"
          style={{ height: PLOT_HEIGHT }}
        >
          <span className="-translate-y-1/2 leading-none">{niceMax}</span>
          <span className="translate-y-1/2 leading-none">0</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height: PLOT_HEIGHT }}>
            <span className="absolute inset-x-0 top-0 h-px bg-border" />
            <span className="absolute inset-x-0 bottom-0 h-px bg-border" />
            <div className="relative flex h-full items-stretch gap-1">
              {points.map((point, index) => (
                <ActivityColumn
                  active={activeIndex === index}
                  align={
                    index < 2 ? "start" : index > points.length - 3 ? "end" : "center"
                  }
                  key={point.date}
                  niceMax={niceMax}
                  onActiveChange={(next) =>
                    setActiveIndex((current) =>
                      next ? index : current === index ? null : current,
                    )
                  }
                  point={point}
                />
              ))}
            </div>
          </div>

          <div aria-hidden className="mt-2 flex gap-1">
            {points.map((point, index) => (
              <span
                className="min-w-0 flex-1 truncate text-center text-[11px] leading-none text-muted-foreground"
                key={point.date}
              >
                {index % 3 === 0 || index === points.length - 1
                  ? shortDate(point.date)
                  : ""}
              </span>
            ))}
          </div>
        </div>
      </div>

      <table className="sr-only">
        <caption>Workflow runs per day over the last {points.length} days</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {series.map((entry) => (
              <th key={entry.key} scope="col">
                {entry.label}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.date}>
              <th scope="row">{longDate(point.date)}</th>
              <td>{point.completed}</td>
              <td>{point.failed}</td>
              <td>{point.other}</td>
              <td>{point.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function ActivityColumn({
  active,
  align,
  niceMax,
  onActiveChange,
  point,
}: {
  active: boolean;
  align: "start" | "center" | "end";
  niceMax: number;
  onActiveChange(active: boolean): void;
  point: RunActivityPoint;
}) {
  const filled = series
    .filter((entry) => point[entry.key] > 0)
    .map((entry) => entry.key);
  const topKey = filled.at(-1);
  // A short bar leaves room to float the tooltip above it; a tall one would push
  // it out of the card, so that case pins to the top of the plot instead.
  const tall = point.total / niceMax > 0.45;

  return (
    <div
      aria-label={columnLabel(point)}
      className="group relative flex min-w-0 flex-1 cursor-default flex-col justify-end rounded-badge outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onBlur={() => onActiveChange(false)}
      onFocus={() => onActiveChange(true)}
      onMouseEnter={() => onActiveChange(true)}
      onMouseLeave={() => onActiveChange(false)}
      tabIndex={0}
    >
      {active && tall ? (
        <ColumnTooltip align={align} className="top-0" point={point} />
      ) : null}

      <div className="relative mx-auto flex w-full max-w-6 flex-col justify-end gap-[2px]">
        {active && !tall ? (
          <ColumnTooltip
            align={align}
            className="bottom-[calc(100%+0.5rem)]"
            point={point}
          />
        ) : null}
        {point.total ? (
          [...series].reverse().map((entry) =>
            point[entry.key] ? (
              <span
                className={cn(
                  entry.fill,
                  "w-full transition-opacity",
                  entry.key === topKey && "rounded-t-badge",
                  active && "opacity-90",
                )}
                key={entry.key}
                style={{
                  height: `${(point[entry.key] / niceMax) * PLOT_HEIGHT}px`,
                }}
              />
            ) : null,
          )
        ) : (
          <span className="h-0.5 w-full rounded-full bg-chart-track" />
        )}
      </div>
    </div>
  );
}

function ColumnTooltip({
  align,
  className,
  point,
}: {
  align: "start" | "center" | "end";
  className?: string;
  point: RunActivityPoint;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-10 w-max rounded-control border bg-popover px-2.5 py-2 text-popover-foreground shadow-md",
        align === "center" && "left-1/2 -translate-x-1/2",
        align === "start" && "left-0",
        align === "end" && "right-0",
        className,
      )}
      role="tooltip"
    >
      <p className="text-xs font-medium">{longDate(point.date)}</p>
      {point.total ? (
        <ul className="mt-1.5 grid gap-1">
          {series
            .filter((entry) => point[entry.key] > 0)
            .map((entry) => (
              <li
                className="flex items-center gap-2 text-xs text-muted-foreground"
                key={entry.key}
              >
                <span className={cn("size-2 shrink-0 rounded-full", entry.dot)} />
                <span className="flex-1">{entry.label}</span>
                <span className="font-medium tabular-nums text-foreground">
                  {point[entry.key]}
                </span>
              </li>
            ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">No runs</p>
      )}
    </div>
  );
}

function columnLabel(point: RunActivityPoint) {
  if (!point.total) {
    return `${longDate(point.date)}: no runs`;
  }

  const parts = series
    .filter((entry) => point[entry.key] > 0)
    .map((entry) => `${point[entry.key]} ${entry.label.toLowerCase()}`);

  return `${longDate(point.date)}: ${formatCount(point.total, "run")} — ${parts.join(", ")}`;
}

function formatCount(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/** Rounds up to 1/2/5 × 10^n so the top gridline reads as a clean number. */
function niceCeiling(max: number) {
  if (max <= 1) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(max));

  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    if (max <= candidate) {
      return candidate;
    }
  }

  return magnitude * 10;
}

function parseDay(value: string) {
  const date = new Date(`${value}T00:00:00`);

  return Number.isNaN(date.getTime()) ? null : date;
}

function shortDate(value: string) {
  const date = parseDay(value);

  return date
    ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(
        date,
      )
    : value;
}

function longDate(value: string) {
  const date = parseDay(value);

  return date
    ? new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        day: "numeric",
        month: "long",
      }).format(date)
    : value;
}
