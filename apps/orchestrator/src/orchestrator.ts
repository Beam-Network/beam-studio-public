import type { SqlDatabase } from "@beam-studio/db";
import crypto from "node:crypto";
import {
  evaluateEdgeCondition,
  resolveInputBindings,
  type ActionJson,
  type ActionResult,
} from "@beam-studio/core";
import type { ApiWorkflowStep, OrchestratorOptions, Row } from "./types.js";
import {
  createStepRunAndTasks,
  enqueueReduceTaskIfReady,
} from "./taskEnqueue.js";
import { maintainDistributedTasks } from "./taskMaintenance.js";
import {
  appendExecutionLog,
  now,
  parseJsonObject,
  parseJsonArray,
  transaction,
  workflowEdgesFromSnapshot,
  workflowStepFromSnapshot,
} from "./utils.js";

export function orchestrate(db: SqlDatabase, options: OrchestratorOptions) {
  maintainDistributedTasks(db, options);
  activateQueuedRuns(db, options);
  const rows = db
    .prepare(
      `
      SELECT *
      FROM workflow_runs
      WHERE legacy_run_id IS NULL
        AND status IN ('running', 'cancel_requested')
      ORDER BY COALESCE(queued_at, created_at) ASC
      LIMIT :limit
    `,
    )
    .all({ limit: options.batchSize }) as Row[];

  for (const row of rows) {
    transaction(db, () => orchestrateRun(db, row, options));
  }
}

function activateQueuedRuns(db: SqlDatabase, options: OrchestratorOptions) {
  const timestamp = now();
  const rows = db
    .prepare(
      `
      SELECT id, workflow_template_id
      FROM workflow_runs
      WHERE status = 'queued'
        AND legacy_run_id IS NULL
        AND COALESCE(queued_at, created_at) <= :now
      ORDER BY COALESCE(queued_at, created_at) ASC
      LIMIT :limit
    `,
    )
    .all({ now: timestamp, limit: options.batchSize }) as Row[];

  for (const row of rows) {
    const result = db
      .prepare(
        `
        UPDATE workflow_runs
        SET status = 'running',
            started_at = COALESCE(started_at, :startedAt),
            updated_at = :updatedAt,
            error = NULL
        WHERE id = :id AND status = 'queued' AND legacy_run_id IS NULL
      `,
      )
      .run({ id: String(row.id), startedAt: timestamp, updatedAt: timestamp });
    if (result.changes) {
      appendExecutionLog(db, "workflow_run_activated", {
        workflowRunId: String(row.id),
        workflowTemplateId: String(row.workflow_template_id),
      });
    }
  }
}

