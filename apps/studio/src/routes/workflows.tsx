import { workflowListOptions } from "@/features/workflows/workflow-queries";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
} from "@tanstack/react-router";
import {
  Circle,
  GitBranch,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import {
  EmptyState,
  FilterBar,
  FilterSelect,
  ResultCounter,
  SearchInput,
  Skeleton,
} from "@/components/data-page";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type WorkflowRecord = {
  id?: string;
  name?: string;
  description?: string | null;
  enabled?: boolean;
  stepCount?: number;
  runCount?: number;
  lastRunStatus?: string | null;
  updatedAt?: string | null;
};

type WorkflowsPayload = {
  workflows?: WorkflowRecord[];
};

export const Route: any = createFileRoute("/workflows")({
  component: WorkflowsRoute,
});

function WorkflowsRoute() {
  const location = useLocation();
  if (location.pathname !== "/workflows") {
    return <Outlet />;
  }

  return <WorkflowListPage />;
}

function WorkflowListPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [runFilter, setRunFilter] = useState("all");
  const { data, isPending, error } = useQuery({
    ...workflowListOptions(),
  });
  const workflows = data?.workflows ?? [];
  const filteredWorkflows = useMemo(
    () =>
      workflows.filter((workflow) => {
        const haystack = [
          workflow.name,
          workflow.description,
          workflow.lastRunStatus,
          workflow.id,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const matchesSearch = haystack.includes(search.trim().toLowerCase());
        const matchesStatus =
          statusFilter === "all" ||
          (statusFilter === "enabled" && workflow.enabled) ||
          (statusFilter === "disabled" && !workflow.enabled);
        const lastRun = String(workflow.lastRunStatus ?? "never").toLowerCase();
        const matchesRun = runFilter === "all" || lastRun === runFilter;

        return matchesSearch && matchesStatus && matchesRun;
      }),
    [runFilter, search, statusFilter, workflows],
  );

  return (
    <AppShell
      contentClassName="px-3 py-4"
      headerActions={
        <Button asChild size="sm" variant="default">
          <Link to="/workflows/new">
            <Plus className="h-4 w-4" />
            Create workflow
          </Link>
        </Button>
      }
    >
      <div className="grid gap-3">
        <WorkflowFilters
          runFilter={runFilter}
          search={search}
          statusFilter={statusFilter}
          totalCount={workflows.length}
          visibleCount={filteredWorkflows.length}
          onRunFilterChange={setRunFilter}
          onSearchChange={setSearch}
          onStatusFilterChange={setStatusFilter}
        />
        <WorkflowList
          error={error}
          isPending={isPending}
          workflows={filteredWorkflows}
        />
      </div>
    </AppShell>
  );
}

function WorkflowFilters({
  runFilter,
  search,
  statusFilter,
  totalCount,
  visibleCount,
  onRunFilterChange,
  onSearchChange,
  onStatusFilterChange,
}: {
  runFilter: string;
  search: string;
  statusFilter: string;
  totalCount: number;
  visibleCount: number;
  onRunFilterChange(value: string): void;
  onSearchChange(value: string): void;
  onStatusFilterChange(value: string): void;
}) {
  return (
    <FilterBar>
      <SearchInput
        placeholder="All Workflows..."
        value={search}
        onChange={onSearchChange}
      />
      <FilterSelect
        label="Status"
        value={statusFilter}
        onChange={onStatusFilterChange}
        options={[
          ["all", "All Statuses"],
          ["enabled", "Enabled"],
          ["disabled", "Disabled"],
        ]}
      />
      <FilterSelect
        label="Last run"
        value={runFilter}
        onChange={onRunFilterChange}
        options={[
          ["all", "All Runs"],
          ["completed", "Completed"],
          ["failed", "Failed"],
          ["running", "Running"],
          ["queued", "Queued"],
          ["never", "Never run"],
        ]}
      />
      <ResultCounter totalCount={totalCount} visibleCount={visibleCount} />
    </FilterBar>
  );
}

function WorkflowList({
  error,
  isPending,
  workflows,
}: {
  error: unknown;
  isPending: boolean;
  workflows: WorkflowRecord[];
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
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-3.5 w-20 max-lg:hidden" />
              <Skeleton className="h-5 w-16 rounded-full max-xl:hidden" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!workflows.length) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No workflows yet"
        description="Create your first workflow to automate transfers and actions."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-control border bg-card">
      <div className="divide-y">
        {workflows.map((workflow) => (
          <WorkflowRow key={workflow.id ?? workflow.name} workflow={workflow} />
        ))}
      </div>
    </div>
  );
}

function WorkflowRow({ workflow }: { workflow: WorkflowRecord }) {
  const id = workflow.id ?? "";
  const name = workflow.name?.trim() || "Untitled workflow";
  const description = workflow.description?.trim();
  const lastRunStatus = workflow.lastRunStatus ?? "never";

  return (
    <Link
      className="grid min-h-14 grid-cols-[minmax(220px,1fr)_120px_100px_100px_140px_100px_32px] items-center gap-4 px-3 py-3 text-sm transition-colors hover:bg-secondary/60 max-xl:grid-cols-[minmax(220px,1fr)_120px_100px_120px_32px] max-lg:grid-cols-[minmax(0,1fr)_100px_32px]"
      to={`/workflows/${id}/editor` as never}
    >
      <div className="min-w-0">
        <div className="truncate font-medium">{name}</div>
        {description ? (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      <StatusCell status={lastRunStatus} />
      <span className="truncate font-mono text-xs text-muted-foreground max-lg:hidden">
        {workflow.stepCount ?? 0} steps
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground max-xl:hidden">
        {workflow.runCount ?? 0} runs
      </span>
      <span className="truncate text-muted-foreground max-lg:hidden">
        {formatDate(workflow.updatedAt)}
      </span>
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 text-center text-xs max-xl:hidden",
          workflow.enabled
            ? "border-success/30 text-success"
            : "border-muted-foreground/20 text-muted-foreground",
        )}
      >
        {workflow.enabled ? "Enabled" : "Disabled"}
      </span>
      <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}

function StatusCell({ status }: { status: string }) {
  const normalizedStatus = status.toLowerCase();
  const ready = normalizedStatus === "completed";
  const idle = normalizedStatus === "never";
  const label = idle ? "Never run" : titleCase(normalizedStatus);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Circle
        className={cn(
          "h-2.5 w-2.5 fill-current",
          ready
            ? "text-success"
            : idle
              ? "text-muted-foreground"
              : "text-warning",
        )}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function titleCase(value: string) {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
  }).format(date);
}
