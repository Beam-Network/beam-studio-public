import type { Connection, Edge, Node } from "@xyflow/react";
import {
  planWorkflowConnection as planSemanticConnection,
  type BindingPatch,
  type WorkflowSemanticEdge,
} from "@beam-studio/core/workflows/graph-semantics";
import {
  applyAutomaticBinding,
  automaticBindingPlan,
} from "./workflow-graph-bindings";
import {
  canvasEdgeFromSemantic,
  isControlNode,
  isStepNode,
  semanticGraphFromCanvas,
  shortId,
} from "./workflow-graph-model";
import type {
  WorkflowCanvasNodeData,
  WorkflowNodeData,
} from "./workflow-graph-types";

export type WorkflowConnectionPlan = {
  accepted: boolean;
  reason?: string;
  visualEdges: Edge[];
  runtimeEdges: WorkflowSemanticEdge[];
  nodePatches: Array<{
    nodeId: string;
    patch: Partial<WorkflowNodeData>;
  }>;
  bindingPatches: BindingPatch[];
};

/** Pure React Flow adapter around the shared connection planner. */
export function planWorkflowConnection(input: {
  connection: Connection;
  nodes: Node<WorkflowCanvasNodeData>[];
  edges: Edge[];
  createId?: (prefix: string) => string;
}): WorkflowConnectionPlan {
  const source = input.nodes.find(
    (node) => node.id === input.connection.source,
  );
  const target = input.nodes.find(
    (node) => node.id === input.connection.target,
  );
  if (
    (source && isControlNode(source) && source.data.role === "fan-out") ||
    (target && isControlNode(target) && target.data.role === "fan-in")
  ) {
    return rejected("Connect through the fan-out body and fan-in exit ports.");
  }
  const semanticGraph = semanticGraphFromCanvas(input.nodes, input.edges);
  const plan = planSemanticConnection({
    connection: {
      source: input.connection.source ?? "",
      target: input.connection.target ?? "",
      sourcePort: input.connection.sourceHandle,
      targetPort: input.connection.targetHandle,
    },
    nodes: semanticGraph.nodes,
    edges: semanticGraph.edges,
    createId: input.createId ?? ((prefix) => `${prefix}_${shortId()}`),
  });
  if (!plan.accepted) {
    return rejected(plan.reason ?? "Connection is incompatible.");
  }
  const visualEdges = [...plan.visualEdges];
  const bindingPatches = [...plan.bindingPatches];
  if (
    !bindingPatches.length &&
    source &&
    target &&
    isStepNode(source) &&
    isStepNode(target)
  ) {
    const direct = automaticBindingPlan(source, target);
    const reverse = direct ? null : automaticBindingPlan(target, source);
    const automatic = direct ?? reverse;
    if (automatic) {
      const bindingSource = reverse ? target : source;
      const bindingTarget = reverse ? source : target;
      const binding = {
        sourceNodeId: bindingSource.id,
        sourceOutput: automatic.outputKey,
        targetNodeId: bindingTarget.id,
        targetInput: automatic.inputKey,
        mode: automatic.mode,
      } as const;
      bindingPatches.push(binding);
      for (const edge of visualEdges) {
        edge.kind =
          source.data.workflowNodeKind === "resource" ||
          target.data.workflowNodeKind === "resource"
            ? "binding"
            : "data";
        edge.binding = binding;
        if (reverse && edge.runtimeEdges[0]) {
          edge.runtimeEdges[0] = {
            ...edge.runtimeEdges[0],
            source: bindingSource.id,
            target: bindingTarget.id,
          };
        }
      }
    }
  }
  const nodePatches = bindingPatches.flatMap((binding) => {
    const bindingTarget = input.nodes.find(
      (node) => node.id === binding.targetNodeId,
    );
    if (!bindingTarget || !isStepNode(bindingTarget)) return [];
    return [
      {
        nodeId: bindingTarget.id,
        patch: {
          inputBindings: applyAutomaticBinding(
            bindingTarget.data.inputBindings,
            {
              inputKey: binding.targetInput,
              outputKey: binding.sourceOutput,
              mode: binding.mode,
            },
            binding.sourceNodeId,
          ),
        },
      },
    ];
  });
  return {
    accepted: true,
    visualEdges: visualEdges.map(canvasEdgeFromSemantic),
    runtimeEdges: plan.runtimeEdges,
    nodePatches,
    bindingPatches,
  };
}

function rejected(reason: string): WorkflowConnectionPlan {
  return {
    accepted: false,
    reason,
    visualEdges: [],
    runtimeEdges: [],
    nodePatches: [],
    bindingPatches: [],
  };
}
