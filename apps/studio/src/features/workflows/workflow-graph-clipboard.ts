import { MarkerType, type Edge, type Node } from "@xyflow/react";
import {
  workflowNodeDefinition,
  workflowSwitchNodeDefinition,
} from "@beam-studio/core/workflows/graph-semantics";
import {
  decorateEdge,
  decorateTriggerEdge,
  edgeRuntimeSource,
  edgeRuntimeTarget,
  edgeKindOf,
  isDecisionNode,
  isStepNode,
  isTriggerNode,
  shortId,
} from "./workflow-graph-model";
import type {
  ActionPackage,
  JsonObject,
  WorkflowCanvasNodeData,
  WorkflowDecisionNodeData,
  WorkflowEdge,
  WorkflowNodeData,
  WorkflowTriggerNodeData,
} from "./workflow-graph-types";

export const WORKFLOW_GRAPH_CLIPBOARD_KEY =
  "beam-studio/workflow-graph-clipboard/v2";

const CLIPBOARD_SCHEMA = "beam-workflow-graph-clipboard/v2";
const STEP_REFERENCE_PATTERN = /(\$\{(?:steps|decisions)\.)([^.\s}]+)(?=\.)/g;

type ClipboardStep = Omit<
  WorkflowNodeData,
  "action" | "issues" | "manifest" | "nodeKind"
>;
type ClipboardTrigger = Omit<WorkflowTriggerNodeData, "issues" | "nodeKind">;
type ClipboardNode =
  | {
      kind: "decision";
      position: { x: number; y: number };
      value: WorkflowDecisionNodeData & { id: string };
    }
  | {
      kind: "step";
      position: { x: number; y: number };
      value: ClipboardStep;
    }
  | {
      kind: "trigger";
      position: { x: number; y: number };
      value: ClipboardTrigger;
    };
