import type { SqlDatabase } from "@beam-studio/db";
import {
  createBuiltinActionRegistry,
  type ActionJson,
} from "@beam-studio/core";
import {
  createPartitionPlan,
  groupIndexes,
  type PartitionPlan,
} from "./distributedPartitioning.js";
import { createExecutionPlan, estimateInputWeight } from "./executionPlan.js";
import { estimateGlobalLoad } from "./placementScheduler.js";
import type { ApiWorkflowStep, Row, TaskBroker } from "./types.js";
import { enqueueWorkflowTask } from "./workflowTaskPublisher.js";
import { id, now, parseJsonObject } from "./utils.js";

export function createStepRunAndTasks(
  db: SqlDatabase,
  workflowRunId: string,
  step: ApiWorkflowStep,
  inputs: Record<string, ActionJson>,
  maxAttempts: number,
  broker: TaskBroker,
  subjectRoot?: string,
) {
  const registry = createBuiltinActionRegistry();
  const resolvedPackage = registry.resolvePackage(
    step.actionPackage,
    step.versionRange,
  );
  const timestamp = now();
  const stepRunId = id("wsr");
  const result = db.prepare(stepRunSql()).run({
    id: stepRunId,
    workflowRunId,
    workflowStepId: step.id,
    actionPackageName: step.actionPackage,
    resolvedVersion: step.resolvedVersion ?? resolvedPackage.manifest.version,
    checksum: step.checksum ?? resolvedPackage.checksum,
    sourceRegistry: step.sourceRegistry ?? "builtin",
    resolvedPlacement:
      step.resolvedPlacement ?? step.placement ?? "local-workers",
    executionLocationId: step.executionLocationId ?? null,
    inputJson: JSON.stringify(inputs),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  if (!result.changes) {
    return;
  }

  const distribution = resolvedPackage.manifest.execution?.distribution;
  const values = distribution ? inputs[distribution.inputKey] : null;
  if (
    resolvedPackage.manifest.execution?.taskMode === "distributed-workers" &&
    distribution?.mode === "partitioned-reduce" &&
    Array.isArray(values) &&
    values.length > Math.max(1, distribution.preferredItemsPerTask ?? 8)
  ) {
    enqueuePartitionedStep(db, workflowRunId, stepRunId, step, inputs, {
      inputKey: distribution.inputKey,
      values,
      preferredItemsPerTask: distribution.preferredItemsPerTask ?? 8,
      maxParallelism: distribution.maxParallelism ?? 8,
      partitionPlanVersion: distribution.partitionPlanVersion,
      timestamp,
      maxAttempts,
      broker,
      subjectRoot,
    });
    return;
  }

  const planId = createExecutionPlan(db, {
    workflowRunId,
    workflowStepRunId: stepRunId,
    workflowStepId: step.id,
    mode: "single",
    shardCount: 1,
  });
  enqueueWorkflowTask(db, {
    workflowRunId,
    workflowStepRunId: stepRunId,
    workflowStepId: step.id,
    actionPackageName: step.actionPackage,
    taskKind: "step",
    input: inputs,
    createdAt: timestamp,
    maxAttempts,
    broker,
    planId,
    subjectRoot,
    targetWorkerId: requestedWorkerId(step, inputs),
  });
}

export function enqueueReduceTaskIfReady(
  db: SqlDatabase,
  step: ApiWorkflowStep,
  stepRun: Row,
  broker: TaskBroker,
  subjectRoot?: string,
) {
  const registry = createBuiltinActionRegistry();
  const resolvedPackage = registry.resolvePackage(
    step.actionPackage,
    step.versionRange,
  );
  const distribution = resolvedPackage.manifest.execution?.distribution;
  if (
    resolvedPackage.manifest.execution?.taskMode !== "distributed-workers" ||
    distribution?.mode !== "partitioned-reduce"
  ) {
    return;
  }

  const stepRunId = String(stepRun.id);
  const tasks = db.prepare(taskRowsSql()).all({ stepRunId }) as Row[];
  if (tasks.some((task) => String(task.task_kind) === "step-reduce")) {
    return;
  }
  const plan = executionPlanRow(db, stepRunId);
  const shards = tasks.filter(
    (task) => String(task.task_kind) === "step-shard",
  );
  if (!shards.length || shards.some((task) => task.status !== "completed")) {
    return;
  }
  const baseInputs = parseJsonObject(stepRun.input_json) as Record<
    string,
    ActionJson
  >;

  if (
    plan?.mode === "hierarchical-reduce" &&
    !tasks.some((task) => task.task_kind === "step-intermediate-reduce")
  ) {
    enqueueIntermediateReduces(db, step, stepRun, shards, baseInputs, {
      outputKey: distribution.outputKey,
      inputKey: distribution.inputKey,
      groupSize: intermediateGroupSize(plan),
      maxAttempts: 3,
      broker,
      subjectRoot,
      planId: String(plan.id),
    });
    return;
  }

  const reduceSources =
    plan?.mode === "hierarchical-reduce"
      ? tasks.filter((task) => task.task_kind === "step-intermediate-reduce")
      : shards;
  if (
    !reduceSources.length ||
    reduceSources.some((task) => task.status !== "completed")
  ) {
    return;
  }
  enqueueFinalReduce(db, step, stepRun, reduceSources, baseInputs, {
    inputKey: distribution.inputKey,
    outputKey: distribution.outputKey,
    maxAttempts: 3,
    broker,
    subjectRoot,
    planId: plan ? String(plan.id) : null,
  });
}

function enqueuePartitionedStep(
  db: SqlDatabase,
  workflowRunId: string,
  stepRunId: string,
  step: ApiWorkflowStep,
  inputs: Record<string, ActionJson>,
  options: {
    inputKey: string;
    values: ActionJson[];
    preferredItemsPerTask: number;
    maxParallelism: number;
    partitionPlanVersion?: "logical/v1";
    timestamp: string;
    maxAttempts: number;
    broker: TaskBroker;
    subjectRoot?: string;
  },
) {
  const load = estimateGlobalLoad(db);
  const plan = createPartitionPlan(options.values, {
    preferredItemsPerTask: options.preferredItemsPerTask,
    maxParallelism: options.maxParallelism,
    activeWorkers: load.activeWorkerCount,
    estimatedInputWeight: estimateInputWeight(inputs),
    averageLoadScore: load.averageLoadScore,
    partitionPlanVersion: options.partitionPlanVersion,
  });
  const planId = createExecutionPlan(db, {
    workflowRunId,
    workflowStepRunId: stepRunId,
    workflowStepId: step.id,
    mode: plan.mode,
    shardCount: plan.shards.length,
    metadata: {
      intermediateGroupSize: plan.intermediateGroupSize,
      adaptiveReason: "workers,input-weight,observed-load",
      ...(options.partitionPlanVersion
        ? {
            partitionPlanVersion: options.partitionPlanVersion,
            maxParallelism: options.maxParallelism,
          }
        : {}),
    },
  });
  enqueueShardTasks(db, workflowRunId, stepRunId, step, inputs, options, {
    plan,
    planId,
  });
}

function enqueueShardTasks(
  db: SqlDatabase,
  workflowRunId: string,
  stepRunId: string,
  step: ApiWorkflowStep,
  inputs: Record<string, ActionJson>,
  options: {
    inputKey: string;
    timestamp: string;
    maxAttempts: number;
    broker: TaskBroker;
    subjectRoot?: string;
  },
  planInput: { plan: PartitionPlan; planId: string },
) {
  planInput.plan.shards.forEach((values, index) => {
    enqueueWorkflowTask(db, {
      workflowRunId,
      workflowStepRunId: stepRunId,
      workflowStepId: step.id,
      actionPackageName: step.actionPackage,
      taskKind: "step-shard",
      shardIndex: index,
      shardCount: planInput.plan.shards.length,
      input: { ...inputs, [options.inputKey]: values },
      createdAt: options.timestamp,
      maxAttempts: options.maxAttempts,
      broker: options.broker,
      planId: planInput.planId,
      subjectRoot: options.subjectRoot,
      targetWorkerId: requestedWorkerId(step, inputs),
    });
  });
}

function enqueueIntermediateReduces(
  db: SqlDatabase,
  step: ApiWorkflowStep,
  stepRun: Row,
  shardTasks: Row[],
  baseInputs: Record<string, ActionJson>,
  options: ReduceOptions & { groupSize: number },
) {
  const groups = groupIndexes(shardTasks.length, options.groupSize);
  groups.forEach((indexes, groupIndex) => {
    const values = indexes.map((index) => {
      const task = shardTasks[index];
      return task ? outputValue(task, options.outputKey) : null;
    });
    enqueueWorkflowTask(db, {
      workflowRunId: String(stepRun.workflow_run_id),
      workflowStepRunId: String(stepRun.id),
      workflowStepId: step.id,
      actionPackageName: step.actionPackage,
      taskKind: "step-intermediate-reduce",
      shardIndex: groupIndex,
      shardCount: groups.length,
      input: { ...baseInputs, [options.inputKey]: values },
      createdAt: now(),
      maxAttempts: options.maxAttempts,
      broker: options.broker,
      planId: options.planId,
      subjectRoot: options.subjectRoot,
      targetWorkerId: requestedWorkerId(step, baseInputs),
    });
  });
}

function enqueueFinalReduce(
  db: SqlDatabase,
  step: ApiWorkflowStep,
  stepRun: Row,
  sources: Row[],
  baseInputs: Record<string, ActionJson>,
  options: ReduceOptions,
) {
  enqueueWorkflowTask(db, {
    workflowRunId: String(stepRun.workflow_run_id),
    workflowStepRunId: String(stepRun.id),
    workflowStepId: step.id,
    actionPackageName: step.actionPackage,
    taskKind: "step-reduce",
    input: {
      ...baseInputs,
      [options.inputKey]: sources.map((task) =>
        outputValue(task, options.outputKey),
      ),
    },
    createdAt: now(),
    maxAttempts: options.maxAttempts,
    broker: options.broker,
    planId: options.planId,
    subjectRoot: options.subjectRoot,
    targetWorkerId: requestedWorkerId(step, baseInputs),
  });
}

type ReduceOptions = {
  inputKey: string;
  outputKey: string;
  maxAttempts: number;
  broker: TaskBroker;
  subjectRoot?: string;
  planId: string | null;
};

function stepRunSql() {
  return `
    INSERT OR IGNORE INTO workflow_step_runs (
      id, workflow_run_id, workflow_step_id, action_package_name,
      resolved_version, checksum, source_registry, resolved_placement,
      execution_location_id, status, attempt, input_json, output_json,
      metadata_json, state_json, external_ref, error, started_at,
      completed_at, created_at, updated_at
    )
    VALUES (
      :id, :workflowRunId, :workflowStepId, :actionPackageName,
      :resolvedVersion, :checksum, :sourceRegistry, :resolvedPlacement,
      :executionLocationId, 'queued', 1, :inputJson, '{}',
      '{}', '{}', NULL, NULL, NULL, NULL, :createdAt, :updatedAt
    )
  `;
}

function taskRowsSql() {
  return `
    SELECT *
    FROM workflow_tasks
    WHERE workflow_step_run_id = :stepRunId
    ORDER BY task_kind, COALESCE(shard_index, 999999), created_at
  `;
}

function executionPlanRow(db: SqlDatabase, stepRunId: string) {
  return db
    .prepare("SELECT * FROM execution_plans WHERE workflow_step_run_id = :id")
    .get({ id: stepRunId }) as Row | undefined;
}

function outputValue(task: Row, outputKey: string) {
  const output = parseJsonObject(task.output_json) as Record<
    string,
    ActionJson
  >;
  return output[outputKey] ?? output.value ?? output;
}

function intermediateGroupSize(plan: Row) {
  const metadata = parseJsonObject(plan.metadata_json);
  return Math.max(2, Number(metadata.intermediateGroupSize ?? 4));
}

function requestedWorkerId(
  step: ApiWorkflowStep,
  inputs: Record<string, ActionJson>,
) {
  const fromInput = text(inputs.__targetWorkerId ?? inputs.targetWorkerId);
  const fromConfig = text(step.config?.targetWorkerId);
  const fromLocation = step.executionLocationId?.startsWith("worker:")
    ? step.executionLocationId.slice("worker:".length)
    : "";
  return fromInput || fromConfig || fromLocation || null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
