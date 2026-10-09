import { WORKFLOW_NODE_HANDLE_Y } from "./workflow-node-geometry";
import { ArrowRight, Layers3, Repeat2 } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  workflowNodeCardClassName,
  WorkflowNodeHeader,
  WorkflowNodeStatus,
} from "./workflow-node-card";
import { cn } from "@/lib/utils";
import type { WorkflowControlNodeData } from "./workflow-graph-types";

export function WorkflowControlNode({
  data,
  selected,
}: NodeProps<Node<WorkflowControlNodeData, "workflowControl">>) {
  const Icon =
    data.role === "loop"
      ? Repeat2
      : data.role === "fan-out"
        ? Layers3
        : ArrowRight;
  const title =
    data.role === "loop"
      ? loopTitle(data.control)
      : data.role === "fan-out"
        ? "For each item"
        : "Continue after all items";
  const subtitle =
    data.role === "fan-in"
      ? "Collect results in their original order"
      : controlDescription(data);
  const compact = data.role === "fan-in";

  return (
    <div
      aria-label={`${title}. ${subtitle}. Double-click to configure.`}
      className={cn("group relative", compact ? "w-[248px]" : "w-[280px]")}
      role="button"
      title={`${title} — double-click to configure`}
    >
      {data.role !== "fan-in" ? (
        <Handle
          id={
            data.definition.ports.find((port) => port.direction === "input")?.id
          }
          className={handleClass(selected)}
          position={Position.Left}
          style={{ top: WORKFLOW_NODE_HANDLE_Y }}
          type="target"
        />
      ) : null}
      {data.role !== "fan-out" ? (
        <Handle
          id={
            data.definition.ports.find((port) => port.direction === "output")
              ?.id
          }
          className={handleClass(selected)}
          position={Position.Right}
          style={{ top: WORKFLOW_NODE_HANDLE_Y }}
          type="source"
        />
      ) : null}
      <div className={workflowNodeCardClassName(data, selected)}>
        <WorkflowNodeHeader
          displayName={title}
          summary={subtitle}
          icon={<Icon aria-hidden="true" size={18} strokeWidth={1.8} />}
        />
        <WorkflowNodeStatus data={data} />
      </div>
    </div>
  );
}

function loopTitle(control: WorkflowControlNodeData["control"]) {
  if (control.kind !== "loop") return "Repeat";
  return typeof control.iterations === "number"
    ? `Repeat ${control.iterations} ${control.iterations === 1 ? "time" : "times"}`
    : "Repeat a number of times";
}

function controlDescription(data: WorkflowControlNodeData) {
  const actionCount = data.control.body.stepIds.length;
  const actions = `${actionCount} ${actionCount === 1 ? "action" : "actions"}`;
  if (data.control.kind === "fan-out") {
    return `${actions} · up to ${data.control.concurrency ?? 10} at once`;
  }
  return `${actions} · one iteration at a time`;
}

function handleClass(selected: boolean) {
  return cn(
    "!size-3 !rounded-full !border-2 !border-card !bg-muted-foreground/70 !opacity-0 !transition-[opacity,background-color] group-hover:!bg-primary group-hover:!opacity-100",
    selected && "!bg-primary !opacity-100",
  );
}
