/**
 * Browser-safe workflow graph semantics shared by the Studio and API.
 *
 * The API still persists action steps and dependency edges. This module models
 * the richer presentation graph and owns the explicit projection between both
 * representations.
 */

export const BEAM_TRANSFER_ACTION = "@beam/transfer";
export const OBJECT_STORAGE_ENDPOINT_ACTION = "@beam/object-storage-endpoint";
export const UPLOAD_ACTION = "@beam/upload";

export type WorkflowNodeKind =
  | "trigger"
  | "action"
  | "resource"
  | "control"
  | "gateway"
  | "composite"
  | "subworkflow"
  | "wait"
  | "human"
  | "interface"
  | "annotation"
  | "group";

export type WorkflowEdgeKind =
  | "flow"
  | "data"
  | "binding"
  | "trigger"
  | "event"
  | "error"
  | "membership";

export type WorkflowPortDefinition = {
  id: string;
  direction: "input" | "output";
  connectionKinds: WorkflowEdgeKind[];
  dataType?: string;
  cardinality?: "one" | "many";
  required?: boolean;
  label?: string;
  binding?: {
    inputKey: string;
    outputKey: string;
    mode: "replace" | "append";
  };
};

export type WorkflowNodeDefinition = {
  kind: WorkflowNodeKind;
  executable: boolean;
  semantics: "runtime" | "declarative" | "visual";
  presentation: "card" | "pill" | "resource" | "composite" | "control";
  ports: WorkflowPortDefinition[];
  validation: {
    allowsTriggerTarget: boolean;
  };
  capabilities: {
    configurable?: boolean;
    duplicable?: boolean;
    removable?: boolean;
    groupable?: boolean;
    canContainNodes?: boolean;
  };
};

export type WorkflowSemanticNode = {
  id: string;
  definition: WorkflowNodeDefinition;
  enabled: boolean;
  actionPackageName?: string;
  inputBindings?: Record<string, unknown>;
};

export type WorkflowRuntimeEdgeProjection = {
  id: string;
  source: string;
  target: string;
  sourceKind: "trigger" | "step" | "control";
  targetKind: "step" | "control";
  dependency: boolean;
};

export type WorkflowBindingProjection = {
  sourceNodeId: string;
  sourceOutput: string;
  targetNodeId: string;
  targetInput: string;
  mode: "replace" | "append";
};

export type WorkflowSemanticEdge = {
  id: string;
  kind: WorkflowEdgeKind;
  visualSource: string;
  visualTarget: string;
  sourcePort: string;
  targetPort: string;
  runtimeEdges: WorkflowRuntimeEdgeProjection[];
  binding?: WorkflowBindingProjection;
  membership?: {
    compositeNodeId: string;
    memberNodeId: string;
    role?: string;
  };
  condition?: unknown;
};

export type WorkflowSemanticGraph = {
  nodes: WorkflowSemanticNode[];
  edges: WorkflowSemanticEdge[];
};

export type PersistedWorkflowEdgeLike = {
  id: string;
  fromStepId: string;
  toStepId: string;
  condition?: unknown;
};

export type PersistedTriggerEdgeLike = {
  id: string;
  triggerId: string;
  toStepId: string;
  condition?: unknown;
};

export type WorkflowConnection = {
  source: string;
  target: string;
  sourcePort?: string | null;
  targetPort?: string | null;
};

export type NodePatch = {
  nodeId: string;
  patch: Record<string, unknown>;
};

export type BindingPatch = WorkflowBindingProjection;

export type ConnectionPlan = {
  accepted: boolean;
  reason?: string;
  visualEdges: WorkflowSemanticEdge[];
  runtimeEdges: WorkflowSemanticEdge[];
  nodePatches: NodePatch[];
  bindingPatches: BindingPatch[];
};

const workflowInputPort: WorkflowPortDefinition = {
  id: "workflow-in",
  direction: "input",
  connectionKinds: ["flow", "data", "binding", "trigger", "event", "error"],
  cardinality: "many",
  label: "Workflow input",
};

const workflowOutputPort: WorkflowPortDefinition = {
  id: "workflow-out",
  direction: "output",
  connectionKinds: ["flow", "data", "event", "error"],
  cardinality: "many",
  label: "Workflow output",
};

