import { actionTargetPlacement } from "@beam-studio/shared";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { latestActionPackagesByName } from "@beam-studio/core/workflows/action-versions";
import type { AssistantWorkflowPatchOperation } from "@beam-studio/shared";
import { isJsonObject } from "./workflow-config-schema";
import { autoLayoutGraph } from "./workflow-graph-operations";
import {
  OBJECT_STORAGE_ENDPOINT_ACTION,
  WORKFLOW_INPUT_HANDLE,
  WORKFLOW_OUTPUT_HANDLE,
} from "./workflow-graph-constants";
import {
  DECISION_FALSE_PORT,
  DECISION_TRUE_PORT,
} from "@beam-studio/core/workflows/graph-semantics";
import {
  createDecisionNode,
  createNode,
  createTrigger,
  decorateEdge,
  decorateTriggerEdge,
  isDecisionNode,
  isStepNode,
  isTriggerNode,
  shortId,
} from "./workflow-graph-model";
import { validateGraph } from "./workflow-graph-validation";
import type {
  ActionPackage,
  JsonObject,
  WorkflowCanvasNodeData,
} from "./workflow-graph-types";

type GraphSnapshot = {
  edges: Edge[];
  nodes: Node<WorkflowCanvasNodeData>[];
};

type WorkflowMetadataPatch = {
  description?: string;
  enabled?: boolean;
  name?: string;
};

