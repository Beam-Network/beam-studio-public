import type { ActionJson } from "./actions.js";

export const WORKFLOW_GRAPH_V2 = "workflow-graph/v2" as const;

export type WorkflowGraphV2Limits = {
  defaultFanOutConcurrency: number;
  maxDynamicNestingDepth: number;
  maxExpandedActionInstances: number;
  maxFanOutConcurrency: number;
  maxFanOutItems: number;
  maxLoopIterations: number;
};

export const workflowGraphV2Limits: WorkflowGraphV2Limits = Object.freeze({
  defaultFanOutConcurrency: 10,
  maxDynamicNestingDepth: 1,
  maxExpandedActionInstances: 100_000,
  maxFanOutConcurrency: 100,
  maxFanOutItems: 10_000,
  maxLoopIterations: 1_000,
});

export type WorkflowGraphV2Edge = {
  id?: string;
  from: string;
  to: string;
  condition?: ActionJson;
};

export type WorkflowGraphV2Body = {
  stepIds: string[];
  entryStepId: string;
  outputStepId: string;
  edges: WorkflowGraphV2Edge[];
};

export type WorkflowGraphV2ControlLayout = {
  x: number;
  y: number;
  width?: number;
  height?: number;
  fanInX?: number;
  fanInY?: number;
};

export type WorkflowGraphV2Loop = {
  id: string;
  kind: "loop";
  iterations: ActionJson;
  outputMode?: "all" | "last";
  layout?: WorkflowGraphV2ControlLayout;
  body: WorkflowGraphV2Body;
};

export type WorkflowGraphV2FanOut = {
  id: string;
  kind: "fan-out";
  items: ActionJson;
  concurrency?: number;
  fanInId: string;
  layout?: WorkflowGraphV2ControlLayout;
  body: WorkflowGraphV2Body;
};

export type WorkflowGraphV2Control =
  | WorkflowGraphV2Loop
  | WorkflowGraphV2FanOut;

export type WorkflowGraphV2Definition = {
  version: typeof WORKFLOW_GRAPH_V2;
  controls: WorkflowGraphV2Control[];
  edges: WorkflowGraphV2Edge[];
};

export type WorkflowGraphV1Definition = {
  version: "workflow-graph/v1";
  edges: WorkflowGraphV2Edge[];
};

export type WorkflowGraphValidationStep = {
  id: string;
  enabled: boolean;
};

export type DynamicInstanceCoordinate = {
  workflowRunId: string;
  controlPath: string;
  workflowStepId: string;
  instanceIndex: number;
};

export type WorkflowDynamicBindingContext = Record<
  string,
  {
    index: number;
    iteration?: number;
    item?: ActionJson;
    previous?: ActionJson;
  }
>;

export type WorkflowConditionTrace = {
  outcome: "taken" | "skipped" | "not_reached";
  result: boolean | null;
  reason:
    | "condition_true"
    | "condition_false"
    | "unconditional"
    | "upstream_failed"
    | "upstream_skipped"
    | "upstream_cancelled"
    | "upstream_not_reached";
};

export function dynamicInstanceKey(input: DynamicInstanceCoordinate) {
  return [
    input.workflowRunId,
    input.controlPath,
    input.workflowStepId,
    String(input.instanceIndex),
  ]
    .map(encodeIdentityPart)
    .join(":");
}

export function dynamicAttemptKey(
  input: DynamicInstanceCoordinate & { attempt: number },
) {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new WorkflowGraphV2ValidationError(
      "Dynamic action attempt must be a positive integer.",
    );
  }
  return `${dynamicInstanceKey(input)}:attempt:${input.attempt}`;
}

export function resolveDynamicGraphValue(
  value: ActionJson,
  context: WorkflowDynamicBindingContext,
): ActionJson {
  if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
    const expression = value.slice(2, -1);
    if (expression.startsWith("graph.")) {
      const [, controlId, field, ...path] = expression.split(".");
      const control = controlId ? context[controlId] : undefined;
      if (!control || !field || !(field in control)) {
        throw new WorkflowGraphV2ValidationError(
          `Dynamic binding expression "${value}" is unavailable in this control context.`,
        );
      }
      return dynamicPathValue(
        control[field as keyof typeof control] as ActionJson,
        path,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveDynamicGraphValue(entry, context));
  }
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, "$literal"))
      return structuredClone(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveDynamicGraphValue(entry, context),
      ]),
    );
  }
  return value;
}

