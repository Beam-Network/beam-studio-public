/**
 * Node metadata: the facts every node in a workflow carries, referenceable
 * from anywhere downstream.
 *
 * One resolver serves both input bindings and decision predicates, so the two
 * cannot drift into supporting different expressions. Unlike step outputs,
 * which exist only after a step succeeds, metadata exists whatever the node
 * did — that is what lets a failure branch describe what went wrong and lets a
 * decision branch on it.
 */

import type { ActionJson } from "./actions.js";

export type WorkflowStepMetadata = {
  id: string;
  runId?: string | null;
  /** Operator-facing label, falling back to the action package name. */
  name?: string | null;
  action?: string | null;
  status: string;
  error?: string | null;
  attempt?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  /** The step's own configuration, so downstream nodes can read its settings. */
  config?: Record<string, ActionJson>;
};

export type WorkflowDecisionMetadata = {
  id: string;
  name?: string | null;
  result?: boolean | null;
  branch?: string | null;
  joinMode?: string | null;
};

export type WorkflowRunMetadata = {
  runId?: string | null;
  name?: string | null;
  startedAt?: string | null;
  triggerType?: string | null;
  triggerName?: string | null;
};

export type WorkflowMetadataContext = {
  stepsById: ReadonlyMap<string, WorkflowStepMetadata>;
  decisionsById?: ReadonlyMap<string, WorkflowDecisionMetadata>;
  run?: WorkflowRunMetadata;
};

/** Step fields that resolve without touching outputs or artifacts. */
const stepMetadataFields = new Set([
  "id",
  "runId",
  "name",
  "action",
  "status",
  "error",
  "attempt",
  "startedAt",
  "completedAt",
  "durationMs",
]);

export function isStepMetadataField(field: string) {
  return stepMetadataFields.has(field);
}

/**
 * Resolves a metadata expression, or returns undefined when the expression is
 * not a metadata one so the caller can fall through to outputs and artifacts.
 *
 * Never throws. An unknown node resolves to a neutral value rather than
 * failing, because the notifications and decisions that read metadata exist
 * precisely for the cases where something did not run.
 */
export function resolveNodeMetadata(
  expression: string,
  context: WorkflowMetadataContext,
): { matched: boolean; value: ActionJson } {
  const segments = expression.split(".");
  const [root, id, field, ...path] = segments;

  if (root === "workflow" && id && isRunField(id)) {
    return { matched: true, value: runValue(id, context.run) };
  }

  if (root === "decisions" && id && field) {
    const decision = context.decisionsById?.get(id);
    if (field === "result") return { matched: true, value: decision?.result ?? null };
    if (field === "branch") return { matched: true, value: decision?.branch ?? null };
    if (field === "joinMode")
      return { matched: true, value: decision?.joinMode ?? null };
    if (field === "name")
      return { matched: true, value: decision?.name ?? id };
    return { matched: false, value: null };
  }

  if (root === "steps" && id && field) {
    const step = context.stepsById.get(id);
    if (field === "config") {
      return {
        matched: true,
        value: pathValue((step?.config ?? {}) as ActionJson, path),
      };
    }
    if (!isStepMetadataField(field)) {
      // outputs and artifacts are resolved by the caller.
      return { matched: false, value: null };
    }
    if (field === "id") return { matched: true, value: step?.id ?? id };
    if (field === "runId") return { matched: true, value: step?.runId ?? null };
    if (field === "status") {
      return { matched: true, value: step?.status ?? "not_reached" };
    }
    if (field === "name") {
      return { matched: true, value: step?.name || step?.action || id };
    }
    if (field === "error") return { matched: true, value: step?.error ?? null };
    if (field === "action") return { matched: true, value: step?.action ?? null };
    if (field === "attempt") return { matched: true, value: step?.attempt ?? null };
    if (field === "startedAt")
      return { matched: true, value: step?.startedAt ?? null };
    if (field === "completedAt")
      return { matched: true, value: step?.completedAt ?? null };
    if (field === "durationMs")
      return { matched: true, value: durationMs(step) };
  }

  return { matched: false, value: null };
}

function isRunField(field: string) {
  return (
    field === "runId" ||
    field === "name" ||
    field === "startedAt" ||
    field === "triggerType" ||
    field === "triggerName"
  );
}

function runValue(field: string, run: WorkflowRunMetadata | undefined): ActionJson {
  if (!run) return null;
  return (run[field as keyof WorkflowRunMetadata] as ActionJson) ?? null;
}

/** Derived when the store did not record it, so a message can always say how long. */
function durationMs(step: WorkflowStepMetadata | undefined): ActionJson {
  if (!step) return null;
  if (typeof step.durationMs === "number") return step.durationMs;
  if (!step.startedAt || !step.completedAt) return null;
  const started = Date.parse(step.startedAt);
  const completed = Date.parse(step.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
  return Math.max(0, completed - started);
}

export function pathValue(value: ActionJson, path: string[]): ActionJson {
  let current: ActionJson = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return null;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return null;
      current = current[index] ?? null;
      continue;
    }
    current = current[segment] ?? null;
  }
  return current;
}
