import { useWorkflowRunPage } from "./workflow-queries";
import { WorkflowRunPagination } from "./workflow-run-pagination";
import { Skeleton } from "@/components/data-page";
import { useState } from "react";
import {
  FilterBar,
  FilterSelect,
  ResultCounter,
  SearchInput,
} from "@/components/data-page";
import { WorkflowRunsPanel } from "./workflow-runs-panel";
import { DateText } from "./workflow-shared-ui";
import type { WorkflowRun } from "./workflow-graph-types";

const statusOptions: Array<[string, string]> = [
  ["all", "All statuses"],
  ["queued", "Queued"],
  ["running", "Running"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
  ["cancel_requested", "Cancel requested"],
];

export function WorkflowExecutions({ workflowId }: { workflowId: string }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const page = useWorkflowRunPage({
    workflowTemplateId: workflowId,
    search,
    status: statusFilter,
  });
  const filteredRuns = page.data?.runs ?? [];
  const totalCount = page.data?.totalCount ?? 0;
  const latestRun = filteredRuns[0] ?? null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-[min(1080px,calc(100%-32px))] gap-4 py-6">
        <WorkflowRunFilters
          latestRun={latestRun}
          search={search}
          statusFilter={statusFilter}
          totalCount={totalCount}
          visibleCount={filteredRuns.length}
          onSearchChange={setSearch}
          onStatusFilterChange={setStatusFilter}
        />
        {page.isPending ? (
          <Skeleton className="h-56 w-full" />
        ) : page.error ? (
          <p role="alert" className="text-destructive">
            {String(page.error)}
          </p>
        ) : (
          <WorkflowRunsPanel
            runs={filteredRuns}
            totalCount={totalCount}
            templateId={workflowId}
          />
        )}
        <WorkflowRunPagination
          page={page.page}
          previous={page.previous}
          next={page.next}
          pending={page.isPending}
        />
      </div>
    </div>
  );
}

function WorkflowRunFilters({
  latestRun,
  search,
  statusFilter,
  totalCount,
  visibleCount,
  onSearchChange,
  onStatusFilterChange,
}: {
  latestRun: WorkflowRun | null;
  search: string;
  statusFilter: string;
  totalCount: number;
  visibleCount: number;
  onSearchChange(value: string): void;
  onStatusFilterChange(value: string): void;
}) {
  return (
    <FilterBar>
      <SearchInput
        placeholder="Search runs..."
        value={search}
        onChange={onSearchChange}
      />
      <FilterSelect
        label="Status"
        options={statusOptions}
        value={statusFilter}
        onChange={onStatusFilterChange}
      />
      <div className="flex h-10 items-center gap-2 rounded-control border bg-background px-3 text-sm max-lg:hidden">
        <span className="text-muted-foreground">Latest</span>
        <span className="font-medium">
          {latestRun ? <DateText value={latestRun.createdAt} /> : "-"}
        </span>
      </div>
      <ResultCounter totalCount={totalCount} visibleCount={visibleCount} />
    </FilterBar>
  );
}