export function applyAssistantWorkflowPatch({
  actions,
  edges,
  nodes,
  patch,
}: {
  actions: ActionPackage[];
  edges: Edge[];
  nodes: Node<WorkflowCanvasNodeData>[];
  patch: AssistantWorkflowPatchOperation[];
}) {
  const errors: string[] = [];
  const actionsByName = latestActionPackagesByName(actions);
  const refToNodeId = new Map<string, string>();
  const nextNodes = nodes.map(cloneNode);
  const nextEdges = edges.map(cloneEdge);
  const metadata: WorkflowMetadataPatch = {};

  for (const node of nextNodes) {
    refToNodeId.set(node.id, node.id);
  }

  for (const operation of patch) {
    if (operation.op === "add_trigger") {
      const node = createTrigger(
        operation.triggerType,
        nextNodes.filter(isTriggerNode).length,
      );
      nextNodes.push({
        ...node,
        data: {
          ...node.data,
          name: operation.name?.trim() || node.data.name,
          config: {
            ...node.data.config,
            ...(operation.config ?? {}),
          },
        },
      });
      refToNodeId.set(operation.ref, node.id);
      continue;
    }

    if (operation.op === "add_decision") {
      const node = createDecisionNode(nextNodes.filter(isDecisionNode).length);
      nextNodes.push({
        ...node,
        data: {
          ...node.data,
          name: operation.name?.trim() || node.data.name,
          joinMode: operation.joinMode ?? node.data.joinMode,
          handleFailure: operation.handleFailure ?? node.data.handleFailure,
          predicate: operation.predicate ?? null,
        },
      });
      refToNodeId.set(operation.ref, node.id);
      continue;
    }

    if (operation.op === "add_step") {
      const action = actionsByName.get(operation.actionPackageName);
      if (!action) {
        errors.push(`Unknown action ${operation.actionPackageName}.`);
        continue;
      }
      const node = createNode(
        action,
        nextNodes.filter(isStepNode).length,
        action.name === OBJECT_STORAGE_ENDPOINT_ACTION ? "endpoint" : "action",
      );
      nextNodes.push({
        ...node,
        data: {
          ...node.data,
          config: {
            ...node.data.config,
            ...(operation.config ?? {}),
          },
        },
      });
      refToNodeId.set(operation.ref, node.id);
    }
  }

  for (const operation of patch) {
    if (operation.op === "connect") {
      const fromId = resolveRef(operation.fromRef, refToNodeId);
      const toId = resolveRef(operation.toRef, refToNodeId);
      const source = nextNodes.find((node) => node.id === fromId);
      const target = nextNodes.find((node) => node.id === toId);
      if (!source || !target) {
        errors.push(
          `Cannot connect ${operation.fromRef} to ${operation.toRef}: missing ref.`,
        );
        continue;
      }
      if (isDecisionNode(source) || isDecisionNode(target)) {
        const leavingDecision = isDecisionNode(source);
        nextEdges.push(
          decorateEdge({
            id: `de_${source.id}_${target.id}_${shortId()}`,
            source: source.id,
            target: target.id,
            type: "smoothstep",
            sourceHandle: leavingDecision
              ? operation.branch === "false"
                ? DECISION_FALSE_PORT
                : DECISION_TRUE_PORT
              : WORKFLOW_OUTPUT_HANDLE,
            targetHandle: WORKFLOW_INPUT_HANDLE,
            data: {
              edgeKind: "flow",
              condition: null,
              runtimeSource: source.id,
              runtimeTarget: target.id,
              runtimeSourceKind: "step",
              runtimeTargetKind: "step",
              decisionBranch: leavingDecision
                ? (operation.branch ?? "true")
                : null,
              isDecisionEdge: true,
            },
            markerEnd: { type: MarkerType.ArrowClosed },
          }),
        );
        continue;
      }
      if (isTriggerNode(source) && isStepNode(target)) {
        nextEdges.push(
          decorateTriggerEdge({
            id: `wfte_${source.id}_${target.id}_${shortId()}`,
            source: source.id,
            target: target.id,
            type: "smoothstep",
            data: {
              edgeKind: "trigger",
              condition: operation.condition ?? null,
              runtimeSource: source.id,
              runtimeTarget: target.id,
              runtimeSourceKind: "trigger",
              runtimeTargetKind: "step",
            },
            markerEnd: { type: MarkerType.ArrowClosed },
          }),
        );
        continue;
      }
      if (isStepNode(source) && isStepNode(target)) {
        nextEdges.push(
          decorateEdge({
            id: `wfe_${source.id}_${target.id}_${shortId()}`,
            source: source.id,
            target: target.id,
            type: "smoothstep",
            data: {
              edgeKind: "flow",
              condition: operation.condition ?? null,
              runtimeSource: source.id,
              runtimeTarget: target.id,
              runtimeSourceKind: "step",
              runtimeTargetKind: "step",
            },
            markerEnd: { type: MarkerType.ArrowClosed },
          }),
        );
        continue;
      }
      errors.push(
        `Cannot connect ${operation.fromRef} to ${operation.toRef}: incompatible node kinds.`,
      );
    }

    if (operation.op === "set_binding") {
      const stepId = resolveRef(operation.stepRef, refToNodeId);
      const expression = resolveExpression(operation.expression, refToNodeId);
      patchStepNode(nextNodes, stepId, (node) => ({
        ...node,
        data: {
          ...node.data,
          inputBindings: {
            ...node.data.inputBindings,
            [operation.inputKey]: inputExpectsArray(node, operation.inputKey)
              ? [expression]
              : expression,
          },
        },
      })) ||
        errors.push(`Cannot set binding: unknown step ${operation.stepRef}.`);
    }

    if (operation.op === "configure_step") {
      const stepId = resolveRef(operation.stepRef, refToNodeId);
      patchStepNode(nextNodes, stepId, (node) => ({
        ...node,
        data: {
          ...node.data,
          config: {
            ...node.data.config,
            ...operation.config,
          },
        },
      })) ||
        errors.push(
          `Cannot configure step: unknown step ${operation.stepRef}.`,
        );
    }

    if (operation.op === "rename_step") {
      const stepId = resolveRef(operation.stepRef, refToNodeId);
      patchStepNode(nextNodes, stepId, (node) => ({
        ...node,
        data: {
          ...node.data,
          config: {
            ...node.data.config,
            name: operation.name,
          },
        },
      })) ||
        errors.push(`Cannot rename step: unknown step ${operation.stepRef}.`);
    }

    if (operation.op === "update_step") {
      const stepId = resolveRef(operation.stepRef, refToNodeId);
      const nextAction = operation.actionPackageName
        ? actionsByName.get(operation.actionPackageName)
        : undefined;
      if (operation.actionPackageName && !nextAction) {
        errors.push(`Unknown action ${operation.actionPackageName}.`);
        continue;
      }
      patchStepNode(nextNodes, stepId, (node) => ({
        ...node,
        data: {
          ...node.data,
          ...(nextAction
            ? {
                action: nextAction,
                actionPackageName: nextAction.name,
                actionVersionRange:
                  operation.actionVersionRange ?? `^${nextAction.version}`,
                manifest: nextAction.manifest,
              }
            : operation.actionVersionRange
              ? { actionVersionRange: operation.actionVersionRange }
              : {}),
          ...(operation.enabled === undefined
            ? {}
            : { enabled: operation.enabled }),
          config: operation.config
            ? { ...node.data.config, ...operation.config }
            : node.data.config,
          inputBindings: operation.inputBindings
            ? { ...node.data.inputBindings, ...operation.inputBindings }
            : node.data.inputBindings,
        },
      })) ||
        errors.push(`Cannot update step: unknown step ${operation.stepRef}.`);
    }

    if (operation.op === "remove_step") {
      const stepId = resolveRef(operation.stepRef, refToNodeId);
      const index = nextNodes.findIndex(
        (node) => node.id === stepId && isStepNode(node),
      );
      if (index < 0) {
        errors.push(`Cannot remove step: unknown step ${operation.stepRef}.`);
        continue;
      }
      nextNodes.splice(index, 1);
      removeEdges(
        nextEdges,
        (edge) => edge.source === stepId || edge.target === stepId,
      );
    }

    if (operation.op === "disconnect") {
      const fromId = resolveRef(operation.fromRef, refToNodeId);
      const toId = resolveRef(operation.toRef, refToNodeId);
      const removed = removeEdges(
        nextEdges,
        (edge) => edge.source === fromId && edge.target === toId,
      );
      if (!removed) {
        errors.push(
          `Cannot disconnect ${operation.fromRef} from ${operation.toRef}: edge not found.`,
        );
      }
    }

    if (operation.op === "remove_edge") {
      const edgeId = resolveRef(operation.edgeRef, refToNodeId);
      if (!removeEdges(nextEdges, (edge) => edge.id === edgeId)) {
        errors.push(`Cannot remove edge: unknown edge ${operation.edgeRef}.`);
      }
    }

    if (operation.op === "update_edge") {
      const edgeId = resolveRef(operation.edgeRef, refToNodeId);
      const index = nextEdges.findIndex((edge) => edge.id === edgeId);
      const edge = nextEdges[index];
      if (!edge) {
        errors.push(`Cannot update edge: unknown edge ${operation.edgeRef}.`);
        continue;
      }
      nextEdges[index] = {
        ...edge,
        data: {
          ...edge.data,
          condition: cloneJson(operation.condition),
        },
      };
    }

    if (operation.op === "update_trigger") {
      const triggerId = resolveRef(operation.triggerRef, refToNodeId);
      const index = nextNodes.findIndex((node) => node.id === triggerId);
      const node = nextNodes[index];
      if (!node || !isTriggerNode(node)) {
        errors.push(
          `Cannot update trigger: unknown trigger ${operation.triggerRef}.`,
        );
        continue;
      }
      nextNodes[index] = {
        ...node,
        data: {
          ...node.data,
          ...(operation.triggerType === undefined
            ? {}
            : { type: operation.triggerType }),
          ...(operation.name === undefined ? {} : { name: operation.name }),
          ...(operation.enabled === undefined
            ? {}
            : { enabled: operation.enabled }),
          config: operation.config
            ? { ...node.data.config, ...operation.config }
            : node.data.config,
        },
      };
    }

    if (operation.op === "remove_trigger") {
      const triggerId = resolveRef(operation.triggerRef, refToNodeId);
      const index = nextNodes.findIndex(
        (node) => node.id === triggerId && isTriggerNode(node),
      );
      if (index < 0) {
        errors.push(
          `Cannot remove trigger: unknown trigger ${operation.triggerRef}.`,
        );
        continue;
      }
      nextNodes.splice(index, 1);
      removeEdges(nextEdges, (edge) => edge.source === triggerId);
    }

    if (operation.op === "set_step_runtime") {
      const stepId = resolveRef(operation.stepRef, refToNodeId);
      patchStepNode(nextNodes, stepId, (node) => ({
        ...node,
        data: {
          ...node.data,
          ...(operation.executionTarget === undefined
            ? {}
            : {
                executionTarget: operation.executionTarget,
                placement: actionTargetPlacement(operation.executionTarget),
                executionLocationId:
                  operation.executionTarget.kind === "remote-transport"
                    ? (operation.executionTarget.executionLocationId ?? null)
                    : null,
              }),
          ...(operation.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: operation.timeoutSeconds }),
          ...(operation.required === undefined
            ? {}
            : { required: operation.required }),
        },
      })) ||
        errors.push(`Cannot set runtime: unknown step ${operation.stepRef}.`);
    }

    if (operation.op === "set_workflow_metadata") {
      if (operation.name !== undefined) {
        metadata.name = operation.name;
      }
      if (operation.description !== undefined) {
        metadata.description = operation.description;
      }
      if (operation.enabled !== undefined) {
        metadata.enabled = operation.enabled;
      }
    }
  }

  const shouldLayout = patch.some((operation) =>
    [
      "connect",
      "disconnect",
      "remove_edge",
      "remove_step",
      "remove_trigger",
    ].includes(operation.op),
  );
  const outputNodes = shouldLayout
    ? autoLayoutGraph(nextNodes, nextEdges)
    : nextNodes;
  const validation = validateGraph(outputNodes, nextEdges, actionsByName);

  return {
    edges: nextEdges.map((edge) =>
      String(edge.data?.runtimeSourceKind) === "trigger"
        ? decorateTriggerEdge(edge)
        : decorateEdge(edge),
    ),
    errors: [...errors, ...validation.errors],
    metadata,
    nodes: outputNodes,
  } satisfies GraphSnapshot & {
    errors: string[];
    metadata: WorkflowMetadataPatch;
  };
}

