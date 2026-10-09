import type { Edge, Node } from "@xyflow/react";
import {
  resolveActionRoomContext,
  type WorkflowRoomContext,
} from "@beam-studio/shared";
import {
  validateWorkflowGraphV2,
  type WorkflowGraphV2Definition,
  type WorkflowGraphV2Edge,
} from "@beam-studio/core/workflows/graph-v2";
import { workflowPredicateError } from "@beam-studio/core/workflows/decisions";
import {
  BEAM_TRANSFER_FOLDER_SOURCE_ISSUE,
  beamTransferFolderSources,
  beamTransferSourceEndpointIds,
} from "@beam-studio/core/workflows/graph-semantics";
import { isStepMetadataField } from "@beam-studio/core/workflows/node-metadata";
import type { RegistryPackage } from "@/features/registry/registry-data";
import {
  BEAM_TRANSFER_ACTION,
  DOWNLOAD_ACTION,
  OBJECT_STORAGE_ENDPOINT_ACTION,
  UPLOAD_ACTION,
  isControlFlowAction,
} from "./workflow-graph-constants";
import {
  automaticBindingPlan,
  bindingExpression,
  bindingValueContains,
} from "./workflow-graph-bindings";
import {
  edgeRuntimeSource,
  edgeRuntimeTarget,
  edgeKindOf,
  isControlNode,
  isDecisionNode,
  isStepNode,
  isTriggerNode,
  toSavePayload,
} from "./workflow-graph-model";
import type {
  ActionPackage,
  JsonObject,
  WorkflowCanvasNodeData,
  WorkflowNodeData,
} from "./workflow-graph-types";

type ActionVersionValidation = {
  errors: string[];
  nodeIssues: Map<string, string[]>;
  warnings: string[];
};

