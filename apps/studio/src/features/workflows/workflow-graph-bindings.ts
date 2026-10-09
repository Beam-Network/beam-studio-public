import type { Node } from "@xyflow/react";
import { isJsonObject } from "./workflow-config-schema";
import {
  BEAM_TRANSFER_ACTION,
  OBJECT_STORAGE_ENDPOINT_ACTION,
} from "./workflow-graph-constants";
import type {
  AutomaticBindingPlan,
  JsonObject,
  WorkflowNodeData,
} from "./workflow-graph-types";

export function automaticBindingPlan(
  source: Node<WorkflowNodeData> | undefined,
  target: Node<WorkflowNodeData> | undefined,
): AutomaticBindingPlan | null {
  if (!source || !target) {
    return null;
  }
  const sourceOutputs = manifestRecord(source, "outputs");
  const targetInputs = manifestRecord(target, "inputs");

  if (
    source.data.actionPackageName === OBJECT_STORAGE_ENDPOINT_ACTION &&
    target.data.actionPackageName === BEAM_TRANSFER_ACTION
  ) {
    return {
      inputKey: beamTransferEndpointInputKey(source, target),
      outputKey: "endpoint",
      mode: "append",
    };
  }

  if (
    Object.hasOwn(sourceOutputs, "endpoint") &&
    Object.hasOwn(targetInputs, "endpoint")
  ) {
    return { inputKey: "endpoint", outputKey: "endpoint", mode: "replace" };
  }

  return null;
}

function beamTransferEndpointInputKey(
  source: Node<WorkflowNodeData>,
  target: Node<WorkflowNodeData>,
) {
  const expression = bindingExpression(source.id, "endpoint");
  if (bindingValueContains(target.data.inputBindings.destinationEndpoints, expression)) {
    return "destinationEndpoints";
  }
  if (bindingValueContains(target.data.inputBindings.sourceEndpoints, expression)) {
    return "sourceEndpoints";
  }
  const label = String(source.data.config.name ?? source.data.actionPackageName)
    .trim()
    .toLowerCase();
  if (
    /\b(destination|dest|target|output|sink)\b/.test(label) ||
    label.includes("sortie")
  ) {
    return "destinationEndpoints";
  }
  return "sourceEndpoints";
}

export function bindingExpression(sourceId: string, outputKey: string) {
  return `\${steps.${sourceId}.outputs.${outputKey}}`;
}

export function applyAutomaticBinding(
  bindings: JsonObject,
  plan: AutomaticBindingPlan,
  sourceId: string,
) {
  const expression = bindingExpression(sourceId, plan.outputKey);
  const nextBindings = { ...bindings };
  const peerInputKey = exclusivePeerInputKey(plan.inputKey);

  if (peerInputKey) {
    const peerValues = bindingArrayWithout(
      nextBindings[peerInputKey],
      expression,
    );
    if (peerValues.length) {
      nextBindings[peerInputKey] = peerValues;
    } else {
      delete nextBindings[peerInputKey];
    }
  }

  if (plan.mode === "append") {
    const existing = nextBindings[plan.inputKey];
    const values = Array.isArray(existing)
      ? existing
      : existing === undefined
        ? []
        : [existing];
    if (values.includes(expression)) {
      return nextBindings;
    }
    return {
      ...nextBindings,
      [plan.inputKey]: [...values, expression],
    };
  }
  return {
    ...nextBindings,
    [plan.inputKey]: expression,
  };
}

export function removeAutomaticBinding(
  bindings: JsonObject,
  plan: AutomaticBindingPlan,
  sourceId: string,
) {
  const expression = bindingExpression(sourceId, plan.outputKey);
  const existing = bindings[plan.inputKey];
  const nextBindings = { ...bindings };

  if (Array.isArray(existing)) {
    const values = existing.filter((value) => value !== expression);
    if (values.length) {
      nextBindings[plan.inputKey] = values;
    } else {
      delete nextBindings[plan.inputKey];
    }
  } else if (existing === expression) {
    delete nextBindings[plan.inputKey];
  }

  return nextBindings;
}

function exclusivePeerInputKey(inputKey: string) {
  if (inputKey === "sourceEndpoints") {
    return "destinationEndpoints";
  }
  if (inputKey === "destinationEndpoints") {
    return "sourceEndpoints";
  }
  return "";
}

function bindingArrayWithout(value: unknown, expression: string) {
  const values = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return values.filter((item) => item !== expression);
}

export function hasBindingConflict(
  bindings: JsonObject,
  plan: AutomaticBindingPlan,
  sourceId: string,
) {
  if (plan.mode === "append") {
    return false;
  }
  const existing = bindings[plan.inputKey];
  return (
    existing !== undefined &&
    existing !== bindingExpression(sourceId, plan.outputKey)
  );
}

export function bindingValueContains(value: unknown, expression: string) {
  return Array.isArray(value) ? value.includes(expression) : value === expression;
}

function manifestRecord(
  node: Node<WorkflowNodeData>,
  key: "inputs" | "outputs",
) {
  const manifest = node.data.action?.manifest ?? node.data.manifest ?? {};
  const value = manifest[key];
  return isJsonObject(value) ? value : {};
}
