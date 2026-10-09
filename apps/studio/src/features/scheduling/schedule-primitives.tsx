import type { ReactNode } from "react";
import { Circle } from "lucide-react";
import { PanelHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ScheduleState, ScheduleTone } from "./schedule-data";

export function ScheduleStateBadge({ state }: { state: ScheduleState }) {
  return (
    <Badge
      className={cn("gap-1.5 normal-case", toneClass(state.tone, "badge"))}
      title={state.reason}
      variant="outline"
    >
      <Circle className="size-2 fill-current" />
      {state.label}
    </Badge>
  );
}

export function ProgressMeter({
  label,
  percentage,
  tone = "success",
}: {
  label: string;
  percentage: number | null;
  tone?: ScheduleTone;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate font-medium tabular-nums">{label}</span>
        {percentage === null ? (
          <span className="text-muted-foreground">No limit</span>
        ) : (
          <span className="text-muted-foreground tabular-nums">
            {Math.round(percentage)}%
          </span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", toneClass(tone, "meter"))}
          style={{ width: `${percentage ?? 0}%` }}
        />
      </div>
    </div>
  );
}

export function SchedulePanel({
  action,
  children,
  description,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="overflow-hidden rounded-surface border bg-card">
      <PanelHeader className="flex-wrap justify-between gap-3 px-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </PanelHeader>
      {children}
    </section>
  );
}

export function MetaItem({
  hint,
  label,
  value,
}: {
  hint?: string;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="min-w-0 px-4 py-3">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm font-medium tabular-nums">
        {value}
      </dd>
      {hint ? (
        <dd className="mt-0.5 text-xs text-muted-foreground">{hint}</dd>
      ) : null}
    </div>
  );
}

export function SignalCard({
  detail,
  title,
  tone,
}: {
  detail: string;
  title: string;
  tone: ScheduleTone;
}) {
  return (
    <div className={cn("rounded-control border p-3", toneClass(tone, "signal"))}>
      <div className="flex items-start gap-2">
        <Circle className="mt-1 size-2 shrink-0 fill-current" />
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-1 text-xs leading-5 opacity-80">{detail}</p>
        </div>
      </div>
    </div>
  );
}

function toneClass(tone: ScheduleTone, context: "badge" | "meter" | "signal") {
  if (context === "meter") {
    return {
      success: "bg-success",
      muted: "bg-muted-foreground",
      warning: "bg-warning",
      destructive: "bg-destructive",
    }[tone];
  }
  if (context === "signal") {
    return {
      success: "border-success/30 bg-success/5 text-success",
      muted: "border-border bg-muted/30 text-foreground",
      warning: "border-warning/30 bg-warning/5 text-warning",
      destructive: "border-destructive/30 bg-destructive/5 text-destructive",
    }[tone];
  }
  return {
    success: "border-success/30 bg-success/10 text-success",
    muted: "border-muted-foreground/20 text-muted-foreground",
    warning: "border-warning/30 bg-warning/10 text-warning",
    destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  }[tone];
}
