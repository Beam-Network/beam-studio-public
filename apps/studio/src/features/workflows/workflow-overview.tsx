import { useQuery } from "@tanstack/react-query";
import { workflowRunsOptions } from "./workflow-queries";
import { useState, type ReactNode } from "react";
import { WorkflowPanel as Panel } from "./workflow-panel";
import { WorkflowRunsPanel } from "./workflow-runs-panel";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  GitBranch,
  MousePointerClick,
  Power,
  PowerOff,
  Settings,
  Workflow,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/data-page";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSectionHeader } from "@/components/header-primitives";
import { cn } from "@/lib/utils";
import {
  getWorkflowEntryStepIds,
  normalizeWorkflowEdges,
  workflowNodeDefinition,
  type WorkflowEdgeKind,
  type WorkflowNodeKind,
  type WorkflowSemanticGraph,
} from "@beam-studio/core/workflows/graph-semantics";
import {
  relativeTimeLabel,
  statusLabel,
  statusTone,
  type StatusTone,
} from "@/features/runs/run-detail-data";
import {
  DateText,
  Fact,
  JsonPanel,
  StatusBadge,
  StatusIcon,
} from "@/features/runs/run-detail-primitives";
import type {
  JsonObject,
  WorkflowBundle,
  WorkflowEdge,
  WorkflowRun,
  WorkflowStep,
  WorkflowTrigger,
  WorkflowTriggerEdge,
} from "./workflow-graph-types";
import type { WorkflowGraphV2Control } from "@beam-studio/core/workflows/graph-v2";

type OverviewTab = "steps" | "runs" | "triggers" | "details";

type Issue = {
  detail: string;
  label: string;
  severity: "blocker" | "warning";
};

