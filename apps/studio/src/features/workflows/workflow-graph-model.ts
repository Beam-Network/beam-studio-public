import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type {
  WorkflowGraphV2Control,
  WorkflowGraphV2Edge,
} from "@beam-studio/core/workflows/graph-v2";
import type { WorkflowGraphV3Distribution } from "@beam-studio/core/workflows/graph-v3";
import {
  DECISION_FALSE_PORT,
  DECISION_TRUE_PORT,
  SWITCH_DEFAULT_PORT,
  getCompositeEntryStepIds as getSharedCompositeEntryStepIds,
  getWorkflowEntryStepIds,
  normalizeWorkflowEdges,
  triggerTargetsForPresentationEdge,
  workflowNodeDefinition,
  workflowSwitchNodeDefinition,
  type WorkflowSemanticEdge,
  type WorkflowSemanticGraph,
  type WorkflowSemanticNode,
} from "@beam-studio/core/workflows/graph-semantics";
import {
  defaultConfigFromManifest,
  sanitizeActionConfig,
} from "./workflow-config-schema";
import type {
  ActionPackage,
  ActionSort,
  JsonObject,
  WorkflowCanvasNodeData,
  WorkflowBundle,
  WorkflowControlNodeData,
  WorkflowDecisionEdgeRecord,
  WorkflowDecisionNodeData,
  WorkflowDecisionRecord,
  WorkflowEdge,
  WorkflowGraphEdgeData,
  WorkflowNodeData,
  WorkflowStep,
  WorkflowTrigger,
  WorkflowTriggerEdge,
  WorkflowTriggerNodeData,
  WorkflowTriggerType,
} from "./workflow-graph-types";
import {
  WORKFLOW_INPUT_HANDLE,
  WORKFLOW_OUTPUT_HANDLE,
} from "./workflow-graph-constants";
import { createDefaultScheduleTriggerConfig } from "@/features/scheduling/schedule-config";
import { workflowTriggerDefaultName } from "./workflow-trigger-editor-state";

type WorkflowStepLike = Pick<
  WorkflowStep,
  "id" | "actionPackageName" | "inputBindings"
>;

export function buildNodes(
  steps: WorkflowStep[],
  actionsByName: Map<string, ActionPackage>,
) {
  return steps.map((step): Node<WorkflowNodeData> => {
    const fallback = {
      x: (step.position % 4) * 340,
      y: Math.floor(step.position / 4) * 220,
    };
    return {
      id: step.id,
      type: "workflowStep",
      position: {
        x: step.canvasX ?? fallback.x,
        y: step.canvasY ?? fallback.y,
      },
      data: {
        ...step,
        config: sanitizeActionConfig(step.actionPackageName, step.config),
        nodeKind: "step",
        workflowNodeKind: workflowNodeDefinition({
          actionPackageName: step.actionPackageName,
        }).kind as WorkflowNodeData["workflowNodeKind"],
        definition: workflowNodeDefinition({
          actionPackageName: step.actionPackageName,
        }),
        action: actionsByName.get(step.actionPackageName) ?? null,
        issues: [],
      },
    };
  });
}

export function buildTriggerNodes(triggers: WorkflowTrigger[]) {
  return triggers.map((trigger, index): Node<WorkflowTriggerNodeData> => {
    const fallback = {
      x: -260,
      y: 120 + index * 220,
    };
    return {
      id: trigger.id,
      type: "workflowTrigger",
      position: {
        x: trigger.canvasX ?? fallback.x,
        y: trigger.canvasY ?? fallback.y,
      },
      data: {
        ...trigger,
        nodeKind: "trigger",
        workflowNodeKind: "trigger",
        definition: workflowNodeDefinition({ kind: "trigger" }),
        issues: [],
      },
    };
  });
}

export function buildControlNodes(controls: WorkflowGraphV2Control[]) {
  return controls.flatMap((control, index): Node<WorkflowControlNodeData>[] => {
    const position = {
      x: control.layout?.x ?? 160 + index * 360,
      y: control.layout?.y ?? 420,
    };
    const primary: Node<WorkflowControlNodeData> = {
      id: control.id,
      type: "workflowControl",
      position,
      data: {
        nodeKind: "control",
        workflowNodeKind: "control",
        definition: workflowNodeDefinition({ kind: "control" }),
        role: control.kind,
        controlId: control.id,
        control,
        issues: [],
      },
    };
    if (control.kind !== "fan-out") return [primary];
    return [
      primary,
      {
        id: control.fanInId,
        type: "workflowControl",
        position: {
          x: control.layout?.fanInX ?? position.x + 420,
          y: control.layout?.fanInY ?? position.y,
        },
        data: {
          nodeKind: "control",
          workflowNodeKind: "control",
          definition: workflowNodeDefinition({ kind: "control" }),
          role: "fan-in",
          controlId: control.id,
          control,
          issues: [],
        },
      },
    ];
  });
}

