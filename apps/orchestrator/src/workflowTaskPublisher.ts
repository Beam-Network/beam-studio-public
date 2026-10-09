import type { SqlDatabase } from "@beam-studio/db";
import {
  retryPolicyForTask,
  taskSubjectFor,
  type ActionJson,
} from "@beam-studio/core";
import {
  checksumJson,
  estimateInputWeight,
  recordPlanShard,
  taskIdempotencyKey,
} from "./executionPlan.js";
import { selectWorker } from "./placementScheduler.js";
import type { TaskBroker } from "./types.js";
import { id } from "./utils.js";

export type EnqueueWorkflowTaskInput = {
  workflowRunId: string;
  workflowStepRunId: string;
  workflowStepId: string;
  actionPackageName: string;
  taskKind: string;
  shardIndex?: number | null;
  shardCount?: number | null;
  input: Record<string, ActionJson>;
  createdAt: string;
  maxAttempts: number;
  broker: TaskBroker;
  planId: string | null;
  subjectRoot?: string;
  targetWorkerId?: string | null;
};

export function enqueueWorkflowTask(
  db: SqlDatabase,
  input: EnqueueWorkflowTaskInput,
) {
  const placement = selectWorker(db, {
    actionPackageName: input.actionPackageName,
    taskKind: input.taskKind,
    inputs: input.input,
    targetWorkerId: input.targetWorkerId,
  });
  const natsSubject = taskSubjectFor({
    root: input.subjectRoot,
    actionPackageName: input.actionPackageName,
    taskKind: input.taskKind,
    targetWorkerId: placement.workerId,
  });
  const policy = retryPolicyForTask(placement.capability, input.maxAttempts);
  const taskId = id("wftask");
  const result = db.prepare(taskInsertSql()).run({
    id: taskId,
    workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
    workflowStepId: input.workflowStepId,
    actionPackageName: input.actionPackageName,
    taskKind: input.taskKind,
    shardIndex: input.shardIndex ?? null,
    shardCount: input.shardCount ?? null,
    inputJson: JSON.stringify(input.input),
    maxAttempts: policy.maxAttempts,
    retryPolicyJson: JSON.stringify(policy),
    targetWorkerId: placement.workerId,
    natsSubject,
    idempotencyKey: taskIdempotencyKey(input),
    inputChecksum: checksumJson(input.input),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  if (!result.changes) {
    return;
  }
  if (input.planId) {
    recordPlanShard(db, {
      executionPlanId: input.planId,
      workflowTaskId: taskId,
      shardIndex: input.shardIndex ?? null,
      shardKind: input.taskKind,
      assignedWorkerId: placement.workerId,
      natsSubject,
      inputWeight: estimateInputWeight(input.input),
      sourceLocality: placement.sourceLocality,
      destinationLocality: placement.destinationLocality,
      metadata: { capability: placement.capability },
    });
  }
  input.broker.publishTask({
    taskId,
    taskKind: input.taskKind,
    actionPackageName: input.actionPackageName,
    targetWorkerId: placement.workerId,
    subject: natsSubject,
  });
}

function taskInsertSql() {
  return `
    INSERT OR IGNORE INTO workflow_tasks (
      id, workflow_run_id, workflow_step_run_id, workflow_step_id,
      action_package_name, task_kind, shard_index, shard_count, status,
      input_json, output_json, metadata_json, error, attempts, max_attempts,
      retry_policy_json, target_worker_id, nats_subject, idempotency_key,
      input_checksum, output_checksum, locked_by, lock_expires_at,
      started_at, completed_at, created_at, updated_at
    )
    VALUES (
      :id, :workflowRunId, :workflowStepRunId, :workflowStepId,
      :actionPackageName, :taskKind, :shardIndex, :shardCount, 'queued',
      :inputJson, '{}', '{}', NULL, 0, :maxAttempts,
      :retryPolicyJson, :targetWorkerId, :natsSubject, :idempotencyKey,
      :inputChecksum, NULL, NULL, NULL, NULL, NULL, :createdAt, :updatedAt
    )
  `;
}
