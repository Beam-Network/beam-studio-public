/**
 * Resolution and persistence of decision nodes for the dynamic graph engine.
 *
 * A decision is not a task. The engine settles it in the same pass where it
 * decides which steps to start, then routes each outgoing edge by the branch
 * the decision took.
 */
import crypto from "node:crypto";
import {
  evaluateWorkflowDecision,
  type ActionJson,
  type WorkflowDecision,
  type WorkflowDecisionEdge,
  type WorkflowDecisionOutcome,
  type WorkflowMetadataContext,
} from "@beam-studio/core";
import type { PgClient } from "@beam-studio/db";
import type { Row } from "./types.js";

export type DecisionResolutionContext = {
  decisions: WorkflowDecision[];
  decisionEdges: WorkflowDecisionEdge[];
  outputsByStep: ReadonlyMap<string, Record<string, ActionJson>>;
  runtimeInputs: Record<string, ActionJson>;
  templateSnapshot: Record<string, ActionJson>;
  terminalStatuses: ReadonlySet<string>;
  /** Current status of every step and region node the run knows about. */
  statusByNode: ReadonlyMap<string, string>;
  /** Node metadata predicates can read, the same set input bindings see. */
  metadata?: WorkflowMetadataContext;
};

export type DecisionResolution = {
  outcomes: Map<string, WorkflowDecisionOutcome>;
  /** Failed step ids consumed by a decision that actually evaluated. */
  handledFailures: Set<string>;
};

export function decisionInputIds(
  decisionId: string,
  edges: WorkflowDecisionEdge[],
) {
  return edges
    .filter((edge) => edge.toDecisionId === decisionId)
    .map((edge) => edge.fromStepId ?? edge.fromDecisionId ?? "")
    .filter(Boolean);
}

/**
 * Settles every decision it can, repeatedly, so chained decisions resolve in
 * one pass. A decision whose inputs are still running is simply left out of the
 * result, which reads downstream as "keep waiting".
 */
export function resolveDecisions(
  context: DecisionResolutionContext,
): DecisionResolution {
  const outcomes = new Map<string, WorkflowDecisionOutcome>();
  const notReached = (): WorkflowDecisionOutcome => ({
    evaluated: false,
    result: null,
    branch: null,
    reason: "inputs_not_reached",
    handledFailures: [],
  });
  for (const decision of context.decisions) {
    if (!decision.enabled) outcomes.set(decision.id, notReached());
  }

  // A decision can feed another decision, so iterate until nothing new settles.
  // Bounded by the number of decisions: each pass settles at least one or stops.
  for (let pass = 0; pass < context.decisions.length; pass += 1) {
    let settledSomething = false;
    for (const decision of context.decisions) {
      if (outcomes.has(decision.id) || !decision.enabled) continue;
      const inputEdges = context.decisionEdges.filter(
        (edge) => edge.toDecisionId === decision.id,
      );

      // Every node status the predicate might reference, not just this
      // decision's own inputs, plus the decisions settled so far.
      const statusByNode = new Map(context.statusByNode);
      for (const [decisionId, settled] of outcomes) {
        const status = decisionStatus(settled);
        if (status) statusByNode.set(decisionId, status);
      }

      // Satisfaction belongs to the incoming edge, not only its source node:
      // a completed decision does not satisfy its untaken output port.
      const inputIds = inputEdges.map((edge) => {
        if (!edge.fromDecisionId) return edge.fromStepId ?? "";
        const inputId = `decision-input:${decision.id}:${edge.id}`;
        const state = decisionEdgeState(edge, outcomes);
        if (state !== "waiting") {
          statusByNode.set(
            inputId,
            state === "taken" ? "completed" : "not_reached",
          );
        }
        return inputId;
      });

      const unresolvedInput = inputIds.some(
        (inputId) => !statusByNode.has(inputId),
      );
      if (unresolvedInput) continue;

      const statuses = inputIds.map((id) => statusByNode.get(id)!);
      if (statuses.some((status) => !context.terminalStatuses.has(status)))
        continue;
      const reached = statuses.map(
        (status) => status !== "not_reached" && status !== "skipped",
      );
      if (
        reached.length &&
        !(decision.joinMode === "all"
          ? reached.every(Boolean)
          : reached.some(Boolean))
      ) {
        outcomes.set(decision.id, notReached());
        settledSomething = true;
        continue;
      }

      const outcome = evaluateWorkflowDecision({
        decision,
        inputNodeIds: inputIds,
        terminalStatuses: context.terminalStatuses,
        context: {
          statusByNode,
          metadata: context.metadata,
          outputsByStep: context.outputsByStep,
          workflowInputs: context.runtimeInputs,
          workflowConfig: context.templateSnapshot,
        },
      });
      if (!outcome.evaluated) continue;
      outcomes.set(decision.id, outcome);
      settledSomething = true;
    }
    if (!settledSomething) break;
  }

  const handledFailures = new Set<string>();
  for (const outcome of outcomes.values()) {
    for (const stepId of outcome.handledFailures) {
      handledFailures.add(stepId);
    }
  }
  return { outcomes, handledFailures };
}

/**
 * How an incoming decision edge reads for the node it points at.
 * "taken" when the decision resolved to this edge's branch.
 */