const actionDefinition = Object.freeze<WorkflowNodeDefinition>({
  kind: "action",
  executable: true,
  semantics: "runtime",
  presentation: "card",
  ports: [workflowInputPort, workflowOutputPort],
  capabilities: {
    configurable: true,
    duplicable: true,
    removable: true,
    groupable: true,
  },
  validation: { allowsTriggerTarget: true },
});

const triggerDefinition = Object.freeze<WorkflowNodeDefinition>({
  kind: "trigger",
  executable: false,
  semantics: "declarative",
  presentation: "pill",
  ports: [
    {
      id: "trigger-out",
      direction: "output",
      connectionKinds: ["trigger", "event"],
      cardinality: "many",
      label: "Start",
    },
  ],
  capabilities: {
    configurable: true,
    duplicable: true,
    removable: true,
  },
  validation: { allowsTriggerTarget: false },
});

const resourceDefinition = Object.freeze<WorkflowNodeDefinition>({
  kind: "resource",
  executable: true,
  semantics: "runtime",
  presentation: "resource",
  ports: [
    {
      id: "resource-in",
      direction: "input",
      connectionKinds: ["binding", "data"],
      cardinality: "one",
      label: "Resource target",
    },
    {
      id: "resource-out",
      direction: "output",
      connectionKinds: ["binding", "data"],
      dataType: "endpoint",
      cardinality: "many",
      label: "Resource",
    },
  ],
  capabilities: {
    configurable: true,
    duplicable: true,
    removable: true,
    groupable: true,
  },
  validation: { allowsTriggerTarget: false },
});

const transferCompositeDefinition = Object.freeze<WorkflowNodeDefinition>({
  kind: "composite",
  executable: true,
  semantics: "runtime",
  presentation: "composite",
  ports: [
    workflowInputPort,
    workflowOutputPort,
    {
      id: "source-endpoints",
      direction: "input",
      connectionKinds: ["binding"],
      dataType: "endpoint",
      cardinality: "many",
      label: "Sources",
      binding: {
        inputKey: "sourceEndpoints",
        outputKey: "endpoint",
        mode: "append",
      },
    },
    {
      id: "destination-endpoints",
      direction: "output",
      connectionKinds: ["binding"],
      dataType: "endpoint",
      cardinality: "many",
      label: "Destinations",
      binding: {
        inputKey: "destinationEndpoints",
        outputKey: "endpoint",
        mode: "append",
      },
    },
  ],
  capabilities: {
    configurable: true,
    duplicable: true,
    removable: true,
    groupable: true,
    canContainNodes: true,
  },
  validation: { allowsTriggerTarget: true },
});

const uploadDefinition = Object.freeze<WorkflowNodeDefinition>({
  ...actionDefinition,
  ports: [
    workflowInputPort,
    workflowOutputPort,
    {
      id: "destination-endpoint",
      direction: "output",
      connectionKinds: ["binding"],
      dataType: "endpoint",
      cardinality: "one",
      label: "Destination",
      binding: {
        inputKey: "endpoint",
        outputKey: "endpoint",
        mode: "replace",
      },
    },
  ],
});

const controlDefinition = Object.freeze<WorkflowNodeDefinition>({
  kind: "control",
  executable: false,
  semantics: "declarative",
  presentation: "control",
  ports: [workflowInputPort, workflowOutputPort],
  capabilities: {
    configurable: true,
    duplicable: true,
    removable: true,
    canContainNodes: true,
  },
  validation: { allowsTriggerTarget: false },
});

export const DECISION_TRUE_PORT = "decision-true";
export const DECISION_FALSE_PORT = "decision-false";
export const SWITCH_DEFAULT_PORT = "default";

export function switchCasePort(caseId: string) {
  return `case:${caseId}` as const;
}

/**
 * A decision joins several inputs and routes to one of two branches. Both
 * outputs carry ordinary flow edges; which one an edge leaves by is persisted
 * on the edge itself, because port identity does not survive the graph
 * projection.
 */
const decisionDefinition = Object.freeze<WorkflowNodeDefinition>({
  kind: "gateway",
  executable: false,
  semantics: "declarative",
  presentation: "control",
  ports: [
    workflowInputPort,
    {
      id: DECISION_TRUE_PORT,
      direction: "output",
      connectionKinds: ["flow"],
      cardinality: "many",
      label: "True",
    },
    {
      id: DECISION_FALSE_PORT,
      direction: "output",
      connectionKinds: ["flow"],
      cardinality: "many",
      label: "False",
    },
  ],
  capabilities: {
    configurable: true,
    duplicable: true,
    removable: true,
  },
  validation: { allowsTriggerTarget: false },
});