export function conditionTraceForEvaluation(input: {
  conditionPresent: boolean;
  result?: boolean;
  upstreamStatus?: string;
}): WorkflowConditionTrace {
  if (input.upstreamStatus === "failed") {
    return {
      outcome: "not_reached",
      result: null,
      reason: "upstream_failed",
    };
  }
  if (input.upstreamStatus === "cancelled") {
    return {
      outcome: "not_reached",
      result: null,
      reason: "upstream_cancelled",
    };
  }
  if (input.upstreamStatus === "skipped") {
    return {
      outcome: "not_reached",
      result: null,
      reason: "upstream_skipped",
    };
  }
  if (input.upstreamStatus === "not_reached") {
    return {
      outcome: "not_reached",
      result: null,
      reason: "upstream_not_reached",
    };
  }
  if (!input.conditionPresent) {
    return { outcome: "taken", result: true, reason: "unconditional" };
  }
  return input.result
    ? { outcome: "taken", result: true, reason: "condition_true" }
    : { outcome: "skipped", result: false, reason: "condition_false" };
}

export function convertWorkflowGraphV1ToV2(input: {
  edges: WorkflowGraphV2Edge[];
}): WorkflowGraphV2Definition {
  return {
    version: WORKFLOW_GRAPH_V2,
    controls: [],
    edges: input.edges.map(cloneEdge),
  };
}

export function validateWorkflowGraphV2(
  definition: WorkflowGraphV2Definition,
  steps: WorkflowGraphValidationStep[],
  limits: WorkflowGraphV2Limits = workflowGraphV2Limits,
) {
  if (definition.version !== WORKFLOW_GRAPH_V2) {
    throw new WorkflowGraphV2ValidationError(
      `Unsupported workflow graph version "${String(definition.version)}".`,
    );
  }

  const activeStepIds = new Set(
    steps.filter((step) => step.enabled).map((step) => step.id),
  );
  if (activeStepIds.size !== steps.filter((step) => step.enabled).length) {
    throw new WorkflowGraphV2ValidationError(
      "Workflow graph contains duplicate active step identifiers.",
    );
  }

  const nodeIds = new Set(activeStepIds);
  const controlIds = new Set<string>();
  const ownedStepIds = new Set<string>();
  const exitNodeByControlId = new Map<string, string>();

  for (const control of definition.controls) {
    assertIdentifier(control.id, "control");
    if (nodeIds.has(control.id) || controlIds.has(control.id)) {
      throw new WorkflowGraphV2ValidationError(
        `Dynamic control id "${control.id}" is duplicated or collides with a workflow step.`,
      );
    }
    controlIds.add(control.id);
    nodeIds.add(control.id);

    if (control.kind === "fan-out") {
      assertIdentifier(control.fanInId, "fan-in");
      if (nodeIds.has(control.fanInId) || controlIds.has(control.fanInId)) {
        throw new WorkflowGraphV2ValidationError(
          `Fan-in id "${control.fanInId}" is duplicated or collides with another graph node.`,
        );
      }
      controlIds.add(control.fanInId);
      nodeIds.add(control.fanInId);
      exitNodeByControlId.set(control.id, control.fanInId);
      validateFanOut(control, limits);
    } else if (control.kind === "loop") {
      exitNodeByControlId.set(control.id, control.id);
      validateLoop(control, limits);
    } else {
      const exhaustive: never = control;
      throw new WorkflowGraphV2ValidationError(
        `Unknown dynamic control kind "${String((exhaustive as { kind?: unknown }).kind)}".`,
      );
    }

    validateBody(control, activeStepIds, ownedStepIds);
  }

  for (const stepId of ownedStepIds) {
    nodeIds.delete(stepId);
  }

  validateEdgeSet(definition.edges, nodeIds, "top-level graph");
  validateControlBoundaries(definition, exitNodeByControlId);

  const staticTopLevelInstances = [...nodeIds].filter(
    (nodeId) => !controlIds.has(nodeId),
  ).length;
  let maximumExpandedInstances = staticTopLevelInstances;
  for (const control of definition.controls) {
    const literalSize =
      control.kind === "loop"
        ? literalLoopCount(control.iterations)
        : Array.isArray(control.items)
          ? control.items.length
          : control.kind === "fan-out"
            ? limits.maxFanOutItems
            : 0;
    maximumExpandedInstances += literalSize * control.body.stepIds.length;
  }
  if (maximumExpandedInstances > limits.maxExpandedActionInstances) {
    throw new WorkflowGraphV2ValidationError(
      `Workflow graph can expand to ${maximumExpandedInstances} action instances, exceeding the limit of ${limits.maxExpandedActionInstances}.`,
    );
  }

  return {
    maximumExpandedInstances,
    ownedStepIds,
  };
}

