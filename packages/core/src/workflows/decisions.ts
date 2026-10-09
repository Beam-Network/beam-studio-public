/**
 * Decision nodes: a first-class graph object placed between steps.
 *
 * A decision joins several inputs, evaluates a declarative predicate over the
 * statuses and outputs of those inputs, and routes to a true or false branch.
 * It is evaluated by the workflow engine and is never dispatched to a worker,
 * the same way a trigger is a graph object rather than a task.
 *
 * The predicate language is deliberately bounded and declarative: it compares
 * resolved values and combines them with all/any/not. It never parses or
 * executes user-supplied code.
 */

import type { ActionJson } from "./actions.js";
import {
  pathValue,
  resolveNodeMetadata,
  type WorkflowMetadataContext,
} from "./node-metadata.js";

export type WorkflowDecisionJoinMode = "all" | "any_settled";
export type WorkflowDecisionKind = "if" | "switch";
export type WorkflowDecisionBranch =
  | "true"
  | "false"
  | `case:${string}`
  | "default";

/** Statuses that satisfy an input edge into a decision. */
const satisfiedInputStatuses = new Set(["completed"]);

/**
 * An operand is either a reference to an upstream step's run status, a binding
 * expression, or a literal. Strings that open with "${" are treated as
 * bindings, matching the convention already used by edge conditions.
 */
export type WorkflowDecisionOperand =
  | { step: string; field: "status" }
  | ActionJson;

export type WorkflowDecisionOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "exists"
  | "empty"
  | "contains";

export type WorkflowDecisionComparison = {
  left: WorkflowDecisionOperand;
  op: WorkflowDecisionOperator;
  right?: WorkflowDecisionOperand;
};

export type WorkflowDecisionPredicate =
  | boolean
  | WorkflowDecisionComparison
  | { all: WorkflowDecisionPredicate[] }
  | { any: WorkflowDecisionPredicate[] }
  | { not: WorkflowDecisionPredicate };

export type WorkflowSwitchCase = {
  /** Stable identifier used by persisted graph edges. */
  id: string;
  name: string;
  predicate: WorkflowDecisionPredicate;
};

export type WorkflowDecision = {
  id: string;
  name: string;
  kind: WorkflowDecisionKind;
  enabled: boolean;
  joinMode: WorkflowDecisionJoinMode;
  handleFailure: boolean;
  predicate?: WorkflowDecisionPredicate;
  cases?: WorkflowSwitchCase[];
  layout?: { x: number; y: number };
};

export type WorkflowDecisionEdge = {
  id: string;
  fromStepId?: string;
  fromDecisionId?: string;
  toStepId?: string;
  toDecisionId?: string;
  branch?: WorkflowDecisionBranch;
};

export type WorkflowDecisionContext = {
  statusByNode: ReadonlyMap<string, string>;
  outputsByStep: ReadonlyMap<string, Record<string, ActionJson>>;
  workflowInputs: Record<string, ActionJson>;
  workflowConfig: Record<string, ActionJson>;
  /**
   * The same node metadata input bindings see, so a predicate can branch on a
   * step's config, timings or a prior decision, not just its outputs.
   */
  metadata?: WorkflowMetadataContext;
};

export type WorkflowDecisionReason =
  | "join_unsatisfied"
  | "predicate_true"
  | "predicate_false"
  | "predicate_absent"
  | "predicate_invalid"
  | "case_matched"
  | "switch_default"
  | "inputs_not_reached"
  | "inputs_pending";

export type WorkflowDecisionOutcome = {
  /** False while inputs are pending or when the decision was not reached. */
  evaluated: boolean;
  result: boolean | null;
  branch: WorkflowDecisionBranch | null;
  reason: WorkflowDecisionReason;
  /** Failed input step ids this decision consumed, when it handles failures. */
  handledFailures: string[];
};

/**
 * Resolves a decision once every input has settled.
 *
 * Unlike an ordinary step edge, a decision evaluates regardless of whether its
 * inputs succeeded. That is what makes a failure branch expressible: the
 * decision observes the failure instead of being marked unreachable by it.
 */
