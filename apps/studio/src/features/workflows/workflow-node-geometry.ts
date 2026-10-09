import {
  DECISION_FALSE_PORT,
  DECISION_TRUE_PORT,
  SWITCH_DEFAULT_PORT,
  switchCasePort,
} from "@beam-studio/core/workflows/graph-semantics";
import { WORKFLOW_GRID_SIZE } from "./workflow-graph-constants";

// Coordinates are measured from the OUTSIDE of a node, including its border.
export const WORKFLOW_NODE_HEADER_HEIGHT = WORKFLOW_GRID_SIZE * 3;
export const WORKFLOW_NODE_BORDER_WIDTH = 1;
export const WORKFLOW_NODE_HANDLE_Y = WORKFLOW_NODE_HEADER_HEIGHT / 2;
export const WORKFLOW_BRANCH_ROW_HEIGHT = WORKFLOW_GRID_SIZE;

export function workflowBranchHandleY(index: number) {
  return (
    WORKFLOW_NODE_HEADER_HEIGHT + WORKFLOW_BRANCH_ROW_HEIGHT * (index + 0.5)
  );
}

export function workflowDecisionOutputY(
  data: { kind: "if" | "switch"; cases: { id: string }[] },
  handleId?: string | null,
) {
  const ports =
    data.kind === "switch"
      ? [
          ...data.cases.map((entry) => switchCasePort(entry.id)),
          SWITCH_DEFAULT_PORT,
        ]
      : [DECISION_TRUE_PORT, DECISION_FALSE_PORT];
  const index = handleId ? ports.indexOf(handleId) : -1;
  return index < 0 ? WORKFLOW_NODE_HANDLE_Y : workflowBranchHandleY(index);
}