function orchestrateRun(
  db: SqlDatabase,
  row: Row,
  options: OrchestratorOptions,
) {
  const workflowRunId = String(row.id);
  if (String(row.status) === "cancel_requested") {
    cancelQueuedTasks(db, workflowRunId);
    if (!hasActiveTasks(db, workflowRunId)) {
      finishRun(db, workflowRunId, "cancelled", "cancellation requested");
    }
    return;
  }

  const templateSnapshot = parseJsonObject(row.template_snapshot_json);
  const runtimeInputs = parseJsonObject(row.input_json) as Record<
    string,
    ActionJson
  >;
  const steps = parseJsonArray(row.resolved_steps_json)
    .filter((step): step is Row => Boolean(step && typeof step === "object"))
    .map((step, index) => workflowStepFromSnapshot(step, index))
    .filter((step) => step.enabled);
  const stepRuns = workflowStepRunRows(db, workflowRunId);
  const stepRunsByStepId = new Map(
    stepRuns.map((stepRun) => [String(stepRun.workflow_step_id), stepRun]),
  );

  if (finishIfTerminal(db, workflowRunId, steps, stepRunsByStepId)) {
    return;
  }

  for (const step of steps) {
    const stepRun = stepRunsByStepId.get(step.id);
    if (stepRun?.status === "queued" || stepRun?.status === "running") {
      enqueueReduceTaskIfReady(
        db,
        step,
        stepRun,
        options.broker,
        options.taskSubjectRoot,
      );
    }
  }

  const edges = workflowEdgesFromSnapshot(templateSnapshot);
  const outputsByStep = workflowOutputsByStep(stepRuns);
  // Status, error and config exist for every step, unlike outputs, so a
  // failure branch can still describe what went wrong.
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const stepsById = new Map(
    steps.map((step) => {
      const stepRun = stepRuns.find(
        (row) => String(row.workflow_step_id) === step.id,
      );
      return [
        step.id,
        {
          id: step.id,
          status: stepRun ? String(stepRun.status) : "not_reached",
          error: stepRun?.error == null ? null : String(stepRun.error),
          name: stepById.get(step.id)?.name ?? null,
          action: step.actionPackage,
          config: step.config,
        },
      ] as const;
    }),
  );
  const artifactsByStep = workflowArtifactsByStep(db, stepRuns);
  for (const step of steps) {
    if (stepRunsByStepId.has(step.id)) {
      continue;
    }
    const incoming = edges.filter((edge) => edge.to === step.id);
    if (!incoming.every((edge) => isSettled(stepRunsByStepId.get(edge.from)))) {
      continue;
    }
    const shouldRun =
      incoming.length === 0 ||
      incoming.some(
        (edge) =>
          stepRunsByStepId.get(edge.from)?.status !== "skipped" &&
          evaluateEdgeCondition(
            edge.condition,
            runtimeInputs,
            templateSnapshot as Record<string, ActionJson>,
            outputsByStep,
            artifactsByStep,
          ),
      );
    if (!shouldRun) {
      createSkippedStepRun(db, workflowRunId, step);
      continue;
    }
    createStepRunAndTasks(
      db,
      workflowRunId,
      step,
      resolveInputBindings(
        step.inputBindings,
        runtimeInputs,
        templateSnapshot as Record<string, ActionJson>,
        outputsByStep,
        artifactsByStep,
        { stepsById },
      ),
      options.maxAttempts,
      options.broker,
      options.taskSubjectRoot,
    );
  }
}

function finishIfTerminal(
  db: SqlDatabase,
  workflowRunId: string,
  steps: ApiWorkflowStep[],
  stepRunsByStepId: Map<string, Row>,
) {
  const failedRequired = steps.find((step) => {
    const stepRun = stepRunsByStepId.get(step.id);
    return stepRun?.status === "failed" && step.required !== false;
  });
  if (failedRequired) {
    finishRun(
      db,
      workflowRunId,
      "failed",
      String(
        stepRunsByStepId.get(failedRequired.id)?.error ??
          "workflow step failed",
      ),
    );
    return true;
  }
  if (
    steps.length > 0 &&
    steps.every((step) => isSettled(stepRunsByStepId.get(step.id))) &&
    !hasActiveTasks(db, workflowRunId)
  ) {
    finishRun(db, workflowRunId, "completed", null);
    return true;
  }
  return false;
}

function workflowStepRunRows(db: SqlDatabase, workflowRunId: string) {
  return db
    .prepare(
      "SELECT * FROM workflow_step_runs WHERE workflow_run_id = :workflowRunId",
    )
    .all({ workflowRunId }) as Row[];
}

function workflowOutputsByStep(stepRuns: Row[]) {
  const outputs = new Map<string, Record<string, ActionJson>>();
  for (const stepRun of stepRuns) {
    if (stepRun.status === "completed") {
      outputs.set(
        String(stepRun.workflow_step_id),
        parseJsonObject(stepRun.output_json) as Record<string, ActionJson>,
      );
    }
  }
  return outputs;
}