export function createDecisionNode(
  order: number,
  explicitPosition?: { x: number; y: number },
): Node<WorkflowDecisionNodeData> {
  const id = `dec_${shortId()}`;
  return {
    id,
    type: "workflowDecision",
    position: explicitPosition ?? {
      x: 200 + (order % 4) * 320,
      y: 300 + Math.floor(order / 4) * 200,
    },
    data: {
      nodeKind: "decision",
      workflowNodeKind: "gateway",
      definition: workflowNodeDefinition({ kind: "gateway" }),
      decisionId: id,
      name: "Decision",
      kind: "if",
      enabled: true,
      joinMode: "all",
      handleFailure: false,
      predicate: null,
      cases: [],
      issues: [],
    },
  };
}

export function createSwitchNode(
  order: number,
  explicitPosition?: { x: number; y: number },
): Node<WorkflowDecisionNodeData> {
  const id = `dec_${shortId()}`;
  const cases = [{ id: `case_${shortId()}`, name: "Case 1", predicate: false }];
  return {
    id,
    type: "workflowDecision",
    position: explicitPosition ?? {
      x: 200 + (order % 4) * 320,
      y: 300 + Math.floor(order / 4) * 200,
    },
    data: {
      nodeKind: "decision",
      workflowNodeKind: "gateway",
      definition: workflowSwitchNodeDefinition(cases),
      decisionId: id,
      name: "Switch",
      kind: "switch",
      enabled: true,
      joinMode: "all",
      handleFailure: false,
      predicate: null,
      cases,
      issues: [],
    },
  };
}

export function createControlNodes(
  kind: "loop" | "fan-out",
  order: number,
  bodyStepIds: string[],
  explicitPosition?: { x: number; y: number },
) {
  const id = `${kind === "loop" ? "loop" : "fanout"}_${shortId()}`;
  const position = explicitPosition ?? {
    x: 140 + (order % 4) * 340,
    y: 420 + Math.floor(order / 4) * 220,
  };
  const body = {
    stepIds: bodyStepIds,
    entryStepId: bodyStepIds[0] ?? "",
    outputStepId: bodyStepIds.at(-1) ?? "",
    edges: [],
  };
  const control: WorkflowGraphV2Control =
    kind === "loop"
      ? {
          id,
          kind,
          iterations: 1,
          outputMode: "all",
          body,
          layout: position,
        }
      : {
          id,
          kind,
          items: "${workflow.input.items}",
          concurrency: 10,
          fanInId: `${id}_join`,
          body,
          layout: {
            ...position,
            fanInX: position.x + 420,
            fanInY: position.y,
          },
        };
  return buildControlNodes([control]);
}

export function buildEdges(edges: WorkflowEdge[], steps: WorkflowStep[] = []) {
  const nodes: WorkflowSemanticNode[] = steps.map((step) => ({
    id: step.id,
    enabled: step.enabled,
    actionPackageName: step.actionPackageName,
    inputBindings: step.inputBindings,
    definition: workflowNodeDefinition({
      actionPackageName: step.actionPackageName,
    }),
  }));
  return normalizeWorkflowEdges({ nodes, edges }).map(canvasEdgeFromSemantic);
}

export function buildControlBodyEdges(controls: WorkflowGraphV2Control[]) {
  return controls.flatMap((control) =>
    control.body.edges.map((edge, index) =>
      decorateEdge({
        id: edge.id ?? `${control.id}_body_${index}`,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
        data: {
          edgeKind: "flow",
          condition: edge.condition ?? null,
          runtimeSource: edge.from,
          runtimeTarget: edge.to,
          runtimeSourceKind: "step",
          runtimeTargetKind: "step",
          dynamicControlId: control.id,
        },
        markerEnd: { type: MarkerType.ArrowClosed },
      }),
    ),
  );
}

export function buildTriggerEdges(
  edges: WorkflowTriggerEdge[],
  steps: WorkflowStep[] = [],
) {
  return edges.map((edge) =>
    applyWorkflowEdgePresentation(
      {
        id: edge.id,
        source: edge.triggerId,
        target: edge.toStepId,
        type: "smoothstep",
        data: {
          edgeKind: "trigger",
          condition: edge.condition,
          runtimeSource: edge.triggerId,
          runtimeTarget: edge.toStepId,
          runtimeSourceKind: "trigger",
          runtimeTargetKind: "step",
        },
        markerEnd: { type: MarkerType.ArrowClosed },
      },
      steps,
    ),
  );
}