/** A Switch has ordered case outputs plus one mandatory Default output. */
export function workflowSwitchNodeDefinition(
  cases: ReadonlyArray<{ id: string; name: string }>,
): WorkflowNodeDefinition {
  return {
    ...decisionDefinition,
    ports: [
      workflowInputPort,
      ...cases.map((entry) => ({
        id: switchCasePort(entry.id),
        direction: "output" as const,
        connectionKinds: ["flow" as const],
        cardinality: "one" as const,
        label: entry.name,
      })),
      {
        id: SWITCH_DEFAULT_PORT,
        direction: "output",
        connectionKinds: ["flow"],
        cardinality: "one",
        required: true,
        label: "Default",
      },
    ],
  };
}

function preparedDefinition(
  kind: WorkflowNodeKind,
  input: Pick<
    WorkflowNodeDefinition,
    "executable" | "semantics" | "presentation"
  > & {
    ports?: WorkflowPortDefinition[];
    canContainNodes?: boolean;
    allowsTriggerTarget?: boolean;
  },
): WorkflowNodeDefinition {
  return Object.freeze({
    kind,
    executable: input.executable,
    semantics: input.semantics,
    presentation: input.presentation,
    ports: input.ports ?? [],
    capabilities: {
      configurable: true,
      duplicable: true,
      removable: true,
      groupable: true,
      canContainNodes: input.canContainNodes,
    },
    validation: {
      allowsTriggerTarget: input.allowsTriggerTarget ?? input.executable,
    },
  });
}

const nodeDefinitions: Record<WorkflowNodeKind, WorkflowNodeDefinition> = {
  trigger: triggerDefinition,
  action: actionDefinition,
  resource: resourceDefinition,
  control: controlDefinition,
  composite: transferCompositeDefinition,
  gateway: decisionDefinition,
  subworkflow: preparedDefinition("subworkflow", {
    executable: true,
    semantics: "runtime",
    presentation: "card",
    ports: [workflowInputPort, workflowOutputPort],
  }),
  wait: preparedDefinition("wait", {
    executable: true,
    semantics: "runtime",
    presentation: "card",
    ports: [workflowInputPort, workflowOutputPort],
  }),
  human: preparedDefinition("human", {
    executable: true,
    semantics: "runtime",
    presentation: "card",
    ports: [workflowInputPort, workflowOutputPort],
  }),
  interface: preparedDefinition("interface", {
    executable: false,
    semantics: "declarative",
    presentation: "pill",
    ports: [workflowInputPort, workflowOutputPort],
  }),
  annotation: preparedDefinition("annotation", {
    executable: false,
    semantics: "visual",
    presentation: "pill",
    allowsTriggerTarget: false,
  }),
  group: preparedDefinition("group", {
    executable: false,
    semantics: "visual",
    presentation: "composite",
    canContainNodes: true,
    allowsTriggerTarget: false,
  }),
};

const actionDefinitions = new Map<string, WorkflowNodeDefinition>([
  [BEAM_TRANSFER_ACTION, transferCompositeDefinition],
  [OBJECT_STORAGE_ENDPOINT_ACTION, resourceDefinition],
  [UPLOAD_ACTION, uploadDefinition],
]);

export function workflowNodeDefinition(input: {
  kind?: WorkflowNodeKind;
  actionPackageName?: string;
}): WorkflowNodeDefinition {
  return (
    (input.actionPackageName
      ? actionDefinitions.get(input.actionPackageName)
      : undefined) ?? nodeDefinitions[input.kind ?? "action"]
  );
}

export function resolveWorkflowPort(
  node: WorkflowSemanticNode,
  portId: string | null | undefined,
  direction: "input" | "output",
  kind?: WorkflowEdgeKind,
) {
  if (portId) {
    return node.definition.ports.find(
      (port) => port.id === portId && port.direction === direction,
    );
  }
  return node.definition.ports.find(
    (port) =>
      port.direction === direction &&
      (!kind || port.connectionKinds.includes(kind)),
  );
}