export function decisionEdgeState(
  edge: WorkflowDecisionEdge,
  outcomes: ReadonlyMap<string, WorkflowDecisionOutcome>,
): "taken" | "not_taken" | "waiting" {
  if (!edge.fromDecisionId) return "waiting";
  const outcome = outcomes.get(edge.fromDecisionId);
  if (!outcome || outcome.reason === "inputs_pending") return "waiting";
  if (!outcome.evaluated) return "not_taken";
  return outcome.branch === edge.branch ? "taken" : "not_taken";
}

/** A settled decision behaves like a completed node for status lookups. */
function decisionStatus(outcome: WorkflowDecisionOutcome | undefined) {
  if (!outcome) return null;
  return outcome.evaluated ? "completed" : "not_reached";
}

/**
 * Records one row per settled decision.
 *
 * Load-bearing rather than diagnostic: run finalization reads handled_failures
 * to decide whether a failed step still fails the run. Idempotent on
 * (run, scope, decision) so restarts and duplicate delivery converge.
 *
 * Deliberately records the shape of the outcome and never resolved operand
 * values, matching the redaction rule for condition traces.
 */
export async function persistDecisionEvaluation(
  client: PgClient,
  input: {
    workflowRunId: string;
    scopeKey?: string;
    decision: WorkflowDecision;
    outcome: WorkflowDecisionOutcome;
  },
) {
  const scopeKey = input.scopeKey ?? "root";
  await client.query(
    `
    INSERT INTO execution.workflow_decision_evaluations (
      id, workflow_run_id, decision_id, scope_key, join_mode, decision_kind,
      evaluated, result, taken_branch, handled_failures, reason, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, now())
    ON CONFLICT (workflow_run_id, scope_key, decision_id) DO UPDATE
    SET decision_kind = EXCLUDED.decision_kind,
        evaluated = EXCLUDED.evaluated,
        result = EXCLUDED.result,
        taken_branch = EXCLUDED.taken_branch,
        handled_failures = EXCLUDED.handled_failures,
        reason = EXCLUDED.reason
    `,
    [
      stableId(
        "wfdec",
        `${input.workflowRunId}:${scopeKey}:${input.decision.id}`,
      ),
      input.workflowRunId,
      input.decision.id,
      scopeKey,
      input.decision.joinMode,
      input.decision.kind,
      input.outcome.evaluated,
      input.outcome.result,
      input.outcome.branch,
      JSON.stringify(input.outcome.handledFailures),
      input.outcome.reason,
    ],
  );
}

/** Failed step ids consumed by a decision that evaluated in this run. */
export async function handledFailureStepIds(
  client: PgClient,
  workflowRunId: string,
) {
  const rows = await client.query<Row>(
    `
    SELECT handled_failures
    FROM execution.workflow_decision_evaluations
    WHERE workflow_run_id = $1 AND evaluated = true
    `,
    [workflowRunId],
  );
  const handled = new Set<string>();
  for (const row of rows.rows) {
    const value = row.handled_failures;
    const list = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? safeParseArray(value)
        : [];
    for (const entry of list) {
      if (typeof entry === "string" && entry) handled.add(entry);
    }
  }
  return handled;
}

function safeParseArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stableId(prefix: string, seed: string) {
  return `${prefix}_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

export function workflowDecisionsFromSnapshot(
  value: unknown,
): WorkflowDecision[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? "");
    if (!id) return [];
    const config = objectOf(row.config ?? row.config_json);
    const joinMode =
      String(row.joinMode ?? row.join_mode ?? "all") === "any_settled"
        ? ("any_settled" as const)
        : ("all" as const);
    return [
      {
        id,
        name: String(row.name ?? "Decision"),
        kind: String(row.kind ?? "if") === "switch" ? "switch" : "if",
        enabled: (row.enabled ?? true) !== false,
        joinMode,
        handleFailure: (row.handleFailure ?? row.handle_failure) === true,
        predicate: config.predicate as WorkflowDecision["predicate"],
        cases: Array.isArray(config.cases)
          ? (config.cases as WorkflowDecision["cases"])
          : undefined,
      },
    ];
  });
}

export function workflowDecisionEdgesFromSnapshot(
  value: unknown,
): WorkflowDecisionEdge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? "");
    if (!id) return [];
    const branch = row.branch == null ? undefined : String(row.branch);
    return [
      {
        id,
        fromStepId: optionalId(row.fromStepId ?? row.from_step_id),
        fromDecisionId: optionalId(row.fromDecisionId ?? row.from_decision_id),
        toStepId: optionalId(row.toStepId ?? row.to_step_id),
        toDecisionId: optionalId(row.toDecisionId ?? row.to_decision_id),
        branch: branch && isDecisionBranch(branch) ? branch : undefined,
      },
    ];
  });
}

function isDecisionBranch(
  value: string,
): value is NonNullable<WorkflowDecisionEdge["branch"]> {
  return (
    value === "true" ||
    value === "false" ||
    value === "default" ||
    /^case:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
  );
}

function optionalId(value: unknown) {
  const text = value == null ? "" : String(value);
  return text ? text : undefined;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