function workflowArtifactsByStep(db: SqlDatabase, stepRuns: Row[]) {
  const artifactsByStepRunId = new Map<string, ActionResult["artifacts"]>();
  if (stepRuns.length) {
    const artifacts = db
      .prepare(
        `SELECT * FROM workflow_artifacts WHERE workflow_step_run_id IN (${stepRuns.map(() => "?").join(",")})`,
      )
      .all(...stepRuns.map((stepRun) => String(stepRun.id))) as Row[];
    for (const artifact of artifacts) {
      const values =
        artifactsByStepRunId.get(String(artifact.workflow_step_run_id)) ?? [];
      values.push({
        id: String(artifact.id),
        name: String(artifact.name),
        type: String(artifact.type),
        uri: String(artifact.uri),
        mediaType: artifact.media_type
          ? String(artifact.media_type)
          : undefined,
        metadata: parseJsonObject(artifact.metadata_json) as Record<
          string,
          ActionJson
        >,
      });
      artifactsByStepRunId.set(String(artifact.workflow_step_run_id), values);
    }
  }
  return new Map(
    stepRuns.map((stepRun) => [
      String(stepRun.workflow_step_id),
      artifactsByStepRunId.get(String(stepRun.id)) ?? [],
    ]),
  );
}

function isSettled(stepRun: Row | undefined) {
  return stepRun?.status === "completed" || stepRun?.status === "skipped";
}

function createSkippedStepRun(
  db: SqlDatabase,
  workflowRunId: string,
  step: ApiWorkflowStep,
) {
  const timestamp = now();
  db.prepare(
    `
    INSERT OR IGNORE INTO workflow_step_runs (
      id, workflow_run_id, workflow_step_id, action_package_name,
      resolved_version, checksum, source_registry, resolved_placement,
      execution_location_id, status, attempt, input_json, output_json,
      metadata_json, state_json, external_ref, error, started_at,
      completed_at, created_at, updated_at
    )
    VALUES (
      :id, :workflowRunId, :workflowStepId, :actionPackageName,
      :resolvedVersion, :checksum, 'builtin', :resolvedPlacement,
      :executionLocationId, 'skipped', 1, '{}', '{}',
      :metadataJson, '{}', NULL, NULL, NULL,
      :completedAt, :createdAt, :updatedAt
    )
  `,
  ).run({
    id: `wsr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    workflowRunId,
    workflowStepId: step.id,
    actionPackageName: step.actionPackage,
    resolvedVersion: step.resolvedVersion ?? "1.0.0",
    checksum: step.checksum ?? "",
    resolvedPlacement:
      step.resolvedPlacement ?? step.placement ?? "local-workers",
    executionLocationId: step.executionLocationId ?? null,
    metadataJson: JSON.stringify({ reason: "incoming_conditions_not_met" }),
    completedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function cancelQueuedTasks(db: SqlDatabase, workflowRunId: string) {
  db.prepare(
    "UPDATE workflow_tasks SET status = 'cancelled', updated_at = :updatedAt WHERE workflow_run_id = :workflowRunId AND status = 'queued'",
  ).run({ workflowRunId, updatedAt: now() });
}

function hasActiveTasks(db: SqlDatabase, workflowRunId: string) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM workflow_tasks WHERE workflow_run_id = :workflowRunId AND status IN ('queued', 'running')",
    )
    .get({ workflowRunId }) as Row | undefined;
  return Number(row?.count ?? 0) > 0;
}

function finishRun(
  db: SqlDatabase,
  workflowRunId: string,
  status: "completed" | "failed" | "cancelled",
  error: string | null,
) {
  db.prepare(
    `
    UPDATE workflow_runs
    SET status = :status, error = :error,
        completed_at = COALESCE(completed_at, :completedAt),
        updated_at = :updatedAt
    WHERE id = :id AND status IN ('queued', 'running', 'cancel_requested')
  `,
  ).run({
    id: workflowRunId,
    status,
    error,
    completedAt: now(),
    updatedAt: now(),
  });
}