export function WorkflowOverview({
  controls,
  edges,
  onEditTrigger,
  onOpenEditor,
  onSetTriggerEnabled,
  runCount,
  scheduleActionPending = false,
  steps,
  template,
  triggerEdges,
  triggers,
}: {
  controls: WorkflowGraphV2Control[];
  edges: WorkflowEdge[];
  onEditTrigger?(triggerId: string): void;
  onOpenEditor?: () => void;
  onSetTriggerEnabled?(triggerId: string, enabled: boolean): void;
  runCount: number;
  scheduleActionPending?: boolean;
  steps: WorkflowStep[];
  template: WorkflowBundle["template"];
  triggerEdges: WorkflowTriggerEdge[];
  triggers: WorkflowTrigger[];
}) {
  const [tab, setTab] = useState<OverviewTab>("steps");
  const runsQuery = useQuery(
    workflowRunsOptions({ workflowTemplateId: template.id, limit: 20 }),
  );
  const runs = runsQuery.data?.runs ?? [];
  const totalCount = runsQuery.data?.totalCount ?? runCount;
  const orderedSteps = orderSteps({ edges, steps, triggerEdges, triggers });
  const graphSummary = summarizeGraph({
    controls,
    edges,
    steps,
    triggerEdges,
    triggers,
  });
  const issues = buildIssues({
    runs,
    steps,
    template,
    triggerEdges,
    triggers,
    edges,
  });
  const stats = buildStats(runs, triggers);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-[min(1080px,calc(100%-32px))] gap-4 py-6">
        <OverviewHeader
          issues={issues}
          onEditTrigger={onEditTrigger}
          onSetTriggerEnabled={onSetTriggerEnabled}
          scheduleActionPending={scheduleActionPending}
          steps={steps}
          template={template}
          triggers={triggers}
        />

        {runsQuery.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : runsQuery.error ? (
          <p role="alert" className="text-sm text-destructive">
            {String(runsQuery.error)}
          </p>
        ) : (
          <StatsBar
            totalCount={totalCount}
            runs={runs}
            stats={stats}
            workflowId={template.id}
          />
        )}

        <GraphSummary summary={graphSummary} steps={orderedSteps} />

        {issues.length ? (
          <AttentionBanner issues={issues} onOpenEditor={onOpenEditor} />
        ) : null}

        <div>
          <TabBar
            active={tab}
            tabs={[
              { count: steps.length, id: "steps", label: "Steps" },
              { count: totalCount, id: "runs", label: "Runs" },
              { count: triggers.length, id: "triggers", label: "Triggers" },
              { id: "details", label: "Details" },
            ]}
            onSelect={setTab}
          />
          <div className="mt-4 grid gap-4">
            {tab === "steps" ? (
              <StepsTab onOpenEditor={onOpenEditor} steps={orderedSteps} />
            ) : tab === "runs" ? (
              runsQuery.isPending ? (
                <Skeleton className="h-48 w-full" />
              ) : runsQuery.error ? (
                <p role="alert">{String(runsQuery.error)}</p>
              ) : (
                <WorkflowRunsPanel
                  preview
                  totalCount={totalCount}
                  runs={runs}
                  templateId={template.id}
                />
              )
            ) : tab === "triggers" ? (
              <TriggersTab
                onEditTrigger={onEditTrigger}
                onSetTriggerEnabled={onSetTriggerEnabled}
                scheduleActionPending={scheduleActionPending}
                triggers={triggers}
              />
            ) : (
              <DetailsTab summary={graphSummary} template={template} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OverviewHeader({
  issues,
  onEditTrigger,
  onSetTriggerEnabled,
  scheduleActionPending,
  steps,
  template,
  triggers,
}: {
  issues: Issue[];
  onEditTrigger?(triggerId: string): void;
  onSetTriggerEnabled?(triggerId: string, enabled: boolean): void;
  scheduleActionPending: boolean;
  steps: WorkflowStep[];
  template: WorkflowBundle["template"];
  triggers: WorkflowTrigger[];
}) {
  const blockers = issues.filter(
    (issue) => issue.severity === "blocker",
  ).length;
  const warnings = issues.length - blockers;
  const schedule = primaryScheduleTrigger(triggers);
  const nextRunAt = schedule ? nextRunFromTrigger(schedule) : null;

  return (
    <PageSectionHeader>
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <Workflow className="h-5 w-5 shrink-0 text-muted-foreground" />
        <h1 className="truncate text-xl font-semibold tracking-tight">
          {template.name}
        </h1>
        <EnabledBadge enabled={template.enabled} />
        {blockers ? (
          <Badge
            className="border-destructive/30 bg-destructive/10 text-destructive"
            variant="outline"
          >
            {blockers} blocker{blockers > 1 ? "s" : ""}
          </Badge>
        ) : warnings ? (
          <Badge
            className="border-warning/30 bg-warning/10 text-warning"
            variant="outline"
          >
            {warnings} warning{warnings > 1 ? "s" : ""}
          </Badge>
        ) : (
          <Badge
            className="border-success/30 bg-success/10 text-success"
            variant="outline"
          >
            Ready
          </Badge>
        )}
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
        <span>
          Starts{" "}
          <span className="font-medium text-foreground">
            {triggerModeLabel(triggers)}
          </span>
        </span>
        <span aria-hidden>·</span>
        <span>
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
        {template.updatedAt && relativeTimeLabel(template.updatedAt) ? (
          <>
            <span aria-hidden>·</span>
            <span>Updated {relativeTimeLabel(template.updatedAt)}</span>
          </>
        ) : null}
      </p>
      {template.description ? (
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          {template.description}
        </p>
      ) : null}
      {schedule ? (
        <ScheduleControl
          actionPending={scheduleActionPending}
          nextRunAt={nextRunAt}
          onEditTrigger={onEditTrigger}
          onSetTriggerEnabled={onSetTriggerEnabled}
          trigger={schedule}
        />
      ) : null}
    </PageSectionHeader>
  );
}

function ScheduleControl({
  actionPending,
  nextRunAt,
  onEditTrigger,
  onSetTriggerEnabled,
  trigger,
}: {
  actionPending: boolean;
  nextRunAt: string | null;
  onEditTrigger?(triggerId: string): void;
  onSetTriggerEnabled?(triggerId: string, enabled: boolean): void;
  trigger: WorkflowTrigger;
}) {
  const nextLabel =
    trigger.enabled && nextRunAt
      ? `Next run ${timeUntilLabel(nextRunAt) || "is scheduled"}.`
      : trigger.enabled
        ? "No future run is scheduled."
        : "Automatic execution is off.";
  const actionLabel = trigger.enabled ? "Disable schedule" : "Enable schedule";
  const ActionIcon = trigger.enabled ? PowerOff : Power;

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-control border bg-card px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-control",
            trigger.enabled
              ? "bg-success/10 text-success"
              : "bg-muted text-muted-foreground",
          )}
        >
          <CalendarClock className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold">
            Schedule {trigger.enabled ? "enabled" : "disabled"}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {nextLabel}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!onSetTriggerEnabled || actionPending}
          onClick={() => onSetTriggerEnabled?.(trigger.id, !trigger.enabled)}
          size="sm"
          type="button"
          variant={trigger.enabled ? "outline" : "default"}
        >
          <ActionIcon className="h-4 w-4" />
          {actionPending ? "Saving..." : actionLabel}
        </Button>
        <Button
          disabled={!onEditTrigger}
          onClick={() => onEditTrigger?.(trigger.id)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Settings className="h-4 w-4" />
          Edit
        </Button>
      </div>
    </div>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge
      className={cn(
        "gap-1.5",
        enabled
          ? "border-success/30 bg-success/10 text-success"
          : "text-muted-foreground",
      )}
      variant="outline"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          enabled ? "bg-success" : "bg-muted-foreground",
        )}
      />
      {enabled ? "Enabled" : "Disabled"}
    </Badge>
  );
}