/** Deterministic API bundle -> presentation graph transformation. */
export function presentationGraphFromWorkflowBundle(
  bundle: WorkflowBundle,
  actionsByName: Map<string, ActionPackage>,
) {
  const nodes: Node<WorkflowCanvasNodeData>[] = [
    ...buildTriggerNodes(bundle.triggers),
    ...buildNodes(bundle.steps, actionsByName),
    ...buildControlNodes(bundle.controls ?? []),
    ...buildDecisionNodes(bundle.decisions ?? []),
  ];
  const semanticNodes = semanticNodesFromCanvas(nodes);
  const semanticEdges = normalizeWorkflowEdges({
    nodes: semanticNodes,
    edges: bundle.edges,
    triggerEdges: bundle.triggerEdges,
  });
  const topLevelEdges = semanticEdges.map(canvasEdgeFromSemantic);
  const bodyEdges = buildControlBodyEdges(bundle.controls ?? []);
  const decisionEdges = buildDecisionEdges(bundle.decisionEdges ?? []);
  return { nodes, edges: [...topLevelEdges, ...bodyEdges, ...decisionEdges] };
}

export function repairMissingWorkflowGraphReferences(bundle: WorkflowBundle) {
  const stepIds = new Set(bundle.steps.map((step) => step.id));
  const triggerIds = new Set(bundle.triggers.map((trigger) => trigger.id));
  const decisionIds = new Set(
    (bundle.decisions ?? []).map((decision) => decision.id),
  );
  const graphNodeIds = new Set(stepIds);
  for (const control of bundle.controls ?? []) {
    graphNodeIds.add(control.id);
    if (control.kind === "fan-out") graphNodeIds.add(control.fanInId);
  }

  const edges = bundle.edges.filter(
    (edge) =>
      graphNodeIds.has(edge.fromStepId) && graphNodeIds.has(edge.toStepId),
  );
  const triggerEdges = bundle.triggerEdges.filter(
    (edge) => triggerIds.has(edge.triggerId) && stepIds.has(edge.toStepId),
  );
  const decisionEdges = (bundle.decisionEdges ?? []).filter(
    (edge) =>
      (!edge.fromStepId || stepIds.has(edge.fromStepId)) &&
      (!edge.toStepId || stepIds.has(edge.toStepId)) &&
      (!edge.fromDecisionId || decisionIds.has(edge.fromDecisionId)) &&
      (!edge.toDecisionId || decisionIds.has(edge.toDecisionId)),
  );
  const controls = (bundle.controls ?? []).map((control) => ({
    ...control,
    body: {
      ...control.body,
      edges: control.body.edges.filter(
        (edge) => stepIds.has(edge.from) && stepIds.has(edge.to),
      ),
    },
  }));
  const removedReferenceCount =
    bundle.edges.length -
    edges.length +
    (bundle.triggerEdges.length - triggerEdges.length) +
    ((bundle.decisionEdges?.length ?? 0) - decisionEdges.length) +
    (bundle.controls ?? []).reduce(
      (count, control, index) =>
        count + control.body.edges.length - controls[index]!.body.edges.length,
      0,
    );

  return {
    payload: {
      graphVersion: bundle.template.graphVersion,
      ...(bundle.graph.version === "workflow-graph/v3"
        ? { distribution: bundle.graph.distribution }
        : {}),
      controls,
      triggers: bundle.triggers,
      triggerEdges,
      decisions: bundle.decisions ?? [],
      decisionEdges,
      steps: bundle.steps,
      edges,
    },
    removedReferenceCount,
  };
}

export function buildDecisionNodes(decisions: WorkflowDecisionRecord[]) {
  return decisions.map((decision, index): Node<WorkflowDecisionNodeData> => {
    const cases = switchCasesFromConfig(decision.config);
    return {
      id: decision.id,
      type: "workflowDecision",
      position: {
        x: decision.canvasX ?? 160 + index * 320,
        y: decision.canvasY ?? 300,
      },
      data: {
        nodeKind: "decision",
        workflowNodeKind: "gateway",
        definition:
          decision.kind === "switch"
            ? workflowSwitchNodeDefinition(cases)
            : workflowNodeDefinition({ kind: "gateway" }),
        decisionId: decision.id,
        name: decision.name,
        kind: decision.kind,
        enabled: decision.enabled,
        joinMode: decision.joinMode,
        handleFailure: decision.handleFailure,
        predicate: decision.config?.predicate ?? null,
        cases,
        issues: [],
      },
    };
  });
}

/**
 * Decision edges carry their branch explicitly, so the canvas can put the edge
 * back on the handle it left by. Port identity is not recoverable from the
 * generic edge projection, which is why the branch is persisted.
 */