export function normalizeWorkflowEdges(input: {
  nodes: WorkflowSemanticNode[];
  edges: PersistedWorkflowEdgeLike[];
  triggerEdges?: PersistedTriggerEdgeLike[];
}): WorkflowSemanticEdge[] {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const runtimeEdges = input.edges.map((edge) => {
    const source = requiredNode(nodesById, edge.fromStepId, edge.id);
    const target = requiredNode(nodesById, edge.toStepId, edge.id);
    const binding = bindingBetween(source, target);
    if (
      binding &&
      (source.definition.kind === "resource" ||
        target.definition.ports.some(
          (port) => port.binding?.inputKey === binding.targetInput,
        ))
    ) {
      const compositePort = target.definition.ports.find(
        (port) => port.binding?.inputKey === binding.targetInput,
      );
      const destination = compositePort?.direction === "output";
      return {
        id: edge.id,
        kind: "binding" as const,
        visualSource: destination ? target.id : source.id,
        visualTarget: destination ? source.id : target.id,
        sourcePort: destination
          ? (compositePort?.id ?? "workflow-out")
          : "resource-out",
        targetPort: destination
          ? "resource-in"
          : (compositePort?.id ?? "workflow-in"),
        runtimeEdges: [runtimeProjection(edge, source, target)],
        binding,
        ...(target.definition.kind === "composite"
          ? {
              membership: {
                compositeNodeId: target.id,
                memberNodeId: source.id,
                role: binding.targetInput,
              },
            }
          : {}),
        condition: edge.condition ?? null,
      };
    }
    return {
      id: edge.id,
      kind: binding ? ("data" as const) : ("flow" as const),
      visualSource: source.id,
      visualTarget: target.id,
      sourcePort: "workflow-out",
      targetPort: "workflow-in",
      runtimeEdges: [runtimeProjection(edge, source, target)],
      ...(binding ? { binding } : {}),
      condition: edge.condition ?? null,
    };
  });

  const graph = { nodes: input.nodes, edges: runtimeEdges };
  const projectedTriggers = new Map<string, WorkflowSemanticEdge>();
  for (const edge of input.triggerEdges ?? []) {
    const trigger = requiredNode(nodesById, edge.triggerId, edge.id);
    const target = requiredNode(nodesById, edge.toStepId, edge.id);
    const visualTarget = compositeForEntryStep(target.id, graph) ?? target.id;
    const key = `${trigger.id}:${visualTarget}`;
    const existing = projectedTriggers.get(key);
    const projection: WorkflowRuntimeEdgeProjection = {
      id: edge.id,
      source: trigger.id,
      target: target.id,
      sourceKind: "trigger",
      targetKind: "step",
      dependency: false,
    };
    if (existing) {
      existing.runtimeEdges.push(projection);
      continue;
    }
    projectedTriggers.set(key, {
      id: edge.id,
      kind: "trigger",
      visualSource: trigger.id,
      visualTarget,
      sourcePort: "trigger-out",
      targetPort: "workflow-in",
      runtimeEdges: [projection],
      condition: edge.condition ?? null,
    });
  }
  return [...projectedTriggers.values(), ...runtimeEdges];
}

export function runtimeDependencies(graph: WorkflowSemanticGraph) {
  return graph.edges.flatMap((edge) =>
    edge.runtimeEdges.filter((runtimeEdge) => runtimeEdge.dependency),
  );
}

export function getWorkflowEntryStepIds(graph: WorkflowSemanticGraph) {
  const executableIds = new Set(
    graph.nodes
      .filter((node) => node.enabled && node.definition.executable)
      .map((node) => node.id),
  );
  const incoming = new Set(
    runtimeDependencies(graph)
      .filter(
        (edge) =>
          executableIds.has(edge.source) && executableIds.has(edge.target),
      )
      .map((edge) => edge.target),
  );
  return [...executableIds].filter((id) => !incoming.has(id));
}

export function getCompositeEntryStepIds(
  compositeNodeId: string,
  graph: WorkflowSemanticGraph,
) {
  const composite = graph.nodes.find((node) => node.id === compositeNodeId);
  if (!composite || composite.definition.kind !== "composite") return [];
  const memberIds = new Set<string>([compositeNodeId]);
  for (const edge of graph.edges) {
    if (edge.membership?.compositeNodeId === compositeNodeId) {
      memberIds.add(edge.membership.memberNodeId);
    }
  }
  const executableMembers = new Set(
    graph.nodes
      .filter(
        (node) =>
          memberIds.has(node.id) && node.enabled && node.definition.executable,
      )
      .map((node) => node.id),
  );
  const incoming = new Set(
    runtimeDependencies(graph)
      .filter(
        (edge) =>
          executableMembers.has(edge.source) &&
          executableMembers.has(edge.target),
      )
      .map((edge) => edge.target),
  );
  return [...executableMembers].filter((id) => !incoming.has(id));
}

