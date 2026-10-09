import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  Folder,
  GitBranch,
  Layers,
  X,
  type LucideIcon,
} from "lucide-react";
import { PageSectionHeader, PanelHeader } from "@/components/header-primitives";
import { Button } from "@/components/ui/button";
import type {
  WorkflowBundle,
  WorkflowRun,
} from "@/features/workflows/workflow-graph-types";
import {
  workflowDefinitionOptions,
  workflowListOptions,
  workflowRunsOptions,
} from "@/features/workflows/workflow-queries";
import { cn } from "@/lib/utils";

type PanelTab = "overview" | "runs";

type WorkflowSummary = {
  id: string;
  name?: string | null;
  description?: string | null;
  enabled?: boolean;
};

type PanelRun = {
  createdAt?: string | null;
  id: string;
  kind: "workflow";
  name?: string | null;
  resourceId?: string | null;
  status: string;
};

export function StudioOverviewRunsPanel({
  onOpenChange,
  open,
  route,
}: {
  onOpenChange(open: boolean): void;
  open: boolean;
  route: string;
}) {
  const titleId = useId();
  const [tab, setTab] = useState<PanelTab>("overview");
  const workflowId = workflowIdFromRoute(route);
  const contextual = Boolean(workflowId);

  const workflowQuery = useQuery({
    ...workflowDefinitionOptions(workflowId ?? ""),
    enabled: open && Boolean(workflowId),
  });
  const workflowsQuery = useQuery({
    ...workflowListOptions(),
    enabled: open && !contextual,
  });
  const workflowRunsQuery = useQuery({
    ...workflowRunsOptions({ workflowTemplateId: workflowId ?? undefined }),
    enabled: open && (contextual || tab === "runs"),
  });

  useEffect(() => {
    setTab("overview");
  }, [route]);

  const runs = useMemo(
    () =>
      panelRuns({
        workflow: workflowQuery.data,
        workflowRuns: workflowRunsQuery.data?.runs,
      }),
    [workflowQuery.data, workflowRunsQuery.data?.runs],
  );
  const loading = workflowId
    ? workflowQuery.isPending || workflowRunsQuery.isPending
    : workflowsQuery.isPending ||
      (tab === "runs" && workflowRunsQuery.isPending);

  return (
    <aside
      aria-labelledby={titleId}
      className={cn(
        "fixed bottom-0 right-0 top-0 z-40 flex w-[min(420px,100vw)] flex-col overflow-hidden border-l bg-card text-card-foreground transition-transform duration-200",
        open ? "translate-x-0" : "translate-x-full",
      )}
      inert={!open}
      role="dialog"
    >
      <PanelHeader className="gap-3">
        <h2 className="sr-only" id={titleId}>
          Context details
        </h2>
        <div
          aria-label="Right sidebar view"
          className="flex min-w-0 flex-1 items-center gap-1"
          role="tablist"
        >
          <PanelTabButton
            active={tab === "overview"}
            label="Overview"
            onClick={() => setTab("overview")}
          />
          <PanelTabButton
            active={tab === "runs"}
            label="Runs"
            onClick={() => setTab("runs")}
          />
        </div>
        <Button
          aria-label="Close right sidebar"
          onClick={() => onOpenChange(false)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <PanelSkeleton />
        ) : tab === "overview" ? (
          workflowQuery.data ? (
            <WorkflowOverviewContent
              workflow={workflowQuery.data}
              runs={workflowRunsQuery.data?.runs ?? []}
            />
          ) : (
            <GlobalOverviewContent
              workflows={workflowsQuery.data?.workflows ?? []}
            />
          )
        ) : (
          <RunsContent runs={runs} />
        )}
      </div>
    </aside>
  );
}

function PanelTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-selected={active}
      className={cn(
        "relative h-14 px-2 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active && "font-medium text-foreground",
      )}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {label}
      {active ? (
        <span className="absolute inset-x-2 bottom-0 h-0.5 bg-foreground" />
      ) : null}
    </button>
  );
}

function WorkflowOverviewContent({
  workflow,
  runs,
}: {
  workflow: WorkflowBundle;
  runs: WorkflowRun[];
}) {
  const latestRun = runs[0];

  return (
    <div className="grid gap-5">
      <PanelHeading
        description={workflow.template.description}
        icon={GitBranch}
        title={workflow.template.name}
      />
      <PanelFacts
        facts={[
          ["Status", workflow.template.enabled ? "Enabled" : "Disabled"],
          ["Steps", String(workflow.steps.length)],
          ["Triggers", String(workflow.triggers.length)],
          ["Runs", String(workflow.runCount)],
        ]}
      />
      <PanelSection title="Latest run">
        {latestRun ? (
          <RunLink
            run={{
              createdAt: latestRun.createdAt,
              id: latestRun.id,
              kind: "workflow",
              name: latestRun.workflowName ?? workflow.template.name,
              resourceId: workflow.template.id,
              status: latestRun.status,
            }}
          />
        ) : (
          <MutedText>No runs yet.</MutedText>
        )}
      </PanelSection>
    </div>
  );
}

