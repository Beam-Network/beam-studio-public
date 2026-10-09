import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  Ban,
  Clock,
  GitBranch,
  Layers,
  LoaderCircle,
  Play,
  Plus,
  Power,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { workflowListOptions } from "@/features/workflows/workflow-queries";
import { apiGet, apiSend } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type BoardStatus =
  | "disabled"
  | "enabled"
  | "scheduled"
  | "running"
  | "success"
  | "failed";

type WorkflowRecord = {
  id: string;
  name?: string | null;
  description?: string | null;
  enabled?: boolean;
  stepCount?: number;
  runCount?: number;
  lastRunStatus?: string | null;
  scheduled?: boolean;
  nextRunAt?: string | null;
  updatedAt?: string | null;
};

type WorkflowRunRecord = {
  id?: string;
  runId?: string;
  workflowName?: string | null;
  workflowTemplateId?: string | null;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type BoardCard = {
  actionTarget:
    | { kind: "workflow"; enabled: boolean }
    | { kind: "workflow-run"; status: string };
  detail: string;
  href: string;
  id: string;
  kind: "workflow" | "run";
  name: string;
  nextRunAt?: string | null;
  status: BoardStatus;
  timestamp?: string | null;
};

type BoardAction = {
  cardKey: string;
  icon: LucideIcon;
  id: string;
  key: string;
  label: string;
  operation: "enable" | "disable" | "run" | "cancel" | "retry";
  target: BoardCard["actionTarget"]["kind"];
  variant?: "outline" | "secondary" | "destructive";
};

const columns: Array<{ id: BoardStatus; label: string }> = [
  { id: "disabled", label: "Disabled" },
  { id: "enabled", label: "Enabled" },
  { id: "scheduled", label: "Scheduled" },
  { id: "running", label: "Running" },
  { id: "success", label: "Success" },
  { id: "failed", label: "Failed" },
];

const dashboardRefetchInterval = 5_000;

export function DashboardPage() {
  const queryClient = useQueryClient();
  const workflowsQuery = useQuery({
    ...workflowListOptions(),
    refetchInterval: dashboardRefetchInterval,
  });
  const workflowRunsQuery = useQuery({
    queryKey: ["/studio/workflow-runs"],
    queryFn: () =>
      apiGet<{ runs?: WorkflowRunRecord[] }>("/studio/workflow-runs"),
    refetchInterval: dashboardRefetchInterval,
  });
  const workflows = workflowsQuery.data?.workflows ?? [];
  const workflowRuns = workflowRunsQuery.data?.runs ?? [];
  const cards = useMemo(
    () => buildBoardCards({ workflowRuns, workflows }),
    [workflowRuns, workflows],
  );
  const error = [workflowsQuery, workflowRunsQuery].find(
    (query) => query.error && query.data === undefined,
  )?.error;
  const pending = workflowsQuery.isPending || workflowRunsQuery.isPending;
  const actionMutation = useMutation({
    mutationFn: executeBoardAction,
    onSuccess: async () => {
      await Promise.all(
        [["/studio/workflows"], ["/studio/workflow-runs"]].map((queryKey) =>
          queryClient.invalidateQueries({ exact: true, queryKey }),
        ),
      );
    },
  });

  if (error) {
    return (
      <div className="rounded-surface border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        Could not load the dashboard: {String(error)}
      </div>
    );
  }

  // A new Studio has nothing to put on the board: say what to do first rather
  // than showing six empty columns.
  if (!pending && workflows.length === 0 && workflowRuns.length === 0) {
    return (
      <EmptyState
        action={
          <Button asChild>
            <Link to="/workflows/new">
              <Plus className="h-4 w-4" />
              Create your first workflow
            </Link>
          </Button>
        }
        className="mx-auto mt-6 max-w-xl"
        description="A workflow moves your data: add a source and a destination, connect them with a Beam Transfer step, then run it. Its runs appear here."
        icon={GitBranch}
        title="No workflows yet"
      />
    );
  }

  return (
    <div className="h-full min-h-0 overflow-x-auto">
      <div className="flex h-full min-w-max gap-3">
        {columns.map((column) => (
          <KanbanColumn
            cards={cards.filter((card) => card.status === column.id)}
            key={column.id}
            label={column.label}
            pending={pending}
            pendingActionKey={
              actionMutation.isPending
                ? actionMutation.variables?.key
                : undefined
            }
            status={column.id}
            onAction={(action) => actionMutation.mutate(action)}
          />
        ))}
      </div>
      {actionMutation.error ? (
        <div
          className="fixed bottom-4 right-4 z-50 max-w-sm rounded-control border border-destructive/40 bg-background p-3 text-sm text-destructive shadow-lg"
          role="alert"
        >
          Action failed: {String(actionMutation.error)}
        </div>
      ) : null}
    </div>
  );
}

function KanbanColumn({
  cards,
  label,
  pending,
  pendingActionKey,
  status,
  onAction,
}: {
  cards: BoardCard[];
  label: string;
  pending: boolean;
  pendingActionKey?: string;
  status: BoardStatus;
  onAction(action: BoardAction): void;
}) {
  const collapsed = !pending && cards.length === 0;

  return (
    <section
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-none border bg-muted/70 transition-[width,min-width] duration-200 dark:bg-muted/25",
        collapsed ? "w-10 min-w-10" : "w-[292px] min-w-[292px]",
      )}
    >
      <header
        className={cn(
          "flex shrink-0",
          collapsed
            ? "h-full flex-col items-center gap-3 py-3"
            : "h-11 items-center justify-between border-b px-3",
        )}
      >
        {collapsed ? (
          <>
            <span className={cn("size-2 rounded-full", columnDot(status))} />
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground [writing-mode:vertical-rl]">
              {label}
            </h2>
          </>
        ) : (
          <>
            <span className="flex items-center gap-2">
              <span className={cn("size-2 rounded-full", columnDot(status))} />
              <h2 className="text-sm font-medium">{label}</h2>
            </span>
            <span className="grid min-w-6 place-items-center rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {pending ? "–" : cards.length}
            </span>
          </>
        )}
      </header>
      {!collapsed ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {pending ? (
            <div className="grid gap-2">
              <KanbanSkeleton />
              <KanbanSkeleton />
            </div>
          ) : (
            <div className="grid gap-2">
              {cards.map((card) => (
                <KanbanCard
                  card={card}
                  key={`${card.kind}:${card.id}`}
                  pendingActionKey={pendingActionKey}
                  onAction={onAction}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function KanbanCard({
  card,
  pendingActionKey,
  onAction,
}: {
  card: BoardCard;
  pendingActionKey?: string;
  onAction(action: BoardAction): void;
}) {
  const visual = cardVisual(card.kind);
  const Icon = visual.icon;
  const actions = actionsForCard(card);
  const cardActionPending = actions.some(
    (action) => action.key === pendingActionKey,
  );

  return (
    <div className="group overflow-hidden rounded-surface border bg-card shadow-sm transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md">
      <Link className="block p-3" to={card.href as never}>
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-control",
              visual.className,
            )}
          >
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {card.name}
            </span>
            <span className="mt-0.5 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {visual.label}
            </span>
          </span>
        </div>
        <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {card.detail}
        </p>
        {card.status === "scheduled" ? (
          <ScheduleCountdown nextRunAt={card.nextRunAt} />
        ) : null}
      </Link>
      <div className="flex min-h-10 items-center justify-between gap-2 border-t px-3 py-1.5">
        <span className="min-w-0 text-[11px] text-muted-foreground">
          <span className="capitalize">{card.status}</span>
          <span aria-hidden> · </span>
          <span>{relativeTime(card.timestamp)}</span>
        </span>
        {actions.length ? (
          <div className="flex shrink-0 items-center gap-1">
            {actions.map((action) => {
              const ActionIcon =
                pendingActionKey === action.key ? LoaderCircle : action.icon;
              return (
                <Button
                  aria-label={action.label}
                  className="h-7 gap-1 px-2 text-[11px]"
                  disabled={cardActionPending}
                  key={action.key}
                  onClick={() => onAction(action)}
                  size="sm"
                  title={action.label}
                  type="button"
                  variant={action.variant ?? "outline"}
                >
                  <ActionIcon
                    className={cn(
                      "size-3.5",
                      pendingActionKey === action.key && "animate-spin",
                    )}
                  />
                  {action.label}
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ScheduleCountdown({ nextRunAt }: { nextRunAt?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  const target = nextRunAt ? Date.parse(nextRunAt) : NaN;
  const hasNextRun = Number.isFinite(target);

  useEffect(() => {
    if (!hasNextRun) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasNextRun, target]);

  const seconds = Math.max(0, Math.ceil((target - now) / 1_000));
  const days = Math.floor(seconds / 86_400);
  const time = [
    Math.floor((seconds % 86_400) / 3_600),
    Math.floor((seconds % 3_600) / 60),
    seconds % 60,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");

  return (
    <div
      className="mt-3 flex items-center gap-2 rounded-control bg-warning/10 px-2 py-1.5 text-xs text-warning"
      title={hasNextRun ? new Date(target).toLocaleString() : undefined}
    >
      <Clock aria-hidden className="size-3.5 shrink-0" />
      <span className="flex-1">Next run</span>
      <span className="font-medium tabular-nums">
        {hasNextRun
          ? seconds === 0
            ? "Due now"
            : `${days > 0 ? `${days}d ` : ""}${time}`
          : "Not available"}
      </span>
    </div>
  );
}

function KanbanSkeleton() {
  return (
    <div className="animate-pulse rounded-surface border bg-card p-3">
      <div className="flex gap-2.5">
        <div className="size-8 rounded-control bg-muted" />
        <div className="grid flex-1 gap-1.5">
          <div className="h-3 w-3/4 rounded-control-compact bg-muted" />
          <div className="h-2.5 w-1/3 rounded-control-compact bg-muted" />
        </div>
      </div>
      <div className="mt-4 h-8 rounded-control-compact bg-muted" />
    </div>
  );
}

function buildBoardCards({
  workflowRuns,
  workflows,
}: {
  workflowRuns: WorkflowRunRecord[];
  workflows: WorkflowRecord[];
}) {
  const workflowCards: BoardCard[] = workflows.map((workflow) => ({
    actionTarget: {
      kind: "workflow",
      enabled: workflow.enabled !== false,
    },
    detail: `${workflow.stepCount ?? 0} steps · ${workflow.runCount ?? 0} runs`,
    href: `/workflows/${workflow.id}/editor`,
    id: workflow.id,
    kind: "workflow",
    name: workflow.name?.trim() || "Untitled workflow",
    nextRunAt: workflow.nextRunAt,
    status: resourceStatus({
      enabled: workflow.enabled !== false,
      scheduled: workflow.scheduled === true,
    }),
    timestamp: workflow.updatedAt,
  }));
  const workflowRunCards: BoardCard[] = workflowRuns.flatMap((run) => {
    const id = run.id ?? run.runId;
    if (!id) {
      return [];
    }
    return [
      {
        actionTarget: {
          kind: "workflow-run" as const,
          status: run.status ?? "",
        },
        detail: `Workflow execution · ${run.status || "Pending"}`,
        href: run.workflowTemplateId
          ? `/workflows/${run.workflowTemplateId}/runs/${id}`
          : `/workflows/runs/${id}`,
        id,
        kind: "run" as const,
        name: run.workflowName?.trim() || id,
        status: runStatus(run.status),
        timestamp: run.updatedAt ?? run.createdAt,
      },
    ];
  });

  return [...workflowCards, ...workflowRunCards].sort(
    (left, right) => timeValue(right.timestamp) - timeValue(left.timestamp),
  );
}

function actionsForCard(card: BoardCard): BoardAction[] {
  const cardKey = `${card.kind}:${card.id}`;
  const action = (
    operation: BoardAction["operation"],
    label: string,
    icon: LucideIcon,
    variant?: BoardAction["variant"],
  ): BoardAction => ({
    cardKey,
    icon,
    id: card.id,
    key: `${cardKey}:${operation}`,
    label,
    operation,
    target: card.actionTarget.kind,
    variant,
  });

  if (card.actionTarget.kind === "workflow") {
    if (!card.actionTarget.enabled) {
      return [action("enable", "Enable", Power, "secondary")];
    }
    return [
      action("run", "Run", Play, "secondary"),
      action("disable", "Disable", Power),
    ];
  }

  if (
    ["queued", "running", "cancel_requested"].includes(
      normalizeStatus(card.actionTarget.status),
    )
  ) {
    return [action("cancel", "Cancel", Ban, "destructive")];
  }

  if (card.status === "failed") {
    return [action("retry", "Retry", RotateCcw, "secondary")];
  }

  return [];
}

async function executeBoardAction(action: BoardAction) {
  if (action.operation === "run")
    return apiSend("POST", `/studio/workflows/${action.id}/run`);
  if (action.operation === "cancel" || action.operation === "retry")
    return apiSend(
      "POST",
      `/studio/workflow-runs/${action.id}/${action.operation}`,
    );
  return apiSend("PATCH", `/studio/workflows/${action.id}`, {
    enabled: action.operation === "enable",
  });
}

function resourceStatus({
  enabled,
  scheduled,
}: {
  enabled: boolean;
  scheduled: boolean;
}): BoardStatus {
  if (!enabled) {
    return "disabled";
  }
  if (scheduled) {
    return "scheduled";
  }
  return "enabled";
}

function runStatus(status?: string | null): BoardStatus {
  const normalized = normalizeStatus(status);
  if (["completed", "success", "succeeded"].includes(normalized)) {
    return "success";
  }
  if (["failed", "cancelled", "dead_letter"].includes(normalized)) {
    return "failed";
  }
  return "running";
}

function normalizeStatus(status?: string | null) {
  return String(status ?? "")
    .trim()
    .toLowerCase();
}

function cardVisual(kind: BoardCard["kind"]): {
  className: string;
  icon: LucideIcon;
  label: string;
} {
  if (kind === "workflow") {
    return {
      className: "bg-info/10 text-info",
      icon: GitBranch,
      label: "Workflow",
    };
  }
  return {
    className: "bg-success/10 text-success",
    icon: Activity,
    label: "Run",
  };
}

function columnDot(status: BoardStatus) {
  if (status === "failed") {
    return "bg-destructive";
  }
  if (status === "success") {
    return "bg-success";
  }
  if (status === "running") {
    return "bg-info";
  }
  if (status === "scheduled") {
    return "bg-warning";
  }
  if (status === "enabled") {
    return "bg-foreground";
  }
  return "bg-muted-foreground";
}

function relativeTime(value?: string | null) {
  const timestamp = timeValue(value);
  if (!timestamp) {
    return "–";
  }
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) {
    return formatter.format(seconds, "second");
  }
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) {
    return formatter.format(minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) {
    return formatter.format(hours, "hour");
  }
  return formatter.format(Math.round(hours / 24), "day");
}

function timeValue(value?: string | null) {
  if (!value) {
    return 0;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