export function evaluateWorkflowDecision(input: {
  decision: WorkflowDecision;
  inputNodeIds: string[];
  context: WorkflowDecisionContext;
  terminalStatuses: ReadonlySet<string>;
}): WorkflowDecisionOutcome {
  const statuses = input.inputNodeIds.map(
    (nodeId) => input.context.statusByNode.get(nodeId) ?? "not_reached",
  );
  if (statuses.some((status) => !input.terminalStatuses.has(status))) {
    return {
      evaluated: false,
      result: null,
      branch: null,
      reason: "inputs_pending",
      handledFailures: [],
    };
  }

  // Failures this decision consumes. Recorded whenever the decision evaluates,
  // including on the false branch, because routing a failure to a recovery
  // branch is precisely when a failure is "handled".
  const handledFailures = input.decision.handleFailure
    ? input.inputNodeIds.filter((_, index) => statuses[index] === "failed")
    : [];

  const satisfied = statuses.map((status) =>
    satisfiedInputStatuses.has(status),
  );
  // A decision with no inputs cannot gate anything, so it does not block.
  const joinSatisfied =
    input.inputNodeIds.length === 0 ||
    (input.decision.joinMode === "all"
      ? satisfied.every(Boolean)
      : satisfied.some(Boolean));

  // An unsatisfied join takes the negative/default branch rather than refusing
  // to run. That is what lets a failed input reach a recovery branch.
  if (!joinSatisfied) {
    return {
      evaluated: true,
      result: false,
      branch: input.decision.kind === "switch" ? "default" : "false",
      reason: "join_unsatisfied",
      handledFailures,
    };
  }

  if (input.decision.kind === "switch") {
    for (const switchCase of input.decision.cases ?? []) {
      const evaluation = resolvePredicate(switchCase.predicate, input.context);
      if (evaluation.reason === "predicate_invalid") {
        return {
          evaluated: true,
          result: false,
          branch: "default",
          reason: "predicate_invalid",
          handledFailures,
        };
      }
      if (evaluation.result) {
        return {
          evaluated: true,
          result: true,
          branch: `case:${switchCase.id}`,
          reason: "case_matched",
          handledFailures,
        };
      }
    }
    return {
      evaluated: true,
      result: false,
      branch: "default",
      reason: "switch_default",
      handledFailures,
    };
  }

  const evaluation = resolvePredicate(input.decision.predicate, input.context);
  return {
    evaluated: true,
    result: evaluation.result,
    branch: evaluation.result ? "true" : "false",
    reason: evaluation.reason,
    handledFailures,
  };
}

/**
 * Structural validation shared by the API and editor. It intentionally does
 * not resolve bindings; it only proves the persisted predicate belongs to the
 * bounded declarative language the engine evaluates.
 */
export function workflowPredicateError(predicate: unknown): string | null {
  if (typeof predicate === "boolean") return null;
  if (!predicate || typeof predicate !== "object" || Array.isArray(predicate)) {
    return "Predicate must be a boolean or predicate object.";
  }
  const record = predicate as Record<string, unknown>;
  const shapes = ["all", "any", "not", "left"].filter((key) => key in record);
  if (shapes.length !== 1) {
    return "Predicate must contain exactly one comparison or all/any/not operator.";
  }
  if ("all" in record || "any" in record) {
    const key = "all" in record ? "all" : "any";
    const entries = record[key];
    if (!Array.isArray(entries) || entries.length === 0) {
      return `Predicate ${key} must contain at least one predicate.`;
    }
    for (const entry of entries) {
      const error = workflowPredicateError(entry);
      if (error) return error;
    }
    return null;
  }
  if ("not" in record) return workflowPredicateError(record.not);

  const operators = new Set<WorkflowDecisionOperator>([
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "exists",
    "empty",
    "contains",
  ]);
  if (
    !("left" in record) ||
    !operators.has(record.op as WorkflowDecisionOperator)
  ) {
    return "Comparison predicate requires a left operand and supported operator.";
  }
  if (!validOperand(record.left))
    return "Comparison left operand is malformed.";
  const unary = record.op === "exists" || record.op === "empty";
  if (!unary && !("right" in record)) {
    return `Comparison operator ${String(record.op)} requires a right operand.`;
  }
  if ("right" in record && !validOperand(record.right)) {
    return "Comparison right operand is malformed.";
  }
  return null;
}

function validOperand(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(validOperand);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ("step" in record || "field" in record) {
    return (
      Object.keys(record).length === 2 &&
      typeof record.step === "string" &&
      record.step.length > 0 &&
      record.field === "status"
    );
  }
  return Object.values(record).every(validOperand);
}

/**
 * Evaluates a predicate. Never throws: an unresolvable operand or a malformed
 * predicate resolves to false with a reason, so a decision cannot crash a run.
 */
export function resolvePredicate(
  predicate: WorkflowDecisionPredicate | undefined,
  context: WorkflowDecisionContext,
): { result: boolean; reason: WorkflowDecisionReason } {
  if (predicate === undefined || predicate === null) {
    return { result: true, reason: "predicate_absent" };
  }
  try {
    const result = evaluatePredicate(predicate, context);
    return {
      result,
      reason: result ? "predicate_true" : "predicate_false",
    };
  } catch {
    return { result: false, reason: "predicate_invalid" };
  }
}

