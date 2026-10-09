import { useEffect } from "react";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Split } from "lucide-react";
import {
  DECISION_FALSE_PORT,
  DECISION_TRUE_PORT,
  SWITCH_DEFAULT_PORT,
  switchCasePort,
} from "@beam-studio/core/workflows/graph-semantics";
import {
  workflowNodeCardClassName,
  WorkflowNodeHeader,
  WorkflowNodeStatus,
} from "./workflow-node-card";
import {
  WORKFLOW_BRANCH_ROW_HEIGHT,
  WORKFLOW_NODE_HANDLE_Y,
  workflowBranchHandleY,
} from "./workflow-node-geometry";
import { cn } from "@/lib/utils";
import type { WorkflowDecisionNodeData } from "./workflow-graph-types";

/**
 * The two outputs are labelled on the node itself: which branch an edge leaves
 * by is the whole point of the node, so it must be readable without opening
 * anything.
 */
export function WorkflowDecisionNode({
  id,
  data,
  selected,
}: NodeProps<Node<WorkflowDecisionNodeData, "workflowDecision">>) {
  const branches =
    data.kind === "switch"
      ? [
          ...data.cases.map((entry) => ({
            id: switchCasePort(entry.id),
            label: entry.name,
            positive: true,
          })),
          { id: SWITCH_DEFAULT_PORT, label: "Default", positive: false },
        ]
      : [
          { id: DECISION_TRUE_PORT, label: "True", positive: true },
          { id: DECISION_FALSE_PORT, label: "False", positive: false },
        ];
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignature = JSON.stringify(branches.map((branch) => branch.id));
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, portSignature, updateNodeInternals]);

  return (
    <div
      aria-label={`${data.name}. Double-click to configure.`}
      className="group relative w-[330px]"
      role="button"
      title={`${data.name} — double-click to configure`}
    >
      <Handle
        id="workflow-in"
        className={handleClass(selected)}
        position={Position.Left}
        style={{ top: WORKFLOW_NODE_HANDLE_Y }}
        type="target"
      />
      {branches.map((branch, index) => (
        <Handle
          key={branch.id}
          id={branch.id}
          className={handleClass(selected)}
          position={Position.Right}
          style={{ top: workflowBranchHandleY(index) }}
          type="source"
        />
      ))}
      <div className={workflowNodeCardClassName(data, selected)}>
        <WorkflowNodeHeader
          displayName={
            data.name || (data.kind === "switch" ? "Switch" : "Decision")
          }
          summary={joinLabel(data.joinMode)}
          icon={<Split aria-hidden="true" size={18} strokeWidth={1.8} />}
        />
        <div className="border-t">
          {branches.map((branch) => (
            <div
              key={branch.id}
              className="flex items-center justify-end px-3.5"
              style={{ height: WORKFLOW_BRANCH_ROW_HEIGHT }}
            >
              <span
                className={cn(
                  "truncate text-[11px] font-medium leading-4",
                  branch.positive ? "text-success" : "text-muted-foreground",
                )}
                title={branch.label}
              >
                {branch.label}
              </span>
            </div>
          ))}
        </div>
        <WorkflowNodeStatus data={data} />
        {data.handleFailure ? (
          <div className="border-t border-border/70 px-3.5 py-2 text-[10px] font-medium text-muted-foreground">
            Failure marked handled
          </div>
        ) : null}
      </div>
    </div>
  );
}

function joinLabel(joinMode: WorkflowDecisionNodeData["joinMode"]) {
  return joinMode === "all"
    ? "Continues when every input succeeded"
    : "Continues when any input succeeded";
}

function handleClass(selected: boolean) {
  return cn(
    "!size-3 !rounded-full !border-2 !border-card !bg-muted-foreground/70 !opacity-0 !transition-[opacity,background-color] group-hover:!bg-primary group-hover:!opacity-100",
    selected && "!bg-primary !opacity-100",
  );
}