export function buildDecisionEdges(edges: WorkflowDecisionEdgeRecord[]) {
  return edges.flatMap((edge): Edge[] => {
    const source = edge.fromStepId ?? edge.fromDecisionId;
    const target = edge.toStepId ?? edge.toDecisionId;
    if (!source || !target) return [];
    return [
      decorateEdge({
        id: edge.id,
        source,
        target,
        sourceHandle: edge.branch
          ? edge.branch === "true"
            ? DECISION_TRUE_PORT
            : edge.branch === "false"
              ? DECISION_FALSE_PORT
              : edge.branch
          : WORKFLOW_OUTPUT_HANDLE,
        targetHandle: WORKFLOW_INPUT_HANDLE,
        data: {
          edgeKind: "flow",
          condition: null,
          runtimeSource: source,
          runtimeTarget: target,
          runtimeSourceKind: "step",
          runtimeTargetKind: "step",
          decisionBranch: edge.branch ?? null,
          isDecisionEdge: true,
        },
      }),
    ];
  });
}

export function applyWorkflowEdgePresentation(
  edge: Edge,
  _steps: WorkflowStepLike[],
) {
  // Persisted edges are projected by normalizeWorkflowEdges. This adapter only
  // reapplies visual styling after React Flow selection changes.
  return isTriggerEdge(edge) ? decorateTriggerEdge(edge) : decorateEdge(edge);
}

export function decorateEdge(edge: Edge): Edge {
  const selected = Boolean(edge.selected);
  const isControlBodyEdge = Boolean(edge.data?.dynamicControlId);
  const edgeKind = edgeKindOf(edge);
  const isEndpointEdge = edgeKind === "binding";
  const stroke = selected
    ? "hsl(var(--primary))"
    : edgeKind === "error"
      ? "hsl(var(--destructive))"
      : edgeKind === "event"
        ? "hsl(var(--warning))"
        : isEndpointEdge || edgeKind === "data"
          ? "hsl(var(--info))"
          : isControlBodyEdge
            ? "hsl(var(--primary))"
            : "hsl(var(--muted-foreground))";
  return {
    ...edge,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
    style: {
      ...edge.style,
      stroke,
      strokeDasharray: isEndpointEdge
        ? "6 4"
        : edgeKind === "data"
          ? "2 3"
          : edgeKind === "event"
            ? "8 3"
            : isControlBodyEdge
              ? "4 4"
              : undefined,
      strokeWidth: selected ? 2.5 : 1.5,
    },
  };
}

export function decorateTriggerEdge(edge: Edge): Edge {
  const selected = Boolean(edge.selected);
  return {
    ...edge,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: "hsl(var(--primary))" },
    style: {
      ...edge.style,
      stroke: "hsl(var(--primary))",
      strokeDasharray: "5 5",
      strokeWidth: selected ? 2.5 : 1.5,
    },
  };
}

export function createNode(
  action: ActionPackage,
  order: number,
  kind: "action" | "endpoint",
  explicitPosition?: { x: number; y: number },
): Node<WorkflowNodeData> {
  const id = `wfs_${shortId()}`;
  const position = explicitPosition ?? {
    x: 120 + (order % 4) * 340,
    y: 120 + Math.floor(order / 4) * 220,
  };

  return {
    id,
    type: "workflowStep",
    position,
    data: {
      id,
      actionPackageName: action.name,
      actionVersionRange: `^${action.version}`,
      position: order,
      enabled: true,
      config: sanitizeActionConfig(
        action.name,
        kind === "endpoint"
          ? {
              name: "Object storage endpoint",
              provider: "s3",
              bucket: "",
              objectKey: "",
              sourceType: "file",
              credentialId: "",
            }
          : defaultConfigFromManifest(action.manifest),
      ),
      inputBindings: {},
      placement: defaultPlacement(action.manifest),
      executionLocationId: null,
      canvasX: position.x,
      canvasY: position.y,
      timeoutSeconds: null,
      required: kind === "action",
      manifest: action.manifest,
      nodeKind: "step",
      workflowNodeKind: workflowNodeDefinition({
        actionPackageName: action.name,
      }).kind as WorkflowNodeData["workflowNodeKind"],
      definition: workflowNodeDefinition({ actionPackageName: action.name }),
      action,
      issues: [],
    },
  };
}