export function validateGraph(
  nodes: Node<WorkflowCanvasNodeData>[],
  edges: Edge[],
  actionsByName: Map<string, ActionPackage>,
  workflowRoom?: WorkflowRoomContext | null,
) {
  const errors: string[] = [];
  const nodeIssues = new Map<string, string[]>();
  const stepNodes = nodes.filter(isStepNode);
  const triggerNodes = nodes.filter(isTriggerNode);
  const controlNodes = nodes.filter(isControlNode);
  const decisionNodes = nodes.filter(isDecisionNode);
  const nodeIds = new Set(stepNodes.map((node) => node.id));
  const controlIds = new Set(controlNodes.map((node) => node.id));
  const triggerIds = new Set(triggerNodes.map((node) => node.id));
  const decisionIds = new Set(decisionNodes.map((node) => node.id));

  for (const node of decisionNodes) {
    const issues: string[] = [];
    const inputs = edges.filter(
      (edge) =>
        edgeRuntimeTarget(edge) === node.id && edgeKindOf(edge) !== "trigger",
    );
    const outputs = edges.filter((edge) => edgeRuntimeSource(edge) === node.id);
    if (!inputs.length) {
      issues.push("Connect at least one step into this decision.");
    }
    if (node.data.kind === "switch") {
      if (!node.data.cases.length) issues.push("Add at least one Switch case.");
      const caseIds = new Set<string>();
      for (const entry of node.data.cases) {
        if (caseIds.has(entry.id)) {
          issues.push(`Case id ${entry.id} is duplicated.`);
        }
        caseIds.add(entry.id);
        const predicateError = workflowPredicateError(entry.predicate);
        if (predicateError) issues.push(`${entry.name}: ${predicateError}`);
      }
      const handles = outputs.map((edge) => edge.sourceHandle ?? "");
      if (!handles.includes("default")) {
        issues.push("Connect the mandatory Default output.");
      }
      for (const handle of handles) {
        if (
          handle !== "default" &&
          (!handle.startsWith("case:") || !caseIds.has(handle.slice(5)))
        ) {
          issues.push(
            `An edge references missing Switch output ${handle || "(none)"}.`,
          );
        }
      }
      for (const handle of new Set(handles)) {
        if (handles.filter((candidate) => candidate === handle).length > 1) {
          issues.push(`Switch output ${handle} has more than one edge.`);
        }
      }
    } else {
      const predicateError =
        node.data.predicate == null
          ? null
          : workflowPredicateError(node.data.predicate);
      if (predicateError) issues.push(predicateError);
      if (!outputs.length) {
        issues.push("Connect the True or False output to a step.");
      }
    }
    if (issues.length) {
      nodeIssues.set(node.id, issues);
      errors.push(...issues.map((issue) => `${node.id}: ${issue}`));
    }
  }
  if (nodes.length) {
    if (!stepNodes.length) {
      errors.push("Graph must contain at least one step.");
    }
    if (!triggerNodes.length) {
      errors.push("Graph must contain at least one trigger.");
    }
    if (
      triggerNodes.length &&
      !triggerNodes.some((node) => node.data.enabled)
    ) {
      errors.push("Graph must contain at least one enabled trigger.");
    }
  }
  for (const node of stepNodes) {
    const issues: string[] = [];
    if (node.data.kind !== "workflow") {
      try {
        resolveActionRoomContext({
          workflowRoom,
          actionPackage: node.data.actionPackageName,
          config: node.data.config,
        });
      } catch (error) {
        issues.push(
          error instanceof Error ? error.message : "Invalid room context.",
        );
      }
    }
    if (node.data.inputBindingsError) issues.push(node.data.inputBindingsError);
    if (node.data.kind === "workflow" && !node.data.calledWorkflowId) {
      issues.push("Select the workflow to call.");
    }
    if (
      node.data.kind !== "workflow" &&
      !actionsByName.has(node.data.actionPackageName)
    ) {
      issues.push(`Unknown action ${node.data.actionPackageName}.`);
    }
    for (const reference of bindingReferences(node.data.inputBindings)) {
      if (reference.kind === "unknown") {
        issues.push(
          `Binding expression \${${reference.expression}} is not supported.`,
        );
        continue;
      }
      if (reference.kind === "workflow") continue;
      if (reference.kind === "decision") {
        if (!decisionIds.has(reference.nodeId)) {
          issues.push(
            `Binding references missing decision ${reference.nodeId}.`,
          );
        }
        continue;
      }
      if (!nodeIds.has(reference.nodeId)) {
        issues.push(`Binding references missing step ${reference.nodeId}.`);
        continue;
      }
      // Metadata is read from run state, so it needs no edge. Only values that
      // travel along an edge require one.
      if (reference.kind !== "step-data") continue;
      if (
        !edges.some(
          (edge) =>
            edgeRuntimeSource(edge) === reference.nodeId &&
            edgeRuntimeTarget(edge) === node.id,
        )
      ) {
        issues.push(
          `Binding from ${reference.nodeId} is missing a graph edge.`,
        );
      }
    }
    issues.push(...missingInputIssues(node));
    if (issues.length) {
      nodeIssues.set(node.id, issues);
      errors.push(...issues.map((issue) => `${node.id}: ${issue}`));
    }
  }
  // Marked on the endpoint, whose settings are where the folder is replaced.
  for (const endpoint of beamTransferFolderSources(
    stepNodes.map(endpointStepShape),
  )) {
    nodeIssues.set(endpoint.id, [
      ...(nodeIssues.get(endpoint.id) ?? []),
      BEAM_TRANSFER_FOLDER_SOURCE_ISSUE,
    ]);
    errors.push(`${endpoint.id}: ${BEAM_TRANSFER_FOLDER_SOURCE_ISSUE}`);
  }
  const nodesById = new Map(stepNodes.map((node) => [node.id, node]));
  const simpleInputs = new Map<string, string[]>();
  for (const edge of edges) {
    const runtimeSource = edgeRuntimeSource(edge);
    const runtimeTarget = edgeRuntimeTarget(edge);
    // Decision edges are ordering edges with a branch, not data edges. They
    // carry no binding, so the binding checks below do not apply to them.
    if (decisionIds.has(runtimeSource) || decisionIds.has(runtimeTarget)) {
      const endpointMissing = [runtimeSource, runtimeTarget].some(
        (id) => !nodeIds.has(id) && !decisionIds.has(id) && !controlIds.has(id),
      );
      if (endpointMissing) {
        errors.push(`Edge ${edge.id} references a missing node.`);
      }
      continue;
    }
    const sourceKind =
      edgeKindOf(edge) === "trigger"
        ? "trigger"
        : controlIds.has(runtimeSource)
          ? "control"
          : "step";
    const targetKind = controlIds.has(runtimeTarget) ? "control" : "step";
    if (sourceKind === "trigger") {
      if (
        targetKind !== "step" ||
        !triggerIds.has(runtimeSource) ||
        !nodeIds.has(edge.target)
      ) {
        errors.push(`Edge ${edge.id} must connect a trigger to a step.`);
      }
      const target = nodesById.get(edge.target);
      if (target && !target.data.enabled) {
        const issue =
          "A trigger points to this disabled action. Enable it or reconnect the trigger to an enabled entry step.";
        nodeIssues.set(target.id, [
          ...(nodeIssues.get(target.id) ?? []),
          issue,
        ]);
        errors.push(`${target.id}: ${issue}`);
      }
      continue;
    }
    if (sourceKind === "control" || targetKind === "control") {
      if (
        (sourceKind === "control" && !controlIds.has(runtimeSource)) ||
        (sourceKind === "step" && !nodeIds.has(runtimeSource)) ||
        (targetKind === "control" && !controlIds.has(runtimeTarget)) ||
        (targetKind === "step" && !nodeIds.has(runtimeTarget))
      ) {
        errors.push(`Edge ${edge.id} references a missing graph node.`);
      } else if (runtimeSource === runtimeTarget) {
        errors.push(`Edge ${edge.id} connects a graph node to itself.`);
      }
      continue;
    }
    if (!nodeIds.has(runtimeSource) || !nodeIds.has(runtimeTarget)) {
      errors.push(`Edge ${edge.id} references a missing step.`);
      continue;
    }
    if (runtimeSource === runtimeTarget) {
      errors.push(`Edge ${edge.id} connects a step to itself.`);
      continue;
    }
    const source = nodesById.get(runtimeSource);
    const target = nodesById.get(runtimeTarget);
    const plan = automaticBindingPlan(source, target);
    if (!plan) {
      const isControlFlowConnection =
        Boolean(source && isControlFlowAction(source.data.actionPackageName)) ||
        Boolean(target && isControlFlowAction(target.data.actionPackageName));
      if (
        !isControlFlowConnection &&
        (edge.data?.condition === null || edge.data?.condition === undefined)
      ) {
        errors.push(`Edge ${edge.id} has no compatible data binding.`);
      }
      continue;
    }
    const targetIssues = nodeIssues.get(edge.target) ?? [];
    if (
      !bindingValueContains(
        target?.data.inputBindings[plan.inputKey],
        bindingExpression(runtimeSource, plan.outputKey),
      )
    ) {
      const issue = `${plan.inputKey} is not bound to ${runtimeSource}.${plan.outputKey}.`;
      targetIssues.push(issue);
      errors.push(`${runtimeTarget}: ${issue}`);
    }
    if (
      target?.data.actionPackageName === DOWNLOAD_ACTION &&
      plan.inputKey === "endpoint" &&
      source?.data.actionPackageName === OBJECT_STORAGE_ENDPOINT_ACTION &&
      source.data.config.sourceType === "directory"
    ) {
      const issue = "Download endpoint must target a file object.";
      targetIssues.push(issue);
      errors.push(`${runtimeTarget}: ${issue}`);
    }
    if (
      target?.data.actionPackageName === UPLOAD_ACTION &&
      plan.inputKey === "endpoint" &&
      source?.data.actionPackageName === OBJECT_STORAGE_ENDPOINT_ACTION &&
      source.data.config.sourceType === "directory"
    ) {
      const issue = "Upload endpoint must target a file object.";
      targetIssues.push(issue);
      errors.push(`${runtimeTarget}: ${issue}`);
    }
    if (targetIssues.length) {
      nodeIssues.set(runtimeTarget, targetIssues);
    }
    if (plan.mode === "replace") {
      const key = `${runtimeTarget}:${plan.inputKey}`;
      simpleInputs.set(key, [...(simpleInputs.get(key) ?? []), runtimeSource]);
    }
  }
  for (const [key, sources] of simpleInputs) {
    if (sources.length <= 1) {
      continue;
    }
    const [targetId, inputKey] = key.split(":");
    if (!targetId || !inputKey) {
      continue;
    }
    const issue = `${inputKey} accepts one source, but has ${sources.length}.`;
    const targetIssues = nodeIssues.get(targetId) ?? [];
    targetIssues.push(issue);
    nodeIssues.set(targetId, targetIssues);
    errors.push(`${targetId}: ${issue}`);
  }
  if (hasCycle(nodes, edges)) {
    errors.push("Graph contains a cycle.");
  }
  let payload: ReturnType<typeof toSavePayload> | null = null;
  try {
    payload = toSavePayload(nodes, edges);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (payload?.graphVersion === "workflow-graph/v2") {
    try {
      validateWorkflowGraphV2(
        {
          version: "workflow-graph/v2",
          controls: payload.controls,
          edges: payload.edges.map((edge) => ({
            id: edge.id,
            from: edge.fromStepId,
            to: edge.toStepId,
            condition: edge.condition as WorkflowGraphV2Edge["condition"],
          })),
        } satisfies WorkflowGraphV2Definition,
        payload.steps.map((step) => ({ id: step.id, enabled: step.enabled })),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      for (const node of controlNodes) {
        if (
          message.includes(`"${node.data.controlId}"`) ||
          message.includes(`"${node.id}"`)
        ) {
          nodeIssues.set(node.id, [
            ...(nodeIssues.get(node.id) ?? []),
            message,
          ]);
        }
      }
    }
  }
  return { errors, nodeIssues };
}

/** Resolve each step independently: a newer catalog entry does not replace its saved version. */
export function resolveWorkflowStepAction(
  step: Pick<
    WorkflowNodeData,
    "actionPackageName" | "actionVersionRange" | "manifest"
  >,
  actions: ActionPackage[],
): ActionPackage | null {
  const range = normalizeVersionRange(step.actionVersionRange);
  const compatible = actions.filter(
    (action) =>
      action.name === step.actionPackageName &&
      versionSatisfies(action.version, range),
  );
  const saved = compatible.find(
    (action) => action.version === step.manifest?.version,
  );
  return (
    saved ??
    compatible.sort((a, b) => compareVersions(b.version, a.version))[0] ??
    null
  );
}

export function validateActionVersions(
  nodes: Node<WorkflowCanvasNodeData>[],
  actions: ActionPackage[],
  installedPackages: RegistryPackage[],
  publicPackages: RegistryPackage[],
): ActionVersionValidation {
  const errors: string[] = [];
  const nodeIssues = new Map<string, string[]>();
  const warnings: string[] = [];
  const installedByName = new Map(
    installedPackages.map((item) => [item.packageName, item]),
  );
  const publicByName = new Map(
    publicPackages.map((item) => [item.packageName, item]),
  );

  for (const node of nodes.filter(isStepNode)) {
    if (node.data.kind === "workflow") continue;
    const issues: string[] = [];
    const installedAction = resolveWorkflowStepAction(node.data, actions);
    const availableVersions = actions
      .filter((action) => action.name === node.data.actionPackageName)
      .map((action) => action.version);
    const installedPackage =
      installedByName.get(node.data.actionPackageName) ?? null;
    const publicPackage = publicByName.get(node.data.actionPackageName) ?? null;
    const installedVersion = installedAction?.version ?? null;
    const versionRange = normalizeVersionRange(node.data.actionVersionRange);
    const selectedVersion = installedPackage?.versions?.find(
      (version) => version.version === installedVersion,
    );
    const selectedStatus =
      selectedVersion?.status ??
      (installedVersion === installedPackage?.latestVersion
        ? installedPackage?.latestVersionStatus
        : null);
    const selectedValidation =
      selectedVersion?.validationStatus ??
      (installedVersion === installedPackage?.latestVersion
        ? installedPackage?.latestValidationStatus
        : null);

    if (!availableVersions.length) {
      issues.push(
        `Action ${node.data.actionPackageName} is not installed in Studio.`,
      );
    } else if (!installedVersion) {
      issues.push(
        `No installed version satisfies ${versionRange}. Available: ${availableVersions.join(", ")}.`,
      );
    }
    if (
      installedPackage?.status === "blocked" ||
      installedPackage?.trustLevel === "blocked" ||
      selectedVersion?.trustLevel === "blocked" ||
      selectedStatus === "blocked" ||
      selectedStatus === "yanked" ||
      selectedValidation === "blocked" ||
      selectedValidation === "rejected"
    ) {
      issues.push(
        `Installed action ${node.data.actionPackageName} is blocked by Registry policy.`,
      );
    }

    if (issues.length) {
      nodeIssues.set(node.id, issues);
      errors.push(...issues.map((issue) => `${node.id}: ${issue}`));
    }

    const publicLatestVersion = publicPackage?.latestVersion ?? null;
    if (
      installedVersion &&
      publicLatestVersion &&
      compareVersions(publicLatestVersion, installedVersion) > 0
    ) {
      warnings.push(
        `${node.id}: ${node.data.actionPackageName} has an update available (${installedVersion} -> ${publicLatestVersion}).`,
      );
    }
    if (
      installedPackage?.status === "deprecated" ||
      selectedStatus === "deprecated"
    ) {
      warnings.push(
        `${node.id}: ${node.data.actionPackageName}@${installedVersion ?? "unknown"} is deprecated.`,
      );
    }
    const advisories = [
      ...(installedPackage?.advisories ?? []),
      ...(publicPackage?.advisories ?? []),
    ];
    if (installedPackage?.vulnerable || publicPackage?.vulnerable) {
      warnings.push(
        `${node.id}: ${node.data.actionPackageName} has ${advisories.length || "an active"} Registry security advisor${advisories.length === 1 ? "y" : "ies"}.`,
      );
    }
  }

  return { errors, nodeIssues, warnings };
}

function endpointStepShape(node: Node<WorkflowNodeData>) {
  return {
    id: node.id,
    actionPackageName: node.data.actionPackageName,
    config: node.data.config,
    inputBindings: node.data.inputBindings,
  };
}

/**
 * Whether a Beam Transfer step reads this endpoint as a source, which must
 * name one object: its bucket explorer then offers files only.
 */
export function isBeamTransferSourceEndpoint(
  nodes: Node<WorkflowCanvasNodeData>[],
  nodeId: string,
) {
  return beamTransferSourceEndpointIds(
    nodes.filter(isStepNode).map(endpointStepShape),
  ).has(nodeId);
}

function missingInputIssues(node: Node<WorkflowNodeData>) {
  const bindings = node.data.inputBindings;
  if (node.data.actionPackageName === BEAM_TRANSFER_ACTION) {
    const issues = [];
    if (!hasBinding(bindings, "sourceEndpoints")) {
      issues.push("Beam transfer requires source endpoints.");
    }
    if (!hasBinding(bindings, "destinationEndpoints")) {
      issues.push("Beam transfer requires destination endpoints.");
    }
    if (!hasConfigValue(node.data.config, "credentialId")) {
      issues.push("Beam transfer requires a Beam credential.");
    }
    return issues;
  }
  if (node.data.actionPackageName === DOWNLOAD_ACTION) {
    return hasBinding(bindings, "endpoint") ||
      (hasBinding(bindings, "bucket") &&
        hasBinding(bindings, "objectKey") &&
        hasBinding(bindings, "credentialId"))
      ? []
      : ["Download requires an endpoint binding."];
  }
  if (node.data.actionPackageName === UPLOAD_ACTION) {
    const issues = [];
    if (
      !hasBinding(bindings, "endpoint") &&
      !(
        hasBinding(bindings, "bucket") &&
        hasBinding(bindings, "objectKey") &&
        hasBinding(bindings, "credentialId")
      )
    ) {
      issues.push("Upload requires an endpoint binding.");
    }
    if (!hasBinding(bindings, "content")) {
      issues.push("Upload requires a content binding.");
    }
    return issues;
  }
  return [];
}

function hasBinding(bindings: JsonObject, key: string) {
  const value = bindings[key];
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== undefined && value !== null && value !== "";
}

function hasConfigValue(config: JsonObject, key: string) {
  const value = config[key];
  return value !== undefined && value !== null && value !== "";
}

const workflowMetadataFields = new Set([
  "runId",
  "name",
  "startedAt",
  "triggerType",
  "triggerName",
]);
const decisionMetadataFields = new Set([
  "branch",
  "result",
  "joinMode",
  "name",
]);

export type BindingReference =
  /** A value that flows along an edge, so the edge must exist. */
  | { kind: "step-data"; nodeId: string; root: string; key: string }
  /** Read from run state, so it needs no edge — only a node that exists. */
  | { kind: "step-meta"; nodeId: string; field: string }
  | { kind: "decision"; nodeId: string; field: string }
  | { kind: "workflow"; field: string }
  | { kind: "unknown"; expression: string };

/**
 * Every `${…}` expression in a binding, classified.
 *
 * Metadata references are deliberately separate from data references: a step
 * reads another node's status from run state, not along an edge, so a Slack
 * step on a decision's false branch may legitimately name the transfer that
 * failed without being wired directly to it.
 */
export function bindingReferences(value: unknown): BindingReference[] {
  if (typeof value === "string")
    return [...value.matchAll(/\$\{([^}]+)\}/g)].map((match) =>
      classifyBindingExpression((match[1] ?? "").trim()),
    );
  if (Array.isArray(value)) return value.flatMap(bindingReferences);
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, "$literal"))
      return [];
    return Object.values(value).flatMap(bindingReferences);
  }
  return [];
}

