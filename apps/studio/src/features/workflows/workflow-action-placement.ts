import type { Edge, Node } from "@xyflow/react";
import { planWorkflowConnection } from "./workflow-connection-planner";
import { isStepNode, isTriggerNode } from "./workflow-graph-model";
import type {
  WorkflowCanvasNodeData,
  WorkflowNodeData,
} from "./workflow-graph-types";

type CanvasPosition = { x: number; y: number };

/** Horizontal distance between a node and the one placed after it. */
const NEXT_NODE_OFFSET_X = 340;

/**
 * Where a new node goes when nobody chose a spot: after the right-most node,
 * on its row, so it lands next to what is already on screen rather than on a
 * grid position the viewport may not show.
 */
export function nextNodePosition(
  nodes: Node<WorkflowCanvasNodeData>[],
): CanvasPosition | null {
  const rightMost = nodes.reduce<Node<WorkflowCanvasNodeData> | null>(
    (current, node) =>
      !current || node.position.x > current.position.x ? node : current,
    null,
  );
  return rightMost
    ? {
        x: rightMost.position.x + NEXT_NODE_OFFSET_X,
        y: rightMost.position.y,
      }
    : null;
}

/**
 * Connects a workflow's first action to its only trigger.
 *
 * A first action left unconnected runs from nothing and the graph shows an
 * issue the customer did not cause. With several triggers, or once other
 * steps exist, where the action belongs is the customer's decision.
 */
export function firstActionTriggerConnection(input: {
  nodes: Node<WorkflowCanvasNodeData>[];
  edges: Edge[];
  action: Node<WorkflowNodeData>;
}) {
  const triggers = input.nodes.filter(isTriggerNode);
  const trigger = triggers.length === 1 ? triggers[0] : undefined;
  if (!trigger || input.nodes.some(isStepNode)) return null;
  const plan = planWorkflowConnection({
    connection: {
      source: trigger.id,
      target: input.action.id,
      sourceHandle: null,
      targetHandle: null,
    },
    nodes: [...input.nodes, input.action],
    edges: input.edges,
  });
  return plan.accepted ? plan : null;
}