export function createTrigger(
  type: WorkflowTriggerType,
  order: number,
  explicitPosition?: { x: number; y: number },
): Node<WorkflowTriggerNodeData> {
  const id = `wftg_${shortId()}`;
  const position = explicitPosition ?? {
    x: -260,
    y: 120 + order * 220,
  };
  return {
    id,
    type: "workflowTrigger",
    position,
    data: {
      id,
      workflowTemplateId: "",
      type,
      name: workflowTriggerDefaultName(type),
      enabled: true,
      config: type === "schedule" ? createDefaultScheduleTriggerConfig() : {},
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

export function filterActions(actions: ActionPackage[], search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return actions;
  }

  return actions.filter((action) =>
    [
      action.name,
      action.version,
      String(action.manifest.displayName ?? ""),
      String(action.manifest.description ?? ""),
      JSON.stringify(action.manifest.catalog ?? {}),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

export function sortActions(actions: ActionPackage[], sort: ActionSort) {
  return [...actions].sort((left, right) => {
    if (sort === "version") {
      return (
        left.version.localeCompare(right.version) ||
        left.name.localeCompare(right.name)
      );
    }
    if (sort === "maturity") {
      return (
        actionMaturity(left).localeCompare(actionMaturity(right)) ||
        left.name.localeCompare(right.name)
      );
    }
    return actionDisplayName(left).localeCompare(actionDisplayName(right));
  });
}

// The editor must represent invalid intermediate states without throwing during
// render. Strict projection is still used by validation and save consumers.
export function toDraftPayload(
  nodes: Node<WorkflowCanvasNodeData>[],
  edges: Edge[],
  preferredGraphVersion?:
    | "workflow-graph/v1"
    | "workflow-graph/v2"
    | "workflow-graph/v3",
  distribution?: WorkflowGraphV3Distribution,
) {
  return serializeGraphPayload(
    nodes,
    edges,
    preferredGraphVersion,
    false,
    distribution,
  );
}

export function toSavePayload(
  nodes: Node<WorkflowCanvasNodeData>[],
  edges: Edge[],
  preferredGraphVersion?:
    | "workflow-graph/v1"
    | "workflow-graph/v2"
    | "workflow-graph/v3",
  distribution?: WorkflowGraphV3Distribution,
) {
  return serializeGraphPayload(
    nodes,
    edges,
    preferredGraphVersion,
    true,
    distribution,
  );
}

function serializeGraphPayload(
  nodes: Node<WorkflowCanvasNodeData>[],
  edges: Edge[],
  preferredGraphVersion:
    | "workflow-graph/v1"
    | "workflow-graph/v2"
    | "workflow-graph/v3"
    | undefined,
  strict: boolean,
  distribution?: WorkflowGraphV3Distribution,
) {
  const stepNodes = nodes.filter(isStepNode);
  const triggerNodes = nodes.filter(isTriggerNode);
  const controlNodes = nodes.filter(isControlNode);
  const decisionNodes = nodes.filter(isDecisionNode);
  const decisionNodeIds = new Set(decisionNodes.map((node) => node.id));
  // Edges touching a decision persist in their own table, keyed by branch, so
  // they must not leak into the ordinary step edge list.
  const decisionCanvasEdges = edges.filter(
    (edge) =>
      !isTriggerEdge(edge) &&
      (decisionNodeIds.has(edgeRuntimeSource(edge)) ||
        decisionNodeIds.has(edgeRuntimeTarget(edge))),
  );
  const decisionEdgeIds = new Set(decisionCanvasEdges.map((edge) => edge.id));
  const graphEdges = edges.filter(
    (edge) => !isTriggerEdge(edge) && !decisionEdgeIds.has(edge.id),
  );
  const triggerEdges = edges.filter(isTriggerEdge);
  const primaryControlNodes = controlNodes.filter(
    (node) => node.data.role !== "fan-in",
  );
  const controls = primaryControlNodes.map((node) => {
    const control = node.data.control;
    const fanInNode =
      control.kind === "fan-out"
        ? controlNodes.find((candidate) => candidate.id === control.fanInId)
        : null;
    const bodyIds = new Set(control.body.stepIds);
    return {
      ...control,
      body: {
        ...control.body,
        edges: graphEdges
          .filter(
            (edge) =>
              bodyIds.has(edgeRuntimeSource(edge)) &&
              bodyIds.has(edgeRuntimeTarget(edge)),
          )
          .map((edge) => ({
            id: edge.id,
            from: edgeRuntimeSource(edge),
            to: edgeRuntimeTarget(edge),
            condition:
              (edge.data?.condition as WorkflowGraphV2Edge["condition"]) ??
              null,
          })),
      },
      layout: {
        ...control.layout,
        x: node.position.x,
        y: node.position.y,
        ...(fanInNode
          ? { fanInX: fanInNode.position.x, fanInY: fanInNode.position.y }
          : {}),
      },
    } satisfies WorkflowGraphV2Control;
  });
  const bodyStepIds = new Set(
    controls.flatMap((control) => control.body.stepIds),
  );
  const topLevelGraphEdges = graphEdges.filter(
    (edge) =>
      !(
        bodyStepIds.has(edgeRuntimeSource(edge)) &&
        bodyStepIds.has(edgeRuntimeTarget(edge))
      ),
  );
  const sortedNodes = [...stepNodes].sort((left, right) =>
    left.position.x === right.position.x
      ? left.position.y - right.position.y
      : left.position.x - right.position.x,
  );
  const stepsById = new Map(sortedNodes.map((node) => [node.id, node.data]));
  const orderById = new Map(sortedNodes.map((node, index) => [node.id, index]));
  const enabledStepIds = new Set(
    stepNodes.filter((node) => node.data.enabled).map((node) => node.id),
  );
  const semanticGraph = semanticGraphFromCanvas(nodes, [
    ...topLevelGraphEdges,
    ...triggerEdges,
  ]);
  const rootStepIds = new Set(getWorkflowEntryStepIds(semanticGraph));
  const triggerEdgeRecords = triggerEdges.flatMap((edge) => {
    const semanticEdge = semanticEdgeFromCanvas(edge, nodes);
    const targets = triggerTargetsForPresentationEdge(
      semanticEdge,
      semanticGraph,
    );
    if (!targets.length && !strict) {
      // Preserve the connection even when disabling all composite members leaves
      // no runtime entry. Never erase edges just to make an invalid draft saveable.
      targets.push(
        ...(semanticEdge.runtimeEdges.length
          ? semanticEdge.runtimeEdges.map((runtime) => runtime.target)
          : [edgeRuntimeTarget(edge)]),
      );
    }
    if (!targets.length) {
      throw new Error(
        `Trigger edge ${edge.id} cannot be projected to a runtime entry step.`,
      );
    }
    const invalidTarget = targets.find(
      (targetId) => !rootStepIds.has(targetId),
    );
    if (strict && invalidTarget) {
      if (stepsById.get(invalidTarget)?.enabled === false) {
        throw new Error(
          `A trigger targets disabled action ${invalidTarget}. Enable the action or reconnect the trigger to an enabled entry step.`,
        );
      }
      throw new Error(
        `Trigger edge ${edge.id} targets ${invalidTarget}, which is not a runtime entry step.`,
      );
    }
    const existingRuntimeEdges = semanticEdge.runtimeEdges;
    return targets.map((targetId, index) => ({
      id:
        existingRuntimeEdges.find((runtime) => runtime.target === targetId)
          ?.id ?? (index === 0 ? edge.id : `${edge.id}__${targetId}`),
      triggerId: edgeRuntimeSource(edge),
      toStepId: targetId,
      condition: (edge.data?.condition as WorkflowEdge["condition"]) ?? null,
    }));
  });
  return {
    triggers: triggerNodes.map((node) => ({
      id: node.id,
      type: node.data.type,
      name: node.data.name,
      enabled: node.data.enabled,
      config: node.data.config,
      state: node.data.state,
      canvasX: node.position.x,
      canvasY: node.position.y,
    })),
    steps: sortedNodes.map((node) => ({
      id: node.id,
      kind: node.data.kind ?? "action",
      calledWorkflowId: node.data.calledWorkflowId ?? null,
      name: node.data.name ?? null,
      actionPackageName: node.data.actionPackageName,
      actionVersionRange: node.data.actionVersionRange,
      position: orderById.get(node.id) ?? node.data.position,
      enabled: node.data.enabled,
      config: sanitizeActionConfig(
        node.data.actionPackageName,
        node.data.config,
      ),
      inputBindings: node.data.inputBindings,
      placement: node.data.placement,
      executionTarget: node.data.executionTarget,
      executionLocationId: node.data.executionLocationId,
      canvasX: node.position.x,
      canvasY: node.position.y,
      timeoutSeconds: node.data.timeoutSeconds,
      required: node.data.required,
    })),
    triggerEdges: triggerEdgeRecords,
    decisions: decisionNodes.map((node) => ({
      id: node.id,
      name: node.data.name,
      kind: node.data.kind,
      enabled: node.data.enabled,
      joinMode: node.data.joinMode,
      handleFailure: node.data.handleFailure,
      config:
        node.data.kind === "switch"
          ? { cases: node.data.cases }
          : { predicate: node.data.predicate ?? null },
      canvasX: node.position.x,
      canvasY: node.position.y,
    })),
    decisionEdges: decisionCanvasEdges.map((edge) => {
      const source = edgeRuntimeSource(edge);
      const target = edgeRuntimeTarget(edge);
      const fromDecision = decisionNodeIds.has(source);
      return {
        id: edge.id,
        fromStepId: fromDecision ? null : source,
        fromDecisionId: fromDecision ? source : null,
        toStepId: decisionNodeIds.has(target) ? null : target,
        toDecisionId: decisionNodeIds.has(target) ? target : null,
        // The branch is the handle the edge left by. It is persisted because
        // port identity does not survive the generic edge projection.
        branch: fromDecision
          ? edge.sourceHandle === DECISION_FALSE_PORT
            ? ("false" as const)
            : edge.sourceHandle === DECISION_TRUE_PORT
              ? ("true" as const)
              : edge.sourceHandle === SWITCH_DEFAULT_PORT ||
                  edge.sourceHandle?.startsWith("case:")
                ? (edge.sourceHandle as `case:${string}` | "default")
                : null
          : null,
      };
    }),
    graphVersion:
      preferredGraphVersion === "workflow-graph/v3"
        ? ("workflow-graph/v3" as const)
        : controls.length ||
            decisionNodes.length ||
            preferredGraphVersion === "workflow-graph/v2"
          ? ("workflow-graph/v2" as const)
          : ("workflow-graph/v1" as const),
    ...(preferredGraphVersion === "workflow-graph/v3"
      ? {
          distribution: distribution ?? {
            partitions: [],
            steps: [],
            routes: [],
          },
        }
      : {}),
    controls,
    edges: topLevelGraphEdges.map((edge) => ({
      id: edge.id,
      fromStepId: edgeRuntimeSource(edge),
      toStepId: edgeRuntimeTarget(edge),
      condition: (edge.data?.condition as WorkflowEdge["condition"]) ?? null,
    })),
  };
}

/** Explicit presentation graph -> current API payload adapter. */
export const workflowPayloadFromPresentationGraph = toSavePayload;

export function getCompositeEntryStepIds(
  compositeNodeId: string,
  nodes: Node<WorkflowCanvasNodeData>[],
  edges: Edge[],
) {
  return getSharedCompositeEntryStepIds(
    compositeNodeId,
    semanticGraphFromCanvas(nodes, edges),
  );
}

export function edgeRuntimeSource(edge: Edge) {
  return stringDataValue(edge, "runtimeSource") || edge.source;
}

export function edgeRuntimeTarget(edge: Edge) {
  return stringDataValue(edge, "runtimeTarget") || edge.target;
}

export function edgeRuntimeSourceKind(edge: Edge) {
  const explicit = stringDataValue(edge, "runtimeSourceKind");
  if (explicit) return explicit;
  if (edgeKindOf(edge) === "trigger") return "trigger";
  throw new Error(`Edge ${edge.id} is missing runtimeSourceKind.`);
}

export function edgeRuntimeTargetKind(edge: Edge) {
  const explicit = stringDataValue(edge, "runtimeTargetKind");
  if (explicit) return explicit;
  if (edgeKindOf(edge) === "trigger") return "step";
  throw new Error(`Edge ${edge.id} is missing runtimeTargetKind.`);
}

export function edgeKindOf(edge: Edge) {
  const explicit = stringDataValue(edge, "edgeKind");
  if (explicit) return explicit;
  // Compatibility adapter for in-memory graph operations created before edge
  // kinds became mandatory. Persisted bundles are normalized by core above.
  if (stringDataValue(edge, "runtimeSourceKind") === "trigger")
    return "trigger";
  if (edge.data?.connectionKind === "endpoint") return "binding";
  return edge.data?.dynamicControlId ? "flow" : "flow";
}

export function isTriggerEdge(edge: Edge) {
  return edgeKindOf(edge) === "trigger";
}

export function isControlNode(
  node: Node<WorkflowCanvasNodeData>,
): node is Node<WorkflowControlNodeData> {
  return node.data.nodeKind === "control";
}

export function isDecisionNode(
  node: Node<WorkflowCanvasNodeData>,
): node is Node<WorkflowDecisionNodeData> {
  return node.data.nodeKind === "decision";
}

export function isStepNode(
  node: Node<WorkflowCanvasNodeData>,
): node is Node<WorkflowNodeData> {
  return node.data.nodeKind === "step";
}

export function isTriggerNode(
  node: Node<WorkflowCanvasNodeData>,
): node is Node<WorkflowTriggerNodeData> {
  return node.data.nodeKind === "trigger";
}

export function shortId() {
  return (
    globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 12) ??
    Math.random().toString(36).slice(2, 14)
  );
}

function switchCasesFromConfig(config: JsonObject) {
  if (!Array.isArray(config.cases)) return [];
  return config.cases.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) return [];
    return [
      {
        id,
        name:
          typeof record.name === "string" && record.name.trim()
            ? record.name.trim()
            : `Case ${index + 1}`,
        predicate: record.predicate ?? false,
      },
    ];
  });
}

export function semanticNodesFromCanvas(
  nodes: Node<WorkflowCanvasNodeData>[],
): WorkflowSemanticNode[] {
  return nodes.map((node) => ({
    id: node.id,
    definition: node.data.definition,
    enabled:
      isStepNode(node) || isTriggerNode(node) || isDecisionNode(node)
        ? node.data.enabled
        : true,
    ...(isStepNode(node)
      ? {
          actionPackageName: node.data.actionPackageName,
          inputBindings: node.data.inputBindings,
        }
      : {}),
  }));
}

export function semanticGraphFromCanvas(
  nodes: Node<WorkflowCanvasNodeData>[],
  edges: Edge[],
): WorkflowSemanticGraph {
  return {
    nodes: semanticNodesFromCanvas(nodes),
    edges: edges.map((edge) => semanticEdgeFromCanvas(edge, nodes)),
  };
}

export function semanticEdgeFromCanvas(
  edge: Edge,
  nodes: Node<WorkflowCanvasNodeData>[],
): WorkflowSemanticEdge {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) {
    throw new Error(`Edge ${edge.id} references a missing presentation node.`);
  }
  const kind = edgeKindOf(edge) as WorkflowSemanticEdge["kind"];
  const storedRuntime = Array.isArray(edge.data?.runtimeEdges)
    ? (edge.data.runtimeEdges as WorkflowSemanticEdge["runtimeEdges"])
    : null;
  const runtimeSource = edgeRuntimeSource(edge);
  const runtimeTarget = edgeRuntimeTarget(edge);
  const runtimeSourceNode = nodes.find((node) => node.id === runtimeSource);
  const runtimeTargetNode = nodes.find((node) => node.id === runtimeTarget);
  const runtimeEdges: WorkflowSemanticEdge["runtimeEdges"] =
    storedRuntime?.length
      ? storedRuntime
      : [
          {
            id: edge.id,
            source: runtimeSource,
            target: runtimeTarget,
            sourceKind:
              kind === "trigger"
                ? "trigger"
                : stringDataValue(edge, "runtimeSourceKind") === "control" ||
                    (runtimeSourceNode && isControlNode(runtimeSourceNode))
                  ? "control"
                  : "step",
            targetKind:
              stringDataValue(edge, "runtimeTargetKind") === "control" ||
              (runtimeTargetNode && isControlNode(runtimeTargetNode))
                ? "control"
                : "step",
            dependency: kind !== "trigger" && kind !== "membership",
          },
        ];
  return {
    id: edge.id,
    kind,
    visualSource: edge.source,
    visualTarget: edge.target,
    sourcePort: edge.sourceHandle ?? defaultPortId(source, "output", kind),
    targetPort: edge.targetHandle ?? defaultPortId(target, "input", kind),
    runtimeEdges,
    ...(edge.data?.binding
      ? { binding: edge.data.binding as WorkflowSemanticEdge["binding"] }
      : {}),
    ...(typeof edge.data?.compositeNodeId === "string" &&
    typeof edge.data?.memberNodeId === "string"
      ? {
          membership: {
            compositeNodeId: edge.data.compositeNodeId,
            memberNodeId: edge.data.memberNodeId,
            role:
              typeof edge.data.membershipRole === "string"
                ? edge.data.membershipRole
                : undefined,
          },
        }
      : {}),
    condition: edge.data?.condition ?? null,
  };
}