function evaluatePredicate(
  predicate: WorkflowDecisionPredicate,
  context: WorkflowDecisionContext,
): boolean {
  if (typeof predicate === "boolean") {
    return predicate;
  }
  if (!predicate || typeof predicate !== "object") {
    throw new Error("Decision predicate must be a boolean or an object.");
  }
  if ("all" in predicate) {
    if (!Array.isArray(predicate.all)) {
      throw new Error("Decision predicate 'all' must be an array.");
    }
    return predicate.all.every((entry) => evaluatePredicate(entry, context));
  }
  if ("any" in predicate) {
    if (!Array.isArray(predicate.any)) {
      throw new Error("Decision predicate 'any' must be an array.");
    }
    return predicate.any.some((entry) => evaluatePredicate(entry, context));
  }
  if ("not" in predicate) {
    return !evaluatePredicate(predicate.not, context);
  }
  if ("left" in predicate && "op" in predicate) {
    return evaluateComparison(predicate, context);
  }
  throw new Error("Decision predicate is not a recognised shape.");
}

function evaluateComparison(
  comparison: WorkflowDecisionComparison,
  context: WorkflowDecisionContext,
): boolean {
  const left = resolveOperand(comparison.left, context);
  if (comparison.op === "exists") {
    return left !== null && left !== undefined;
  }
  if (comparison.op === "empty") {
    return isEmpty(left);
  }
  const right = resolveOperand(comparison.right, context);
  if (comparison.op === "eq") {
    return jsonEqual(left, right);
  }
  if (comparison.op === "ne") {
    return !jsonEqual(left, right);
  }
  if (comparison.op === "contains") {
    return contains(left, right);
  }
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  // Ordered comparison against a non-numeric operand is false, not an error.
  if (leftNumber === null || rightNumber === null) {
    return false;
  }
  if (comparison.op === "lt") return leftNumber < rightNumber;
  if (comparison.op === "lte") return leftNumber <= rightNumber;
  if (comparison.op === "gt") return leftNumber > rightNumber;
  if (comparison.op === "gte") return leftNumber >= rightNumber;
  throw new Error(`Unsupported decision operator "${comparison.op}".`);
}

function resolveOperand(
  operand: WorkflowDecisionOperand | undefined,
  context: WorkflowDecisionContext,
): ActionJson | undefined {
  if (operand === undefined) {
    return undefined;
  }
  if (isStepStatusOperand(operand)) {
    return context.statusByNode.get(operand.step) ?? null;
  }
  if (
    typeof operand === "string" &&
    operand.startsWith("${") &&
    operand.endsWith("}")
  ) {
    return resolveBinding(operand.slice(2, -1), context);
  }
  return operand;
}

function isStepStatusOperand(
  operand: WorkflowDecisionOperand,
): operand is { step: string; field: "status" } {
  return (
    typeof operand === "object" &&
    operand !== null &&
    !Array.isArray(operand) &&
    typeof (operand as { step?: unknown }).step === "string" &&
    (operand as { field?: unknown }).field === "status"
  );
}

/**
 * Supports the same roots as edge conditions, minus artifacts: a decision is
 * resolved by the engine, which does not carry per-step artifacts.
 * An unavailable root resolves to null rather than throwing.
 */
function resolveBinding(
  expression: string,
  context: WorkflowDecisionContext,
): ActionJson {
  const meta = resolveNodeMetadata(
    expression,
    context.metadata ?? { stepsById: new Map() },
  );
  if (meta.matched) {
    return meta.value;
  }
  const segments = expression.split(".");
  if (segments[0] === "workflow" && segments[1] === "input") {
    return pathValue(context.workflowInputs as ActionJson, segments.slice(2));
  }
  if (segments[0] === "workflow" && segments[1] === "config") {
    return pathValue(context.workflowConfig as ActionJson, segments.slice(2));
  }
  if (segments[0] === "steps" && segments[2] === "outputs") {
    const outputs = context.outputsByStep.get(segments[1] ?? "");
    if (!outputs) {
      return null;
    }
    return pathValue(outputs as ActionJson, segments.slice(3));
  }
  if (segments[0] === "steps" && segments[2] === "status") {
    return context.statusByNode.get(segments[1] ?? "") ?? null;
  }
  return null;
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isEmpty(value: unknown) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function contains(left: unknown, right: unknown) {
  if (Array.isArray(left)) {
    return left.some((entry) => jsonEqual(entry, right));
  }
  if (typeof left === "string") {
    return left.includes(String(right ?? ""));
  }
  return false;
}