type Stats = {
  lastRun: WorkflowRun | null;
  medianDurationLabel: string;
  nextScheduleAt: string | null;
  nextScheduleLabel: string;
  successRateLabel: string;
  windowSize: number;
};

function StatsBar({
  runs,
  totalCount,
  stats,
  workflowId,
}: {
  runs: WorkflowRun[];
  totalCount: number;
  stats: Stats;
  workflowId: string;
}) {
  const recent = runs.slice(0, 20);

  return (
    <div className="overflow-hidden rounded-surface border bg-card">
      <dl className="grid sm:grid-cols-2 lg:grid-cols-5">
        <StatCell
          label="Last run"
          value={
            stats.lastRun ? (
              <span className="flex items-center gap-1.5">
                <StatusIcon
                  className="h-3.5 w-3.5"
                  status={stats.lastRun.status}
                />
                {statusLabel(stats.lastRun.status)}
              </span>
            ) : (
              "Never run"
            )
          }
          hint={
            stats.lastRun
              ? relativeTimeLabel(runDate(stats.lastRun)) || undefined
              : undefined
          }
        />
        <StatCell
          label="Success rate"
          value={stats.successRateLabel}
          hint={
            stats.windowSize
              ? `last ${stats.windowSize} run${stats.windowSize > 1 ? "s" : ""}`
              : undefined
          }
        />
        <StatCell
          label="Median duration"
          value={stats.medianDurationLabel}
          hint={stats.windowSize ? "completed runs" : undefined}
        />
        <StatCell label="Total runs" value={String(totalCount)} />
        <StatCell
          label="Next execution"
          value={stats.nextScheduleLabel}
          hint={
            stats.nextScheduleAt
              ? timeUntilLabel(stats.nextScheduleAt) || undefined
              : undefined
          }
        />
      </dl>
      {recent.length ? (
        <ActivityStrip runs={recent} workflowId={workflowId} />
      ) : null}
    </div>
  );
}

function StatCell({
  hint,
  label,
  value,
}: {
  hint?: string;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="min-w-0 border-b px-4 py-3 last:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate text-sm font-medium tabular-nums">
        {value}
      </dd>
      <dd className="truncate text-xs text-muted-foreground">{hint ?? " "}</dd>
    </div>
  );
}

/**
 * Status strip of the most recent runs (oldest → newest). State is carried by
 * the status tokens plus per-bar tooltips and the textual counts alongside,
 * so color is never the only encoding.
 */
const toneLegendOrder: StatusTone[] = [
  "success",
  "danger",
  "active",
  "pending",
  "neutral",
];