export function canvasEdgeFromSemantic(edge: WorkflowSemanticEdge): Edge {
  const primaryRuntime = edge.runtimeEdges[0];
  if (!primaryRuntime) {
    throw new Error(`Presentation edge ${edge.id} has no runtime projection.`);
  }
  const canvasEdge: Edge = {
    id: edge.id,
    source: edge.visualSource,
    target: edge.visualTarget,
    sourceHandle: edge.sourcePort,
    targetHandle: edge.targetPort,
    type: "smoothstep",
    data: {
      edgeKind: edge.kind,
      condition: edge.condition ?? null,
      runtimeSource: primaryRuntime.source,
      runtimeTarget: primaryRuntime.target,
      runtimeSourceKind: primaryRuntime.sourceKind,
      runtimeTargetKind: primaryRuntime.targetKind,
      runtimeEdges: edge.runtimeEdges,
      ...(edge.binding ? { binding: edge.binding } : {}),
      ...(edge.membership
        ? {
            compositeNodeId: edge.membership.compositeNodeId,
            memberNodeId: edge.membership.memberNodeId,
            membershipRole: edge.membership.role,
          }
        : {}),
    },
    markerEnd: { type: MarkerType.ArrowClosed },
  };
  return edge.kind === "trigger"
    ? decorateTriggerEdge(canvasEdge)
    : decorateEdge(canvasEdge);
}

function defaultPortId(
  node: Node<WorkflowCanvasNodeData>,
  direction: "input" | "output",
  kind: WorkflowSemanticEdge["kind"],
) {
  return (
    node.data.definition.ports.find(
      (port) =>
        port.direction === direction && port.connectionKinds.includes(kind),
    )?.id ?? (direction === "input" ? "workflow-in" : "workflow-out")
  );
}

function actionDisplayName(action: ActionPackage) {
  return String(action.manifest.displayName ?? action.name);
}

function actionMaturity(action: ActionPackage) {
  const catalog = action.manifest.catalog as JsonObject | undefined;
  return String(catalog?.maturity ?? "experimental");
}

function stringDataValue(edge: Edge, key: string) {
  const data = edge.data;
  if (!data || typeof data !== "object") {
    return "";
  }
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function defaultPlacement(manifest: JsonObject) {
  const execution = manifest.execution as JsonObject | undefined;
  const placements = Array.isArray(execution?.supportedPlacements)
    ? execution.supportedPlacements.map(String)
    : [];
  return placements[0] ?? "local-workers";
}