export function triggerTargetsForPresentationEdge(
  edge: WorkflowSemanticEdge,
  graph: WorkflowSemanticGraph,
) {
  if (edge.kind !== "trigger") return [];
  const target = graph.nodes.find((node) => node.id === edge.visualTarget);
  if (!target) return [];
  return target.definition.kind === "composite"
    ? getCompositeEntryStepIds(target.id, graph)
    : [target.id];
}

export function validateTriggerTargets(input: {
  graph: WorkflowSemanticGraph;
  triggerEdges: Array<{ triggerId: string; toStepId: string }>;
  enabledTriggerIds?: ReadonlySet<string>;
}) {
  const entryIds = new Set(getWorkflowEntryStepIds(input.graph));
  const errors: string[] = [];
  for (const edge of input.triggerEdges) {
    if (
      input.enabledTriggerIds &&
      !input.enabledTriggerIds.has(edge.triggerId)
    ) {
      continue;
    }
    if (!entryIds.has(edge.toStepId)) {
      errors.push(
        `Trigger ${edge.triggerId} must connect to an entry step; ${edge.toStepId} has a runtime dependency.`,
      );
    }
  }
  return errors;
}

/**
 * Beam Transfer copies one object from each source endpoint. A folder names a
 * prefix rather than an object, so a transfer from it fails when BeamCore
 * creates the transfer. Destinations may be folders.
 */
export const BEAM_TRANSFER_FOLDER_SOURCE_ISSUE =
  "Beam Transfer copies one object from each source. Choose a file, not a folder.";

export type WorkflowEndpointStepLike = {
  id: string;
  actionPackageName: string;
  config: Record<string, unknown>;
  inputBindings: Record<string, unknown>;
};

const STEP_ENDPOINT_OUTPUT = /^\$\{\s*steps\.([^.}\s]+)\.outputs\.endpoint\s*\}$/;

/** Whether an object storage endpoint's configuration names a folder. */
export function isFolderEndpointConfig(config: Record<string, unknown>) {
  return (
    config.sourceType === "directory" ||
    String(config.objectKey ?? "")
      .trim()
      .endsWith("/")
  );
}

/** Ids of the steps bound to a Beam Transfer step's source endpoints. */
export function beamTransferSourceEndpointIds(
  steps: readonly WorkflowEndpointStepLike[],
) {
  const ids = new Set<string>();
  for (const step of steps) {
    if (step.actionPackageName !== BEAM_TRANSFER_ACTION) continue;
    const value = step.inputBindings.sourceEndpoints;
    for (const expression of Array.isArray(value) ? value : [value]) {
      const match =
        typeof expression === "string"
          ? STEP_ENDPOINT_OUTPUT.exec(expression.trim())
          : null;
      if (match?.[1]) ids.add(match[1]);
    }
  }
  return ids;
}

/** Object storage endpoints that feed a Beam Transfer source but name a folder. */
export function beamTransferFolderSources<T extends WorkflowEndpointStepLike>(
  steps: readonly T[],
): T[] {
  const sourceIds = beamTransferSourceEndpointIds(steps);
  return steps.filter(
    (step) =>
      sourceIds.has(step.id) &&
      step.actionPackageName === OBJECT_STORAGE_ENDPOINT_ACTION &&
      isFolderEndpointConfig(step.config),
  );
}