function ActivityStrip({
  runs,
  workflowId,
}: {
  runs: WorkflowRun[];
  workflowId: string;
}) {
  const ordered = [...runs].reverse();
  const counts = new Map<StatusTone, number>();
  for (const tone of toneLegendOrder) {
    const count = runs.filter((run) => statusTone(run.status) === tone).length;
    if (count) {
      counts.set(tone, count);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t px-4 py-3">
      <div
        className="flex items-center gap-1"
        role="img"
        aria-label={`Last ${runs.length} runs`}
      >
        {ordered.map((run) => (
          <Link
            className={cn(
              "h-7 w-2 rounded-badge transition-opacity hover:opacity-70",
              toneBarClass(statusTone(run.status)),
            )}
            key={run.id}
            title={`${statusLabel(run.status)} · ${new Date(runDate(run) ?? "").toLocaleString()}`}
            to={`/workflows/${workflowId}/runs/${run.id}` as never}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {[...counts.entries()].map(([tone, count]) => (
          <span className="flex items-center gap-1.5" key={tone}>
            <span className={cn("size-2 rounded-full", toneBarClass(tone))} />
            {count} {toneCountLabel(tone)}
          </span>
        ))}
      </div>
    </div>
  );
}

function toneBarClass(tone: StatusTone) {
  switch (tone) {
    case "success":
      return "bg-success";
    case "danger":
      return "bg-destructive";
    case "active":
    case "pending":
      return "bg-warning";
    default:
      return "bg-muted-foreground/50";
  }
}

function toneCountLabel(tone: StatusTone) {
  switch (tone) {
    case "success":
      return "succeeded";
    case "danger":
      return "failed";
    case "active":
      return "running";
    case "pending":
      return "pending";
    default:
      return "other";
  }
}

function AttentionBanner({
  issues,
  onOpenEditor,
}: {
  issues: Issue[];
  onOpenEditor?: () => void;
}) {
  const hasBlocker = issues.some((issue) => issue.severity === "blocker");

  return (
    <div
      className={cn(
        "rounded-surface border p-4",
        hasBlocker
          ? "border-destructive/40 bg-destructive/5"
          : "border-border bg-muted/40",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className={cn(
              "flex items-center gap-2 text-sm font-semibold",
              hasBlocker ? "text-destructive" : "text-foreground",
            )}
          >
            <AlertTriangle className="h-4 w-4" />
            Needs attention
          </div>
          <ul className="mt-2 grid gap-1.5">
            {issues.map((issue) => (
              <li className="flex items-start gap-2 text-sm" key={issue.label}>
                {issue.severity === "blocker" ? (
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                )}
                <span className="min-w-0">
                  <span className="font-medium">{issue.label}</span>{" "}
                  <span className="text-muted-foreground">{issue.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        {onOpenEditor ? (
          <Button
            onClick={onOpenEditor}
            size="sm"
            type="button"
            variant="outline"
          >
            Fix in editor
            <ArrowUpRight className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TabBar({
  active,
  tabs,
  onSelect,
}: {
  active: OverviewTab;
  tabs: Array<{ count?: number; id: OverviewTab; label: string }>;
  onSelect(tab: OverviewTab): void;
}) {
  return (
    <div className="flex items-center gap-1 border-b" role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={active === tab.id}
          className={cn(
            "-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
            active === tab.id &&
              "border-foreground font-medium text-foreground",
          )}
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          role="tab"
          type="button"
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
              {tab.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function StepsTab({
  onOpenEditor,
  steps,
}: {
  onOpenEditor?: () => void;
  steps: WorkflowStep[];
}) {
  if (!steps.length) {
    return (
      <EmptyState
        action={
          onOpenEditor ? (
            <Button
              onClick={onOpenEditor}
              size="sm"
              type="button"
              variant="outline"
            >
              Open editor
            </Button>
          ) : undefined
        }
        description="Add steps in the editor to define what this workflow runs."
        icon={GitBranch}
        title="No steps yet"
      />
    );
  }

  return (
    <Panel
      action={
        onOpenEditor ? (
          <Button
            onClick={onOpenEditor}
            size="sm"
            type="button"
            variant="outline"
          >
            Open editor
            <ArrowUpRight className="h-4 w-4" />
          </Button>
        ) : undefined
      }
      description="In execution order. Expand a step to read its configuration."
      title="Steps"
    >
      <div className="overflow-hidden rounded-control border">
        <div className="divide-y">
          {steps.map((step, index) => (
            <details className="group" key={step.id}>
              <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 transition-colors hover:bg-secondary/60">
                <span className="grid size-6 shrink-0 place-items-center rounded-control bg-muted font-mono text-xs">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-sm font-medium",
                      !step.enabled && "text-muted-foreground",
                    )}
                  >
                    {displayStepName(step)}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {step.actionPackageName}@{step.actionVersionRange}
                  </span>
                </span>
                <span className="hidden shrink-0 gap-1.5 sm:flex">
                  <Badge variant="secondary">{stepKindLabel(step)}</Badge>
                  {!step.enabled ? (
                    <Badge variant="outline">disabled</Badge>
                  ) : null}
                  {!step.required ? (
                    <Badge variant="secondary">optional</Badge>
                  ) : null}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {step.timeoutSeconds
                    ? formatSeconds(step.timeoutSeconds)
                    : ""}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              </summary>
              <div className="grid gap-3 border-t bg-muted/20 px-3 py-3 lg:grid-cols-2">
                <JsonPanel title="Config" value={step.config} />
                <div className="rounded-control border bg-card p-3">
                  <h4 className="text-xs font-medium">Connected inputs</h4>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {Object.keys(step.inputBindings).length
                      ? Object.keys(step.inputBindings).join(", ")
                      : "No data inputs"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground lg:col-span-2">
                  <span>
                    Placement{" "}
                    <span className="font-medium text-foreground">
                      {step.placement || "default"}
                    </span>
                  </span>
                  <span>
                    Location{" "}
                    <span className="font-medium text-foreground">
                      {step.executionLocationId ?? "local-workers"}
                    </span>
                  </span>
                  <span>
                    Timeout{" "}
                    <span className="font-medium text-foreground">
                      {step.timeoutSeconds
                        ? formatSeconds(step.timeoutSeconds)
                        : "none"}
                    </span>
                  </span>
                </div>
              </div>
            </details>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function TriggersTab({
  onEditTrigger,
  onSetTriggerEnabled,
  scheduleActionPending,
  triggers,
}: {
  onEditTrigger?(triggerId: string): void;
  onSetTriggerEnabled?(triggerId: string, enabled: boolean): void;
  scheduleActionPending: boolean;
  triggers: WorkflowTrigger[];
}) {
  if (!triggers.length) {
    return (
      <EmptyState
        description="Add a trigger in the editor so this workflow can start."
        icon={Zap}
        title="No triggers"
      />
    );
  }

  return (
    <Panel description="How this workflow starts." title="Triggers">
      <div className="overflow-hidden rounded-control border">
        <div className="divide-y">
          {triggers.map((trigger) => {
            const Icon =
              trigger.type === "schedule"
                ? CalendarClock
                : trigger.type === "manual"
                  ? MousePointerClick
                  : Zap;
            const nextRunAt = trigger.enabled
              ? nextRunFromTrigger(trigger)
              : null;
            return (
              <details className="group" key={trigger.id}>
                <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 transition-colors hover:bg-secondary/60">
                  <span className="grid size-8 shrink-0 place-items-center rounded-control bg-secondary text-secondary-foreground">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {trigger.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {trigger.type}
                      {nextRunAt ? (
                        <>
                          {" · next "}
                          {timeUntilLabel(nextRunAt) || (
                            <DateText value={nextRunAt} />
                          )}
                        </>
                      ) : null}
                    </span>
                  </span>
                  <EnabledBadge enabled={trigger.enabled} />
                  <TriggerRowActions
                    actionPending={scheduleActionPending}
                    onEditTrigger={onEditTrigger}
                    onSetTriggerEnabled={onSetTriggerEnabled}
                    trigger={trigger}
                  />
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                </summary>
                <div className="grid gap-3 border-t bg-muted/20 px-3 py-3 lg:grid-cols-2">
                  <JsonPanel title="Config" value={trigger.config} />
                  <div className="rounded-control border bg-card p-3 text-xs text-muted-foreground">
                    {trigger.enabled
                      ? nextRunAt
                        ? `Next execution ${timeUntilLabel(nextRunAt) || "is scheduled"}.`
                        : "This trigger is ready to start the workflow."
                      : "This trigger is disabled."}
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

function TriggerRowActions({
  actionPending,
  onEditTrigger,
  onSetTriggerEnabled,
  trigger,
}: {
  actionPending: boolean;
  onEditTrigger?(triggerId: string): void;
  onSetTriggerEnabled?(triggerId: string, enabled: boolean): void;
  trigger: WorkflowTrigger;
}) {
  const isSchedule = trigger.type === "schedule";
  const toggleLabel = trigger.enabled ? "Disable" : "Enable";

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {isSchedule ? (
        <Button
          disabled={!onSetTriggerEnabled || actionPending}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSetTriggerEnabled?.(trigger.id, !trigger.enabled);
          }}
          size="sm"
          type="button"
          variant={trigger.enabled ? "outline" : "default"}
        >
          {actionPending ? "Saving..." : toggleLabel}
        </Button>
      ) : null}
      <Button
        disabled={!onEditTrigger}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onEditTrigger?.(trigger.id);
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        <Settings className="h-4 w-4" />
        Edit
      </Button>
    </span>
  );
}

function DetailsTab({
  summary,
  template,
}: {
  summary: GraphSummaryData;
  template: WorkflowBundle["template"];
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Panel title="Workflow">
        <div className="grid gap-3">
          <Fact
            label="ID"
            value={<code className="text-xs">{template.id}</code>}
          />
          <Fact
            label="Updated"
            value={<DateText value={template.updatedAt} />}
          />
          <Fact
            label="Legacy transfer"
            value={
              template.legacyTransferTemplateId ? (
                <code className="text-xs">
                  {template.legacyTransferName ??
                    template.legacyTransferTemplateId}
                </code>
              ) : (
                "-"
              )
            }
          />
          <Fact
            label="Graph"
            value={`${summary.runtimeNodeCount} runtime nodes · ${summary.edgeCount} connections`}
          />
        </div>
      </Panel>
      <Panel
        description="A user-facing summary of graph semantics."
        title="Workflow structure"
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          <Fact
            label="Entry steps"
            value={summary.entryLabels.join(", ") || "-"}
          />
          <Fact
            label="Triggers"
            value={String(summary.nodeCounts.trigger ?? 0)}
          />
          <Fact
            label="Actions"
            value={String(summary.nodeCounts.action ?? 0)}
          />
          <Fact
            label="Resources"
            value={String(summary.nodeCounts.resource ?? 0)}
          />
          <Fact
            label="Composites"
            value={String(summary.nodeCounts.composite ?? 0)}
          />
          <Fact
            label="Controls"
            value={String(summary.nodeCounts.control ?? 0)}
          />
        </dl>
      </Panel>
    </div>
  );
}

type GraphSummaryData = {
  edgeCount: number;
  edgeCounts: Partial<Record<WorkflowEdgeKind, number>>;
  entryLabels: string[];
  nodeCounts: Partial<Record<WorkflowNodeKind, number>>;
  runtimeNodeCount: number;
};

function GraphSummary({
  steps,
  summary,
}: {
  steps: WorkflowStep[];
  summary: GraphSummaryData;
}) {
  const sequence = steps.map(displayStepName).slice(0, 6);
  return (
    <Panel
      description="Nodes, connections and execution entry points."
      title="Workflow graph"
    >
      <div className="grid gap-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Fact
            label="Actions"
            value={String(summary.nodeCounts.action ?? 0)}
          />
          <Fact
            label="Resources"
            value={String(summary.nodeCounts.resource ?? 0)}
          />
          <Fact
            label="Composites"
            value={String(summary.nodeCounts.composite ?? 0)}
          />
          <Fact
            label="Controls"
            value={String(summary.nodeCounts.control ?? 0)}
          />
          <Fact
            label="Triggers"
            value={String(summary.nodeCounts.trigger ?? 0)}
          />
          <Fact
            label="Entry steps"
            value={String(summary.entryLabels.length)}
          />
        </dl>
        <div className="border-t pt-3 text-xs text-muted-foreground">
          <p>
            Connections:{" "}
            {Object.entries(summary.edgeCounts)
              .map(([kind, count]) => `${count} ${kind}`)
              .join(" · ") || "none"}
          </p>
          <p className="mt-1">
            Execution: {sequence.join(" → ") || "No runtime nodes"}
            {steps.length > sequence.length ? " → …" : ""}
          </p>
        </div>
      </div>
    </Panel>
  );
}

function summarizeGraph(input: {
  controls: WorkflowGraphV2Control[];
  edges: WorkflowEdge[];
  steps: WorkflowStep[];
  triggerEdges: WorkflowTriggerEdge[];
  triggers: WorkflowTrigger[];
}): GraphSummaryData {
  const semanticNodes = [
    ...input.steps.map((step) => ({
      id: step.id,
      enabled: step.enabled,
      actionPackageName: step.actionPackageName,
      inputBindings: step.inputBindings,
      definition: workflowNodeDefinition({
        actionPackageName: step.actionPackageName,
      }),
    })),
    ...input.triggers.map((trigger) => ({
      id: trigger.id,
      enabled: trigger.enabled,
      definition: workflowNodeDefinition({ kind: "trigger" }),
    })),
    ...input.controls.flatMap((control) => [
      {
        id: control.id,
        enabled: true,
        definition: workflowNodeDefinition({ kind: "control" }),
      },
      ...(control.kind === "fan-out"
        ? [
            {
              id: control.fanInId,
              enabled: true,
              definition: workflowNodeDefinition({ kind: "control" }),
            },
          ]
        : []),
    ]),
  ];
  const semanticGraph: WorkflowSemanticGraph = {
    nodes: semanticNodes,
    edges: normalizeWorkflowEdges({
      nodes: semanticNodes,
      edges: input.edges,
      triggerEdges: input.triggerEdges,
    }),
  };
  const nodeCounts: GraphSummaryData["nodeCounts"] = {};
  for (const graphNode of semanticNodes) {
    const kind = graphNode.definition.kind;
    nodeCounts[kind] = (nodeCounts[kind] ?? 0) + 1;
  }
  const edgeCounts: GraphSummaryData["edgeCounts"] = {};
  for (const edge of semanticGraph.edges) {
    edgeCounts[edge.kind] = (edgeCounts[edge.kind] ?? 0) + 1;
  }
  const stepsById = new Map(input.steps.map((step) => [step.id, step]));
  const entryIds = getWorkflowEntryStepIds(semanticGraph);
  return {
    edgeCount: semanticGraph.edges.length,
    edgeCounts,
    entryLabels: entryIds.map((id) =>
      displayStepName(stepsById.get(id) ?? null),
    ),
    nodeCounts,
    runtimeNodeCount: input.steps.length,
  };
}

function buildStats(runs: WorkflowRun[], triggers: WorkflowTrigger[]): Stats {
  const window = runs.slice(0, 20);
  const successes = window.filter(
    (run) => statusTone(run.status) === "success",
  ).length;
  const durations = window
    .map(durationMsForRun)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const medianMs = durations[Math.floor(durations.length / 2)];
  const nextSchedule = nextScheduleForTriggers(triggers);

  return {
    lastRun: runs[0] ?? null,
    medianDurationLabel:
      medianMs === undefined ? "-" : formatSeconds(Math.round(medianMs / 1000)),
    nextScheduleAt: nextSchedule.nextRunAt,
    nextScheduleLabel: nextSchedule.label,
    successRateLabel: window.length
      ? `${Math.round((successes / window.length) * 100)}%`
      : "-",
    windowSize: window.length,
  };
}

function buildIssues({
  edges,
  runs,
  steps,
  template,
  triggerEdges,
  triggers,
}: {
  edges: WorkflowEdge[];
  runs: WorkflowRun[];
  steps: WorkflowStep[];
  template: WorkflowBundle["template"];
  triggerEdges: WorkflowTriggerEdge[];
  triggers: WorkflowTrigger[];
}): Issue[] {
  const issues: Issue[] = [];

  if (!template.enabled) {
    issues.push({
      detail: "It will not run until re-enabled.",
      label: "Workflow is disabled.",
      severity: "blocker",
    });
  }
  if (!triggers.some((trigger) => trigger.enabled)) {
    issues.push({
      detail: "Enable at least one trigger so the workflow can start.",
      label: "No enabled trigger.",
      severity: "blocker",
    });
  }
  const disabledRequired = steps.filter(
    (step) => step.required && !step.enabled,
  );
  if (disabledRequired.length) {
    issues.push({
      detail: disabledRequired.map(displayStepName).join(", "),
      label: "Required steps are disabled:",
      severity: "blocker",
    });
  }
  const bindingIssues = steps.flatMap((step) =>
    missingBindingsForStep(step).map(
      (input) => `${displayStepName(step)}.${input}`,
    ),
  );
  if (bindingIssues.length) {
    issues.push({
      detail: bindingIssues.slice(0, 3).join(", "),
      label: "Missing required bindings:",
      severity: "warning",
    });
  }
  const configGaps = steps.filter(hasConfigGap);
  if (configGaps.length) {
    issues.push({
      detail: configGaps.map(displayStepName).slice(0, 3).join(", "),
      label: "Empty credential or config fields:",
      severity: "warning",
    });
  }
  const orphans = orphanStepIds({ edges, steps, triggerEdges });
  if (orphans.length) {
    issues.push({
      detail: orphans
        .map((id) =>
          displayStepName(steps.find((step) => step.id === id) ?? null),
        )
        .join(", "),
      label: "Unreachable steps:",
      severity: "warning",
    });
  }
  if (!runs.length && steps.length) {
    issues.push({
      detail: "Run it once to confirm the configuration works.",
      label: "Never tested.",
      severity: "warning",
    });
  }

  return issues;
}

/** Steps in flow order (trigger roots first), falling back to position. */
function orderSteps({
  edges,
  steps,
  triggerEdges,
  triggers,
}: {
  edges: WorkflowEdge[];
  steps: WorkflowStep[];
  triggerEdges: WorkflowTriggerEdge[];
  triggers: WorkflowTrigger[];
}) {
  const byPosition = [...steps].sort(
    (left, right) => left.position - right.position,
  );
  const trigger = triggers.find((item) => item.enabled) ?? triggers[0];
  const visited = new Set<string>();
  const ordered: WorkflowStep[] = [];
  const stepById = new Map(byPosition.map((step) => [step.id, step]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.fromStepId, [
      ...(outgoing.get(edge.fromStepId) ?? []),
      edge.toStepId,
    ]);
  }

  function visit(stepId: string) {
    const step = stepById.get(stepId);
    if (!step || visited.has(stepId)) {
      return;
    }
    visited.add(stepId);
    ordered.push(step);
    for (const next of outgoing.get(stepId) ?? []) {
      visit(next);
    }
  }

  for (const edge of triggerEdges) {
    if (!trigger || edge.triggerId === trigger.id) {
      visit(edge.toStepId);
    }
  }
  for (const step of byPosition) {
    visit(step.id);
  }
  return ordered;
}

function triggerModeLabel(triggers: WorkflowTrigger[]) {
  const types = [...new Set(triggers.map((trigger) => trigger.type))];
  if (!types.length) {
    return "with no trigger";
  }
  return types
    .map((type) =>
      type === "manual"
        ? "manually"
        : type === "schedule"
          ? "on a schedule"
          : `on ${type}`,
    )
    .join(" or ");
}

function stepKindLabel(step: WorkflowStep) {
  const kind = workflowNodeDefinition({
    actionPackageName: step.actionPackageName,
  }).kind;
  if (kind === "resource") return "resource";
  if (kind === "composite") return "composite";
  return "action";
}

function nextScheduleForTriggers(triggers: WorkflowTrigger[]) {
  const schedule = primaryScheduleTrigger(triggers);
  if (!schedule) {
    return { label: "Manual only", nextRunAt: null };
  }
  return {
    label: schedule.enabled ? "Scheduled" : "Schedule disabled",
    nextRunAt: schedule.enabled ? nextRunFromTrigger(schedule) : null,
  };
}

function primaryScheduleTrigger(triggers: WorkflowTrigger[]) {
  return (
    triggers.find(
      (trigger) => trigger.type === "schedule" && trigger.enabled,
    ) ??
    triggers.find((trigger) => trigger.type === "schedule") ??
    null
  );
}

function nextRunFromTrigger(trigger: WorkflowTrigger) {
  if (trigger.type !== "schedule") {
    return null;
  }
  return (
    stringFrom(trigger.config.nextRunAt) ??
    stringFrom(trigger.config.next_run_at) ??
    stringFrom(trigger.state.nextRunAt) ??
    stringFrom(trigger.state.next_run_at)
  );
}

function displayStepName(step: WorkflowStep | null) {
  if (!step) {
    return "Unknown step";
  }
  return stringFrom(step.manifest?.displayName) ?? step.actionPackageName;
}

function missingBindingsForStep(step: WorkflowStep) {
  const requiredInputs = requiredInputNames(step.manifest?.inputs);
  return requiredInputs.filter((input) => {
    const binding = step.inputBindings[input];
    const configValue = step.config[input];
    return isEmptyValue(binding) && isEmptyValue(configValue);
  });
}

function requiredInputNames(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => isJsonObject(item) && item.required === true)
      .map((item) => stringFrom(item.name) ?? stringFrom(item.key))
      .filter((item): item is string => Boolean(item));
  }
  if (isJsonObject(value)) {
    return Object.entries(value)
      .filter(([, spec]) => isJsonObject(spec) && spec.required === true)
      .map(([key]) => key);
  }
  return [];
}

function hasConfigGap(step: WorkflowStep) {
  return Object.entries(step.config).some(([key, value]) => {
    const normalized = key.toLowerCase();
    const looksOperational =
      normalized.includes("credential") ||
      normalized.includes("secret") ||
      normalized.includes("bucket") ||
      normalized.includes("endpoint") ||
      normalized.endsWith("key") ||
      normalized.endsWith("id");
    return looksOperational && isEmptyValue(value);
  });
}

function orphanStepIds({
  edges,
  steps,
  triggerEdges,
}: {
  edges: WorkflowEdge[];
  steps: WorkflowStep[];
  triggerEdges: WorkflowTriggerEdge[];
}) {
  const incoming = new Set<string>();
  for (const edge of triggerEdges) {
    incoming.add(edge.toStepId);
  }
  for (const edge of edges) {
    incoming.add(edge.toStepId);
  }
  return steps
    .filter((step) => step.enabled)
    .filter(
      (step) =>
        !incoming.has(step.id) && steps.some((other) => other.id !== step.id),
    )
    .map((step) => step.id);
}

function durationMsForRun(run: WorkflowRun) {
  const start = dateMs(run.startedAt ?? run.createdAt);
  const end = dateMs(run.completedAt);
  if (start === null || end === null || end < start) {
    return null;
  }
  return end - start;
}

function formatSeconds(totalSeconds: number) {
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/** "in 9h" style label for future timestamps; falls back to past-relative. */
function timeUntilLabel(value?: string | null) {
  const time = dateMs(value);
  if (time === null) {
    return "";
  }
  const seconds = Math.round((time - Date.now()) / 1000);
  if (seconds <= 0) {
    return relativeTimeLabel(value);
  }
  if (seconds < 60) {
    return "in under a minute";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `in ${hours}h`;
  }
  return `in ${Math.round(hours / 24)}d`;
}

function runDate(run: WorkflowRun) {
  return run.startedAt ?? run.createdAt ?? run.completedAt ?? null;
}

function dateMs(value?: string | null) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEmptyValue(value: unknown) {
  return value === null || value === undefined || value === "";
}

function stringFrom(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}