export function resolveLoopIterations(
  value: ActionJson,
  limits: WorkflowGraphV2Limits = workflowGraphV2Limits,
) {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new WorkflowGraphV2ValidationError(
      "Loop iteration count must resolve to a positive integer.",
    );
  }
  if (value > limits.maxLoopIterations) {
    throw new WorkflowGraphV2ValidationError(
      `Loop iteration count ${value} exceeds the limit of ${limits.maxLoopIterations}.`,
    );
  }
  return value;
}

export function resolveFanOutItems(
  value: ActionJson,
  limits: WorkflowGraphV2Limits = workflowGraphV2Limits,
) {
  if (!Array.isArray(value)) {
    throw new WorkflowGraphV2ValidationError(
      "Fan-out input must resolve to an array.",
    );
  }
  if (value.length > limits.maxFanOutItems) {
    throw new WorkflowGraphV2ValidationError(
      `Fan-out item count ${value.length} exceeds the limit of ${limits.maxFanOutItems}.`,
    );
  }
  return value;
}

export class WorkflowGraphV2ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowGraphV2ValidationError";
  }
}

function validateLoop(
  control: WorkflowGraphV2Loop,
  limits: WorkflowGraphV2Limits,
) {
  if (typeof control.iterations === "number") {
    resolveLoopIterations(control.iterations, limits);
  } else if (!isBindingExpression(control.iterations)) {
    throw new WorkflowGraphV2ValidationError(
      `Loop "${control.id}" iterations must be a positive integer or a binding expression.`,
    );
  }
  if (
    control.outputMode !== undefined &&
    control.outputMode !== "all" &&
    control.outputMode !== "last"
  ) {
    throw new WorkflowGraphV2ValidationError(
      `Loop "${control.id}" has an invalid output mode.`,
    );
  }
}

function validateFanOut(
  control: WorkflowGraphV2FanOut,
  limits: WorkflowGraphV2Limits,
) {
  if (Array.isArray(control.items)) {
    resolveFanOutItems(control.items, limits);
  } else if (!isBindingExpression(control.items)) {
    throw new WorkflowGraphV2ValidationError(
      `Fan-out "${control.id}" items must be an array or a binding expression.`,
    );
  }
  const concurrency =
    control.concurrency ?? limits.defaultFanOutConcurrency;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > limits.maxFanOutConcurrency
  ) {
    throw new WorkflowGraphV2ValidationError(
      `Fan-out "${control.id}" concurrency must be between 1 and ${limits.maxFanOutConcurrency}.`,
    );
  }
}

function validateBody(
  control: WorkflowGraphV2Control,
  activeStepIds: ReadonlySet<string>,
  ownedStepIds: Set<string>,
) {
  const bodyIds = new Set<string>();
  if (!control.body.stepIds.length) {
    throw new WorkflowGraphV2ValidationError(
      `Dynamic control "${control.id}" must own at least one action step.`,
    );
  }
  for (const stepId of control.body.stepIds) {
    if (!activeStepIds.has(stepId)) {
      throw new WorkflowGraphV2ValidationError(
        `Dynamic control "${control.id}" references unknown or disabled step "${stepId}".`,
      );
    }
    if (bodyIds.has(stepId)) {
      throw new WorkflowGraphV2ValidationError(
        `Dynamic control "${control.id}" contains duplicate step "${stepId}".`,
      );
    }
    if (ownedStepIds.has(stepId)) {
      throw new WorkflowGraphV2ValidationError(
        `Workflow step "${stepId}" is owned by more than one dynamic control.`,
      );
    }
    bodyIds.add(stepId);
    ownedStepIds.add(stepId);
  }
  if (!bodyIds.has(control.body.entryStepId)) {
    throw new WorkflowGraphV2ValidationError(
      `Dynamic control "${control.id}" entry step must belong to its body.`,
    );
  }
  if (!bodyIds.has(control.body.outputStepId)) {
    throw new WorkflowGraphV2ValidationError(
      `Dynamic control "${control.id}" output step must belong to its body.`,
    );
  }
  validateEdgeSet(
    control.body.edges,
    bodyIds,
    `dynamic control "${control.id}" body`,
  );

  const incoming = incomingCounts(bodyIds, control.body.edges);
  const roots = [...incoming].filter(([, count]) => count === 0);
  if (roots.length !== 1 || roots[0]?.[0] !== control.body.entryStepId) {
    throw new WorkflowGraphV2ValidationError(
      `Dynamic control "${control.id}" body must have exactly one root matching entryStepId.`,
    );
  }
  const outgoing = new Set(control.body.edges.map((edge) => edge.from));
  const leaves = [...bodyIds].filter((stepId) => !outgoing.has(stepId));
  if (leaves.length !== 1 || leaves[0] !== control.body.outputStepId) {
    throw new WorkflowGraphV2ValidationError(
      `Dynamic control "${control.id}" body must have exactly one leaf matching outputStepId.`,
    );
  }
}