type ClipboardEdge = {
  condition: WorkflowEdge["condition"];
  runtimeSource: string;
  runtimeSourceKind: string;
  runtimeTarget: string;
  runtimeTargetKind: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type WorkflowGraphClipboardPayload = {
  copiedAt: string;
  edges: ClipboardEdge[];
  nodes: ClipboardNode[];
  schemaVersion: typeof CLIPBOARD_SCHEMA;
  sourceWorkflowId: string;
};

export function createWorkflowGraphClipboardPayload({
  edges,
  nodes,
  selectedNodeIds,
  workflowId,
}: {
  edges: Edge[];
  nodes: Node<WorkflowCanvasNodeData>[];
  selectedNodeIds: Set<string>;
  workflowId: string;
}): WorkflowGraphClipboardPayload {
  return {
    copiedAt: new Date().toISOString(),
    edges: edges
      .filter(
        (edge) =>
          selectedNodeIds.has(edgeRuntimeSource(edge)) &&
          selectedNodeIds.has(edgeRuntimeTarget(edge)),
      )
      .map((edge) => ({
        condition: (edge.data?.condition as WorkflowEdge["condition"]) ?? null,
        runtimeSource: edgeRuntimeSource(edge),
        runtimeSourceKind: edgeKindOf(edge) === "trigger" ? "trigger" : "step",
        runtimeTarget: edgeRuntimeTarget(edge),
        runtimeTargetKind: "step",
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      })),
    nodes: nodes
      .filter((node) => selectedNodeIds.has(node.id))
      .flatMap((node): ClipboardNode[] => {
        if (isDecisionNode(node)) {
          return [
            {
              kind: "decision",
              position: node.position,
              value: { ...node.data, id: node.id, issues: [] },
            },
          ];
        }
        if (isStepNode(node)) {
          const {
            action: _action,
            issues: _issues,
            manifest: _manifest,
            nodeKind: _nodeKind,
            ...value
          } = node.data;
          return [{ kind: "step", position: node.position, value }];
        }
        if (isTriggerNode(node)) {
          const { issues: _issues, nodeKind: _nodeKind, ...value } = node.data;
          return [{ kind: "trigger", position: node.position, value }];
        }
        return [];
      }),
    schemaVersion: CLIPBOARD_SCHEMA,
    sourceWorkflowId: workflowId,
  };
}

export function parseWorkflowGraphClipboardPayload(
  value: string,
): WorkflowGraphClipboardPayload | null {
  try {
    const payload = JSON.parse(value) as Partial<WorkflowGraphClipboardPayload>;
    if (
      payload.schemaVersion !== CLIPBOARD_SCHEMA ||
      typeof payload.sourceWorkflowId !== "string" ||
      !Array.isArray(payload.nodes) ||
      !payload.nodes.length ||
      !Array.isArray(payload.edges) ||
      payload.nodes.some(
        (node) =>
          !node ||
          (node.kind !== "step" &&
            node.kind !== "trigger" &&
            node.kind !== "decision") ||
          typeof node.value?.id !== "string" ||
          !Number.isFinite(node.position?.x) ||
          !Number.isFinite(node.position?.y),
      ) ||
      payload.edges.some(
        (edge) =>
          !edge ||
          typeof edge.source !== "string" ||
          typeof edge.target !== "string" ||
          typeof edge.runtimeSource !== "string" ||
          typeof edge.runtimeTarget !== "string",
      )
    ) {
      return null;
    }
    return payload as WorkflowGraphClipboardPayload;
  } catch {
    return null;
  }
}

export function materializeWorkflowGraphClipboardPayload({
  actionsByName,
  anchor,
  existingNodeCount,
  offset,
  payload,
  targetWorkflowId,
}: {
  actionsByName: Map<string, ActionPackage>;
  anchor?: { x: number; y: number };
  existingNodeCount: number;
  offset: number;
  payload: WorkflowGraphClipboardPayload;
  targetWorkflowId: string;
}) {
  const idMap = new Map(
    payload.nodes.map((node) => [
      node.value.id,
      `${node.kind === "decision" ? "dec" : node.kind === "step" ? "wfs" : "wftg"}_${shortId()}`,
    ]),
  );
  const minimum = payload.nodes.reduce(
    (result, node) => ({
      x: Math.min(result.x, node.position.x),
      y: Math.min(result.y, node.position.y),
    }),
    { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY },
  );
  const translate = anchor
    ? { x: anchor.x - minimum.x, y: anchor.y - minimum.y }
    : { x: offset, y: offset };
  const preserveExternalReferences =
    payload.sourceWorkflowId === targetWorkflowId;

  const nodes = payload.nodes.map(
    (clipboardNode, index): Node<WorkflowCanvasNodeData> => {
      const nextId = idMap.get(clipboardNode.value.id)!;
      const position = {
        x: clipboardNode.position.x + translate.x,
        y: clipboardNode.position.y + translate.y,
      };
      if (clipboardNode.kind === "decision") {
        const { id: _id, ...data } = clipboardNode.value;
        const cases = data.cases.map((entry) => ({
          ...entry,
          predicate: remapStepReferences(entry.predicate, idMap, true),
        }));
        return {
          id: nextId,
          type: "workflowDecision",
          position,
          selected: true,
          data: {
            ...data,
            decisionId: nextId,
            // Preserve unresolved external references rather than deleting
            // parts of a condition and silently changing its meaning.
            predicate: remapStepReferences(data.predicate, idMap, true),
            cases,
            nodeKind: "decision",
            workflowNodeKind: "gateway",
            definition:
              data.kind === "switch"
                ? workflowSwitchNodeDefinition(cases)
                : workflowNodeDefinition({ kind: "gateway" }),
            issues: [],
          },
        };
      }
      if (clipboardNode.kind === "trigger") {
        return {
          id: nextId,
          type: "workflowTrigger",
          position,
          selected: true,
          data: {
            ...clipboardNode.value,
            id: nextId,
            workflowTemplateId: targetWorkflowId,
            config: remapStepReferences(
              clipboardNode.value.config,
              idMap,
              preserveExternalReferences,
            ),
            state: {},
            canvasX: position.x,
            canvasY: position.y,
            nodeKind: "trigger",
            workflowNodeKind: "trigger",
            definition: workflowNodeDefinition({ kind: "trigger" }),
            issues: [],
          },
        };
      }

      const action =
        actionsByName.get(clipboardNode.value.actionPackageName) ?? null;
      return {
        id: nextId,
        type: "workflowStep",
        position,
        selected: true,
        data: {
          ...clipboardNode.value,
          id: nextId,
          position: existingNodeCount + index,
          config: remapStepReferences(
            clipboardNode.value.config,
            idMap,
            preserveExternalReferences,
          ),
          inputBindings: remapStepReferences(
            clipboardNode.value.inputBindings,
            idMap,
            preserveExternalReferences,
          ),
          canvasX: position.x,
          canvasY: position.y,
          manifest: action?.manifest ?? null,
          nodeKind: "step",
          workflowNodeKind: workflowNodeDefinition({
            actionPackageName: clipboardNode.value.actionPackageName,
          }).kind as WorkflowNodeData["workflowNodeKind"],
          definition: workflowNodeDefinition({
            actionPackageName: clipboardNode.value.actionPackageName,
          }),
          action,
          issues: [],
        },
      };
    },
  );
  const edges = payload.edges.flatMap((edge): Edge[] => {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    const runtimeSource = idMap.get(edge.runtimeSource);
    const runtimeTarget = idMap.get(edge.runtimeTarget);
    if (!source || !target || !runtimeSource || !runtimeTarget) {
      return [];
    }
    const next: Edge = {
      id: `${edge.runtimeSourceKind === "trigger" ? "wfte" : "wfe"}_${shortId()}`,
      source,
      target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: "smoothstep",
      selected: true,
      data: {
        edgeKind: edge.runtimeSourceKind === "trigger" ? "trigger" : "flow",
        condition: remapStepReferences(edge.condition, idMap, false),
        runtimeSource,
        runtimeSourceKind: edge.runtimeSourceKind,
        runtimeTarget,
        runtimeTargetKind: edge.runtimeTargetKind,
      },
      markerEnd: { type: MarkerType.ArrowClosed },
    };
    return [
      edge.runtimeSourceKind === "trigger"
        ? decorateTriggerEdge(next)
        : decorateEdge(next),
    ];
  });

  return { edges, nodes };
}

function remapStepReferences<T>(
  value: T,
  idMap: Map<string, string>,
  preserveExternalReferences: boolean,
): T {
  return remapValue(value, idMap, preserveExternalReferences) as T;
}

function remapValue(
  value: unknown,
  idMap: Map<string, string>,
  preserveExternalReferences: boolean,
): unknown {
  if (typeof value === "string") {
    let hasExternalReference = false;
    const remapped = value.replace(
      STEP_REFERENCE_PATTERN,
      (match, prefix: string, stepId: string) => {
        const nextId = idMap.get(stepId);
        if (!nextId) {
          hasExternalReference = true;
          return match;
        }
        return `${prefix}${nextId}`;
      },
    );
    return hasExternalReference && !preserveExternalReferences
      ? undefined
      : remapped;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => remapValue(item, idMap, preserveExternalReferences))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const record = value as JsonObject;
    if (typeof record.step === "string" && record.field === "status") {
      return { ...record, step: idMap.get(record.step) ?? record.step };
    }
    return Object.fromEntries(
      Object.entries(value as JsonObject).flatMap(([key, item]) => {
        const remapped = remapValue(item, idMap, preserveExternalReferences);
        return remapped === undefined ? [] : [[key, remapped]];
      }),
    );
  }
  return value;
}