function GlobalOverviewContent({
  workflows,
}: {
  workflows: WorkflowSummary[];
}) {
  const enabledWorkflows = workflows.filter(
    (workflow) => workflow.enabled,
  ).length;

  return (
    <div className="grid gap-5">
      <PanelHeading
        description="A compact view of the resources in the current workspace."
        icon={Layers}
        title="Workspace"
      />
      <PanelFacts
        facts={[
          ["Workflows", String(workflows.length)],
          ["Enabled", String(enabledWorkflows)],
        ]}
      />
      <PanelSection title="Resources">
        <div className="grid gap-2">
          <Link
            className="flex items-center justify-between rounded-control border px-3 py-3 text-sm transition-colors hover:bg-accent"
            to={"/workflows" as never}
          >
            <span className="flex items-center gap-2">
              <GitBranch className="size-4 text-muted-foreground" />
              Workflows
            </span>
            <span className="text-muted-foreground">{workflows.length}</span>
          </Link>
        </div>
      </PanelSection>
    </div>
  );
}

function RunsContent({ runs }: { runs: PanelRun[] }) {
  if (!runs.length) {
    return (
      <div className="grid min-h-64 place-items-center text-center">
        <div>
          <Activity className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No runs yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Executions will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-1">
      {runs.map((run) => (
        <RunLink key={`${run.kind}:${run.id}`} run={run} />
      ))}
    </div>
  );
}

function RunLink({ run }: { run: PanelRun }) {
  const href = run.resourceId
    ? `/workflows/${run.resourceId}/runs/${run.id}`
    : `/workflows/runs/${run.id}`;

  return (
    <Link
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-control px-2 py-2.5 transition-colors hover:bg-accent"
      to={href as never}
    >
      <span
        className={cn(
          "size-2 rounded-full bg-muted-foreground",
          statusClass(run.status),
        )}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">
          {run.name || run.id}
        </span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {run.id}
        </span>
      </span>
      <span className="text-right text-xs text-muted-foreground">
        <span className="block capitalize">{run.status}</span>
        <span className="block">{relativeTime(run.createdAt)}</span>
      </span>
    </Link>
  );
}

function PanelHeading({
  description,
  icon: Icon,
  title,
}: {
  description?: string | null;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <PageSectionHeader className="grid gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="truncate text-base font-semibold">{title}</h3>
      </div>
      {description ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
    </PageSectionHeader>
  );
}

function PanelFacts({ facts }: { facts: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-surface border">
      {facts.map(([label, value]) => (
        <div className="border-b border-r p-3 even:border-r-0" key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PanelSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function MutedText({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function PanelSkeleton() {
  return (
    <div className="grid gap-4">
      <div className="h-20 animate-pulse rounded-control bg-muted" />
      <div className="h-28 animate-pulse rounded-control bg-muted" />
      <div className="h-40 animate-pulse rounded-control bg-muted" />
    </div>
  );
}

function panelRuns({
  workflow,
  workflowRuns,
}: {
  workflow?: WorkflowBundle;
  workflowRuns?: WorkflowRun[];
}) {
  return (workflowRuns ?? []).map((run) => ({
    createdAt: run.createdAt,
    id: run.id,
    kind: "workflow" as const,
    name: run.workflowName ?? workflow?.template.name,
    resourceId: run.workflowTemplateId,
    status: run.status,
  }));
}

function workflowIdFromRoute(route: string) {
  const match = route.match(
    /^\/workflows\/(?!new(?:\/|$)|runs(?:\/|$))([^/]+)/,
  );
  return match?.[1] ? decodePart(match[1]) : null;
}

function decodePart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function statusClass(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "success") {
    return "bg-success";
  }
  if (normalized === "failed" || normalized === "cancelled") {
    return "bg-destructive";
  }
  if (normalized === "running" || normalized === "queued") {
    return "bg-warning";
  }
  return "";
}

function relativeTime(value?: string | null) {
  const timestamp = timeValue(value);
  if (!timestamp) {
    return "-";
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