function validateControlBoundaries(
  definition: WorkflowGraphV2Definition,
  exitNodeByControlId: ReadonlyMap<string, string>,
) {
  for (const control of definition.controls) {
    const exitId = exitNodeByControlId.get(control.id) ?? control.id;
    const incoming = definition.edges.filter((edge) => edge.to === control.id);
    const outgoing = definition.edges.filter((edge) => edge.from === exitId);
    const illegalEntryOutput = definition.edges.some(
      (edge) => edge.from === control.id && control.kind === "fan-out",
    );
    const illegalExitInput =
      control.kind === "fan-out" &&
      definition.edges.some((edge) => edge.to === control.fanInId);
    if (illegalEntryOutput || illegalExitInput) {
      throw new WorkflowGraphV2ValidationError(
        `Fan-out "${control.id}" must enter through its fan-out node and leave through fan-in "${control.kind === "fan-out" ? control.fanInId : exitId}".`,
      );
    }
    if (!incoming.length && definition.edges.length > 0) {
      const hasOtherIncomingTargets = definition.edges.some(
        (edge) => edge.to !== control.id,
      );
      if (hasOtherIncomingTargets) {
        throw new WorkflowGraphV2ValidationError(
          `Dynamic control "${control.id}" is disconnected from the top-level graph.`,
        );
      }
    }
    if (!outgoing.length && definition.edges.length > 0) {
      const hasOtherOutgoingSources = definition.edges.some(
        (edge) => edge.from !== exitId,
      );
      if (hasOtherOutgoingSources) {
        throw new WorkflowGraphV2ValidationError(
          `Dynamic control "${control.id}" exit is disconnected from the top-level graph.`,
        );
      }
    }
  }
}

function validateEdgeSet(
  edges: WorkflowGraphV2Edge[],
  nodeIds: ReadonlySet<string>,
  label: string,
) {
  const keys = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const incoming = incomingCounts(nodeIds, []);
  for (const nodeId of nodeIds) {
    outgoing.set(nodeId, []);
  }
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new WorkflowGraphV2ValidationError(
        `${label} edge "${edge.from} -> ${edge.to}" crosses a region boundary or references an unknown node.`,
      );
    }
    if (edge.from === edge.to) {
      throw new WorkflowGraphV2ValidationError(
        `${label} edge "${edge.from} -> ${edge.to}" cannot target itself.`,
      );
    }
    const key = `${edge.from}\u0000${edge.to}`;
    if (keys.has(key)) {
      throw new WorkflowGraphV2ValidationError(
        `${label} edge "${edge.from} -> ${edge.to}" is duplicated.`,
      );
    }
    keys.add(key);
    outgoing.get(edge.from)?.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const current = ready.shift();
    if (!current) continue;
    visited += 1;
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  if (visited !== nodeIds.size) {
    throw new WorkflowGraphV2ValidationError(`${label} contains a cycle.`);
  }
}

function incomingCounts(
  nodeIds: ReadonlySet<string>,
  edges: WorkflowGraphV2Edge[],
) {
  const incoming = new Map([...nodeIds].map((nodeId) => [nodeId, 0]));
  for (const edge of edges) {
    if (incoming.has(edge.to)) {
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    }
  }
  return incoming;
}

function literalLoopCount(value: ActionJson) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : workflowGraphV2Limits.maxLoopIterations;
}

function isBindingExpression(value: ActionJson): value is string {
  return typeof value === "string" && /^\$\{[^}]+\}$/.test(value.trim());
}

function assertIdentifier(value: string, label: string) {
  if (!value.trim() || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new WorkflowGraphV2ValidationError(
      `Dynamic ${label} identifier "${value}" is invalid.`,
    );
  }
}

function cloneEdge(edge: WorkflowGraphV2Edge): WorkflowGraphV2Edge {
  return {
    ...(edge.id ? { id: edge.id } : {}),
    from: edge.from,
    to: edge.to,
    ...(edge.condition !== undefined ? { condition: edge.condition } : {}),
  };
}

function encodeIdentityPart(value: string) {
  return encodeURIComponent(value).replaceAll("%", "_");
}

function dynamicPathValue(value: ActionJson, path: string[]) {
  let current: ActionJson = value;
  for (const part of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      !(part in current)
    ) {
      return null;
    }
    current = (current as Record<string, ActionJson>)[part] ?? null;
  }
  return current;
}