function removeEdges(edges: Edge[], predicate: (edge: Edge) => boolean) {
  let removed = false;
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const edge = edges[index];
    if (edge && predicate(edge)) {
      edges.splice(index, 1);
      removed = true;
    }
  }
  return removed;
}

function patchStepNode(
  nodes: Node<WorkflowCanvasNodeData>[],
  stepId: string,
  patch: (
    node: Node<Extract<WorkflowCanvasNodeData, { nodeKind: "step" }>>,
  ) => Node<Extract<WorkflowCanvasNodeData, { nodeKind: "step" }>>,
) {
  const index = nodes.findIndex((node) => node.id === stepId);
  const node = nodes[index];
  if (!node || !isStepNode(node)) {
    return false;
  }
  nodes[index] = patch(node);
  return true;
}

function resolveRef(ref: string, refToNodeId: ReadonlyMap<string, string>) {
  return refToNodeId.get(ref) ?? ref;
}

function resolveExpression(
  expression: string,
  refToNodeId: ReadonlyMap<string, string>,
) {
  return expression.replace(
    /\$\{steps\.([^.}]+)\.(outputs|artifacts)([.}])/g,
    (match, ref: string, kind: string, suffix: string) =>
      `\${steps.${resolveRef(ref, refToNodeId)}.${kind}${suffix}`,
  );
}

