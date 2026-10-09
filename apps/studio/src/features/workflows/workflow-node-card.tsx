import type { ReactNode } from "react";
import { CircleAlert, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  WORKFLOW_NODE_HEADER_HEIGHT,
  WORKFLOW_NODE_BORDER_WIDTH,
} from "./workflow-node-geometry";

type WorkflowNodeState = {
  enabled?: boolean;
  required?: boolean;
  issues: string[];
};

export function workflowNodeCardClassName(
  data: WorkflowNodeState,
  selected: boolean,
) {
  return cn(
    "overflow-hidden rounded-surface border border-border bg-card text-card-foreground transition-[border-color,box-shadow,opacity] duration-150",
    "group-hover:border-muted-foreground/50",
    selected &&
      "border-primary ring-2 ring-primary/15 group-hover:border-primary",
    data.enabled === false && "border-dashed opacity-75",
    data.issues.length > 0 &&
      "border-destructive/70 group-hover:border-destructive ring-destructive/15",
  );
}

export function WorkflowNodeHeader({
  displayName,
  summary,
  icon,
}: {
  displayName: string;
  summary: string;
  icon: ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-3 px-3.5 py-2"
      style={{
        height: WORKFLOW_NODE_HEADER_HEIGHT - 2 * WORKFLOW_NODE_BORDER_WIDTH,
      }}
    >
      <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-control bg-muted text-foreground/80 ring-1 ring-inset ring-border/70">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <strong
          className="block truncate text-sm font-semibold leading-5 tracking-tight"
          title={displayName}
        >
          {displayName}
        </strong>
        <p
          className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground"
          title={summary}
        >
          {summary}
        </p>
      </div>
    </div>
  );
}

export function WorkflowNodeStatus({ data }: { data: WorkflowNodeState }) {
  if (!data.issues.length && data.enabled !== false && data.required !== false)
    return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3.5 pb-3 text-[10px] font-medium leading-4">
      {data.enabled === false ? (
        <span className="inline-flex items-center gap-1 rounded-badge bg-muted px-1.5 py-0.5 text-muted-foreground">
          <Pause aria-hidden="true" size={11} />
          Disabled
        </span>
      ) : null}
      {data.issues.length > 0 ? (
        <span
          className="inline-flex min-w-0 items-center gap-1 rounded-badge bg-destructive/10 px-1.5 py-0.5 text-destructive"
          title={data.issues.join("\n")}
        >
          <CircleAlert aria-hidden="true" className="shrink-0" size={11} />
          {data.issues.length === 1
            ? "Needs attention"
            : `${data.issues.length} issues`}
        </span>
      ) : null}
      {data.required === false ? (
        <span
          className="rounded-badge bg-muted px-1.5 py-0.5 text-muted-foreground"
          title="A failure in this action alone does not fail the workflow."
        >
          Optional
        </span>
      ) : null}
    </div>
  );
}