export function planWorkflowConnection(input: {
  connection: WorkflowConnection;
  nodes: WorkflowSemanticNode[];
  edges: WorkflowSemanticEdge[];
  createId?: (prefix: string) => string;
}): ConnectionPlan {
  const reject = (reason: string): ConnectionPlan => ({
    accepted: false,
    reason,
    visualEdges: [],
    runtimeEdges: [],
    nodePatches: [],
    bindingPatches: [],
  });
  const source = input.nodes.find(
    (node) => node.id === input.connection.source,
  );
  const target = input.nodes.find(
    (node) => node.id === input.connection.target,
  );
  if (!source || !target)
    return reject("Connection references a missing node.");
  if (source.id === target.id)
    return reject("A node cannot connect to itself.");

  const requestedKind = connectionKindFor(source, target, input.connection);
  if (!requestedKind) {
    return reject(
      `A ${source.definition.kind} node cannot connect to a ${target.definition.kind} node.`,
    );
  }
  // A gateway has semantically distinct outputs, so never silently fall back
  // to whichever output happens to be first.
  if (source.definition.kind === "gateway" && !input.connection.sourcePort) {
    return reject("Connect from a specific gateway output.");
  }
  const sourcePort = resolveWorkflowPort(
    source,
    input.connection.sourcePort,
    "output",
    requestedKind,
  );
  const targetPort = resolveWorkflowPort(
    target,
    requestedKind === "trigger" ? undefined : input.connection.targetPort,
    "input",
    requestedKind,
  );
  if (!sourcePort) {
    return reject("The selected source port does not accept this connection.");
  }
  if (!targetPort) {
    return reject("The selected target port does not accept this connection.");
  }
  if (
    !sourcePort.connectionKinds.includes(requestedKind) ||
    !targetPort.connectionKinds.includes(requestedKind)
  ) {
    return reject("The selected ports have incompatible connection types.");
  }
  if (
    input.edges.some(
      (edge) =>
        edge.visualSource === source.id &&
        edge.visualTarget === target.id &&
        edge.sourcePort === sourcePort.id &&
        edge.targetPort === targetPort.id,
    )
  ) {
    return reject("This connection already exists.");
  }
  if (
    targetPort.cardinality === "one" &&
    input.edges.some(
      (edge) =>
        edge.visualTarget === target.id && edge.targetPort === targetPort.id,
    )
  ) {
    return reject(
      `Port “${targetPort.label ?? targetPort.id}” accepts one connection.`,
    );
  }

  const graph = { nodes: input.nodes, edges: input.edges };
  if (requestedKind === "trigger") {
    if (!target.definition.validation.allowsTriggerTarget) {
      return reject(`A trigger cannot start a ${target.definition.kind} node.`);
    }
    if (!target.enabled)
      return reject("A trigger cannot start a disabled node.");
    const entryIds = new Set(getWorkflowEntryStepIds(graph));
    const targetEntries =
      target.definition.kind === "composite"
        ? getCompositeEntryStepIds(target.id, graph)
        : [target.id];
    if (
      !targetEntries.length ||
      targetEntries.some((id) => !entryIds.has(id))
    ) {
      return reject("A trigger must connect to a workflow entry point.");
    }
  }

  const idFactory = input.createId ?? ((prefix) => `${prefix}_${randomId()}`);
  const id = idFactory(requestedKind === "trigger" ? "wfte" : "wfe");
  const binding = bindingForPorts(source, sourcePort, target, targetPort);
  let runtimeSource = source.id;
  let runtimeTarget = target.id;
  if (
    requestedKind === "binding" &&
    source.definition.kind === "composite" &&
    target.definition.kind === "resource"
  ) {
    runtimeSource = target.id;
    runtimeTarget = source.id;
  }
  const edge: WorkflowSemanticEdge = {
    id,
    kind: requestedKind,
    visualSource: source.id,
    visualTarget: target.id,
    sourcePort: sourcePort.id,
    targetPort: targetPort.id,
    runtimeEdges:
      requestedKind === "trigger"
        ? triggerTargetsForNode(id, source.id, target, graph)
        : [
            {
              id,
              source: runtimeSource,
              target: runtimeTarget,
              sourceKind:
                source.definition.kind === "control" ? "control" : "step",
              targetKind:
                target.definition.kind === "control" ? "control" : "step",
              dependency: requestedKind !== "membership",
            },
          ],
    ...(binding ? { binding } : {}),
    ...(requestedKind === "binding" &&
    (source.definition.kind === "composite" ||
      target.definition.kind === "composite")
      ? {
          membership: {
            compositeNodeId:
              source.definition.kind === "composite" ? source.id : target.id,
            memberNodeId:
              source.definition.kind === "resource" ? source.id : target.id,
            role: sourcePort.binding?.inputKey ?? targetPort.binding?.inputKey,
          },
        }
      : {}),
    condition: null,
  };
  return {
    accepted: true,
    visualEdges: [edge],
    runtimeEdges: [edge],
    nodePatches: [],
    bindingPatches: binding ? [binding] : [],
  };
}

export function presentationDirectionForRuntimeEdge(
  edge: WorkflowSemanticEdge,
) {
  return {
    source: edge.visualSource,
    target: edge.visualTarget,
    reversed: edge.runtimeEdges.some(
      (runtime) =>
        runtime.source === edge.visualTarget &&
        runtime.target === edge.visualSource,
    ),
  };
}

