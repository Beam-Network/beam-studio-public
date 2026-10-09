import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  Activity,
  Ban,
  ChevronDown,
  Circle,
  RotateCcw,
  Search,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Skeleton } from "@/components/data-page";
import { Button } from "@/components/ui/button";
import { apiSend } from "@/lib/api-client";
import { cn } from "@/lib/utils";

import { useWorkflowRunPage } from "@/features/workflows/workflow-queries";
import { WorkflowRunPagination } from "@/features/workflows/workflow-run-pagination";

type RunsView = "all" | "queue" | "dead-letter";

type RunRecord = {
  id?: string;
  runId?: string;
  workflowName?: string | null;
  transferName?: string | null;
  workflowTemplateId?: string | null;
  status?: string | null;
  trigger?: string | null;
  queuedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  error?: string | null;
};

type RunAction = {
  icon: typeof Ban;
  label: string;
  path: (row: RunRecord) => string;
};

const viewOptions: Array<[RunsView, string]> = [
  ["all", "All runs"],
  ["queue", "Queue"],
  ["dead-letter", "Dead letter"],
];

const statusOptions = [
  ["all", "All statuses"],
  ["queued", "Queued"],
  ["running", "Running"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
  ["cancel_requested", "Cancel requested"],
] as const;

export const Route: any = createFileRoute("/runs")({
  component: RunsRoute,
});

function RunsRoute() {
  const location = useLocation();
  if (location.pathname !== "/runs") {
    return <Outlet />;
  }

  return <RunsPage />;
}

function RunsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const searchParams = new URLSearchParams(location.searchStr);
  const requestedView = runView(searchParams.get("view"));
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [view, setView] = useState<RunsView>(requestedView);
  const runPage = useWorkflowRunPage({ status: statusFilter, search, view });
  const { data, isPending, error } = runPage;
  const rows = data?.runs ?? [];
  const mutation = useMutation({
    mutationFn: (action: { path: string }) => apiSend("POST", action.path),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/studio/workflow-runs"] }),
  });

  useEffect(() => {
    setView(requestedView);
  }, [requestedView]);

  function updateView(nextView: RunsView) {
    setView(nextView);
    navigate({
      search: (nextView === "all" ? {} : { view: nextView }) as never,
      to: "/runs",
    });
  }

  return (
    <AppShell contentClassName="px-3 py-4">
      <div className="grid gap-3">
        <RunsFilters
          search={search}
          statusFilter={statusFilter}
          totalCount={data?.totalCount ?? 0}
          view={view}
          visibleCount={rows.length}
          onSearchChange={setSearch}
          onStatusFilterChange={setStatusFilter}
          onViewChange={updateView}
        />
        <RunsList
          actionPending={mutation.isPending}
          error={error}
          isPending={isPending}
          rows={rows}
          onAction={(path) => mutation.mutate({ path })}
        />
        <WorkflowRunPagination
          page={runPage.page}
          previous={runPage.previous}
          next={runPage.next}
          pending={runPage.isPending}
        />
        {mutation.error ? (
          <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {String(mutation.error)}
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

function RunsFilters({
  search,
  statusFilter,
  totalCount,
  view,
  visibleCount,
  onSearchChange,
  onStatusFilterChange,
  onViewChange,
}: {
  search: string;
  statusFilter: string;
  totalCount: number;
  view: RunsView;
  visibleCount: number;
  onSearchChange(value: string): void;
  onStatusFilterChange(value: string): void;
  onViewChange(value: RunsView): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative min-w-64 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          className="h-10 w-full rounded-control border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search runs..."
          value={search}
        />
      </label>
      <FilterSelect
        label="View"
        options={viewOptions}
        value={view}
        onChange={(value) => onViewChange(runView(value))}
      />
      <FilterSelect
        label="Status"
        options={statusOptions}
        value={statusFilter}
        onChange={onStatusFilterChange}
      />
      <div className="flex h-10 items-center gap-2 rounded-control border bg-background px-3 text-sm">
        <span className="text-muted-foreground">Showing</span>
        <span className="font-medium">
          {visibleCount}/{totalCount}
        </span>
      </div>
    </div>
  );
}

function RunsList({
  actionPending,
  error,
  isPending,
  rows,
  onAction,
}: {
  actionPending: boolean;
  error: unknown;
  isPending: boolean;
  rows: RunRecord[];
  onAction(path: string): void;
}) {
  if (error) {
    return (
      <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {String(error)}
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="overflow-hidden rounded-control border bg-card">
        <div className="divide-y">
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              className="flex min-h-14 items-center gap-4 px-3 py-3"
              key={index}
            >
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3.5 w-44" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-3.5 w-20 max-lg:hidden" />
              <Skeleton className="h-8 w-8 rounded-control" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <EmptyState
        icon={Activity}
        title="No runs yet"
        description="Workflow executions will appear here once they start."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-control border bg-card">
      <div className="divide-y">
        {rows.map((row, index) => (
          <RunRow
            actionPending={actionPending}
            key={row.runId ?? row.id ?? index}
            row={row}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

function RunRow({
  actionPending,
  row,
  onAction,
}: {
  actionPending: boolean;
  row: RunRecord;
  onAction(path: string): void;
}) {
  const id = textValue(row.runId) || textValue(row.id);
  const title =
    textValue(row.transferName) ||
    textValue(row.workflowName) ||
    "Untitled transfer";
  const status = textValue(row.status) || "unknown";
  const startedAt = textValue(row.startedAt || row.queuedAt || row.createdAt);
  const completedAt = textValue(row.completedAt);
  const actions = actionsForRun(row);

  return (
    <div className="relative grid min-h-14 grid-cols-[minmax(220px,1fr)_140px_110px_150px_150px_88px] items-center gap-4 px-3 py-3 text-sm transition-colors hover:bg-secondary/60 max-xl:grid-cols-[minmax(220px,1fr)_140px_110px_150px_88px] max-lg:grid-cols-[minmax(0,1fr)_120px_72px]">
      <Link
        aria-label={`Open ${title}`}
        className="absolute inset-0 z-0 rounded-badge outline-none focus-visible:ring-2 focus-visible:ring-ring"
        to={`/workflows/runs/${id}` as never}
      />
      <div className="pointer-events-none z-10 min-w-0">
        <div className="truncate font-medium">{title}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {id || "No run id"}
        </div>
      </div>
      <div className="pointer-events-none z-10 min-w-0">
        <StatusCell status={status} />
      </div>
      <div className="pointer-events-none z-10 truncate text-muted-foreground max-lg:hidden">
        {titleCase(textValue(row.trigger) || "manual")}
      </div>
      <div className="pointer-events-none z-10 truncate text-muted-foreground max-xl:hidden">
        {formatDate(startedAt)}
      </div>
      <div className="pointer-events-none z-10 truncate text-muted-foreground max-lg:hidden">
        {formatDate(completedAt)}
      </div>
      <div className="z-20 flex items-center justify-end gap-2">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <Button
              aria-label={action.label}
              disabled={actionPending}
              key={action.label}
              onClick={() => onAction(action.path(row))}
              size="icon"
              title={action.label}
              type="button"
              variant="secondary"
            >
              <Icon className="h-4 w-4" />
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function actionsForRun(row: RunRecord): RunAction[] {
  const id = textValue(row.runId) || textValue(row.id);
  const status = textValue(row.status).toLowerCase();
  const actions: RunAction[] = [];
  if (["queued", "running", "cancel_requested"].includes(status)) {
    actions.push({
      icon: Ban,
      label: "Cancel",
      path: () => `/studio/workflow-runs/${id}/cancel`,
    });
  }
  if (["failed", "cancelled"].includes(status)) {
    actions.push({
      icon: RotateCcw,
      label: "Retry",
      path: () => `/studio/workflow-runs/${id}/retry`,
    });
  }
  return actions;
}

function FilterSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<readonly [string, string]>;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        className="h-10 min-w-40 appearance-none rounded-control border bg-background px-3 pr-9 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </label>
  );
}

function StatusCell({ status }: { status: string }) {
  const normalizedStatus = status.toLowerCase();
  const success = normalizedStatus === "completed";
  const destructive = ["failed", "cancelled"].includes(normalizedStatus);
  const label = titleCase(normalizedStatus);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Circle
        className={cn(
          "h-2.5 w-2.5 fill-current",
          success
            ? "text-success"
            : destructive
              ? "text-destructive"
              : "text-warning",
        )}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function runView(value: string | null): RunsView {
  return value === "queue" || value === "dead-letter" ? value : "all";
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value?: string | null) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
