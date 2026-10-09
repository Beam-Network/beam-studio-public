import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ChevronRight, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  durationLabel,
  relativeTimeLabel,
} from "@/features/runs/run-detail-data";
import {
  DateText,
  StatusBadge,
  StatusIcon,
} from "@/features/runs/run-detail-primitives";
import type { WorkflowRun } from "./workflow-graph-types";

import { WorkflowPanel as Panel } from "./workflow-panel";

export function WorkflowRunsPanel({
  runs,
  templateId,
  totalCount = runs.length,
  preview = false,
}: {
  runs: WorkflowRun[];
  templateId: string;
  totalCount?: number;
  preview?: boolean;
}) {
  if (!runs.length) {
    return (
      <EmptyState
        description={
          totalCount
            ? "Adjust the search or status filter to show more runs."
            : "Run the workflow once and its executions will show up here."
        }
        icon={History}
        title={totalCount ? "No matching runs" : "No runs yet"}
      />
    );
  }

  const latest = preview ? runs.slice(0, 10) : runs;

  return (
    <Panel
      action={
        preview ? (
          <Button asChild size="sm" variant="outline">
            <Link to={`/workflows/${templateId}/runs` as never}>
              All runs
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
        ) : undefined
      }
      description={`Showing ${latest.length} of ${totalCount} run${totalCount > 1 ? "s" : ""}`}
      title={preview ? "Latest runs" : "Runs"}
    >
      <div className="overflow-hidden rounded-control border">
        <div className="divide-y">
          {latest.map((run) => (
            <Link
              className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-secondary/60"
              key={run.id}
              to={`/workflows/${templateId}/runs/${run.id}` as never}
            >
              <StatusIcon status={run.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-sm">
                  {run.id}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {run.trigger || run.triggerType || "manual"} ·{" "}
                  {relativeTimeLabel(runDate(run)) || (
                    <DateText value={runDate(run)} />
                  )}
                </span>
              </span>
              <StatusBadge
                className="hidden sm:inline-flex"
                status={run.status}
              />
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {run.startedAt
                  ? durationLabel(run.startedAt, run.completedAt)
                  : "-"}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function runDate(run: WorkflowRun) {
  return run.startedAt ?? run.createdAt ?? run.completedAt ?? null;
}