function classifyBindingExpression(expression: string): BindingReference {
  const [root, second, third, ...rest] = expression.split(".");

  if (root === "workflow") {
    // workflow.input.* and workflow.config.* are runtime values, not metadata.
    if (second === "input" || second === "config") {
      return { kind: "workflow", field: second };
    }
    return second && workflowMetadataFields.has(second)
      ? { kind: "workflow", field: second }
      : { kind: "unknown", expression };
  }

  if (root === "decisions" && second && third) {
    return decisionMetadataFields.has(third)
      ? { kind: "decision", nodeId: second, field: third }
      : { kind: "unknown", expression };
  }

  if (root === "steps" && second && third) {
    if (third === "outputs" || third === "artifacts") {
      return {
        kind: "step-data",
        nodeId: second,
        root: third,
        key: rest[0] ?? "",
      };
    }
    if (third === "config" || isStepMetadataField(third)) {
      return { kind: "step-meta", nodeId: second, field: third };
    }
    return { kind: "unknown", expression };
  }

  // graph.* is substituted inside dynamic regions before bindings resolve.
  if (root === "graph") {
    return { kind: "workflow", field: "graph" };
  }
  return { kind: "unknown", expression };
}

function hasCycle(nodes: Node<WorkflowCanvasNodeData>[], edges: Edge[]) {
  const stepNodes = nodes.filter(isStepNode);
  const incoming = new Map(stepNodes.map((node) => [node.id, 0]));
  const outgoing = new Map(stepNodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    const source = edgeRuntimeSource(edge);
    const target = edgeRuntimeTarget(edge);
    if (
      edgeKindOf(edge) === "trigger" ||
      !incoming.has(source) ||
      !incoming.has(target)
    ) {
      continue;
    }
    outgoing.get(source)?.push(target);
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
  }
  const ready = [...incoming.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const id = ready.shift();
    if (!id) {
      continue;
    }
    visited += 1;
    for (const next of outgoing.get(id) ?? []) {
      const count = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, count);
      if (count === 0) {
        ready.push(next);
      }
    }
  }
  return visited !== stepNodes.length;
}

function normalizeVersionRange(range: string) {
  const normalized = range.trim();
  return normalized || "*";
}

function versionSatisfies(version: string, range: string) {
  if (range === "*" || range === "latest") {
    return true;
  }
  if (range === version) {
    return true;
  }

  const parsedVersion = parseVersion(version);
  if (!parsedVersion) {
    return false;
  }
  if (range.startsWith("^")) {
    const parsedRange = parseVersion(range.slice(1));
    return (
      Boolean(parsedRange) &&
      parsedVersion.major === parsedRange?.major &&
      compareVersions(version, range.slice(1)) >= 0
    );
  }
  if (range.startsWith("~")) {
    const parsedRange = parseVersion(range.slice(1));
    return (
      Boolean(parsedRange) &&
      parsedVersion.major === parsedRange?.major &&
      parsedVersion.minor === parsedRange?.minor &&
      compareVersions(version, range.slice(1)) >= 0
    );
  }
  return false;
}

function compareVersions(left: string, right: string) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  return (
    parsedLeft.major - parsedRight.major ||
    parsedLeft.minor - parsedRight.minor ||
    parsedLeft.patch - parsedRight.patch
  );
}

function parseVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}