function inputExpectsArray(
  node: Node<Extract<WorkflowCanvasNodeData, { nodeKind: "step" }>>,
  inputKey: string,
) {
  const manifest = node.data.action?.manifest ?? node.data.manifest ?? {};
  const inputs = isJsonObject(manifest.inputs) ? manifest.inputs : {};
  const input = inputs[inputKey];
  return isJsonObject(input) && input.type === "array";
}

function cloneNode(
  node: Node<WorkflowCanvasNodeData>,
): Node<WorkflowCanvasNodeData> {
  if (isStepNode(node)) {
    return {
      ...node,
      data: {
        ...node.data,
        config: cloneJson(node.data.config),
        inputBindings: cloneJson(node.data.inputBindings),
        issues: [...node.data.issues],
      },
      position: { ...node.position },
      selected: false,
    };
  }

  if (isTriggerNode(node)) {
    return {
      ...node,
      data: {
        ...node.data,
        config: cloneJson(node.data.config),
        issues: [...node.data.issues],
        state: cloneJson(node.data.state),
      },
      position: { ...node.position },
      selected: false,
    };
  }

  return {
    ...node,
    position: { ...node.position },
    selected: false,
  };
}

function cloneEdge(edge: Edge): Edge {
  return {
    ...edge,
    data: edge.data ? cloneJson(edge.data as JsonObject) : edge.data,
    markerEnd:
      edge.markerEnd && typeof edge.markerEnd === "object"
        ? { ...edge.markerEnd }
        : edge.markerEnd,
    selected: false,
    style: edge.style ? { ...edge.style } : edge.style,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {})) as T;
}