function runtimeProjection(
  edge: PersistedWorkflowEdgeLike,
  source: WorkflowSemanticNode,
  target: WorkflowSemanticNode,
): WorkflowRuntimeEdgeProjection {
  return {
    id: edge.id,
    source: source.id,
    target: target.id,
    sourceKind: source.definition.kind === "control" ? "control" : "step",
    targetKind: target.definition.kind === "control" ? "control" : "step",
    dependency: true,
  };
}

function requiredNode(
  nodes: ReadonlyMap<string, WorkflowSemanticNode>,
  id: string,
  edgeId: string,
) {
  const node = nodes.get(id);
  if (!node) {
    throw new Error(`Edge ${edgeId} references missing node ${id}.`);
  }
  return node;
}

function bindingBetween(
  source: WorkflowSemanticNode,
  target: WorkflowSemanticNode,
): WorkflowBindingProjection | undefined {
  const expression = bindingExpression(source.id, "endpoint");
  for (const [inputKey, value] of Object.entries(target.inputBindings ?? {})) {
    if (bindingContains(value, expression)) {
      return {
        sourceNodeId: source.id,
        sourceOutput: "endpoint",
        targetNodeId: target.id,
        targetInput: inputKey,
        mode: Array.isArray(value) ? "append" : "replace",
      };
    }
  }
  return undefined;
}

function bindingForPorts(
  source: WorkflowSemanticNode,
  sourcePort: WorkflowPortDefinition,
  target: WorkflowSemanticNode,
  targetPort: WorkflowPortDefinition,
): WorkflowBindingProjection | undefined {
  const portBinding = sourcePort.binding ?? targetPort.binding;
  if (!portBinding) return undefined;
  const composite = sourcePort.binding ? source : target;
  const resource = source.definition.kind === "resource" ? source : target;
  return {
    sourceNodeId: resource.id,
    sourceOutput: portBinding.outputKey,
    targetNodeId: composite.id,
    targetInput: portBinding.inputKey,
    mode: portBinding.mode,
  };
}

function connectionKindFor(
  source: WorkflowSemanticNode,
  target: WorkflowSemanticNode,
  connection: WorkflowConnection,
): WorkflowEdgeKind | undefined {
  if (source.definition.kind === "trigger") return "trigger";
  const explicitSource = connection.sourcePort
    ? source.definition.ports.find((port) => port.id === connection.sourcePort)
    : undefined;
  const explicitTarget = connection.targetPort
    ? target.definition.ports.find((port) => port.id === connection.targetPort)
    : undefined;
  if (
    source.definition.kind === "resource" ||
    target.definition.kind === "resource" ||
    explicitSource?.binding ||
    explicitTarget?.binding
  ) {
    return "binding";
  }
  if (participatesInFlow(source) && participatesInFlow(target)) {
    return "flow";
  }
  return undefined;
}

/** Nodes that can sit on a flow edge: runnable steps, control regions, gateways. */
function participatesInFlow(node: WorkflowSemanticNode) {
  return (
    node.definition.executable ||
    node.definition.kind === "control" ||
    node.definition.kind === "gateway"
  );
}

function triggerTargetsForNode(
  edgeId: string,
  triggerId: string,
  target: WorkflowSemanticNode,
  graph: WorkflowSemanticGraph,
) {
  const targets =
    target.definition.kind === "composite"
      ? getCompositeEntryStepIds(target.id, graph)
      : [target.id];
  return targets.map((targetId, index) => ({
    id: index ? `${edgeId}__${targetId}` : edgeId,
    source: triggerId,
    target: targetId,
    sourceKind: "trigger" as const,
    targetKind: "step" as const,
    dependency: false,
  }));
}

function compositeForEntryStep(stepId: string, graph: WorkflowSemanticGraph) {
  for (const node of graph.nodes) {
    if (
      node.definition.kind === "composite" &&
      getCompositeEntryStepIds(node.id, graph).includes(stepId)
    ) {
      return node.id;
    }
  }
  return undefined;
}

function bindingExpression(sourceId: string, output: string) {
  return `\${steps.${sourceId}.outputs.${output}}`;
}

function bindingContains(value: unknown, expression: string) {
  return Array.isArray(value)
    ? value.includes(expression)
    : value === expression;
}

function randomId() {
  return (
    globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 12) ??
    Math.random().toString(36).slice(2, 14)
  );
}
