import crypto from "node:crypto";
import type { SqlDatabase } from "@beam-studio/db";
import type { ActionJson } from "@beam-studio/core";
import { id, now } from "./utils.js";

export type ExecutionPlanMode = "single" | "map-reduce" | "hierarchical-reduce";

export type PlanShardInput = {
  executionPlanId: string;
  workflowTaskId: string;
  shardIndex: number | null;
  shardKind: string;
  assignedWorkerId: string | null;
  natsSubject: string;
  inputWeight: number;
  sourceLocality: string | null;
  destinationLocality: string | null;
  metadata?: Record<string, ActionJson>;
};

export function createExecutionPlan(
  db: SqlDatabase,
  input: {
    workflowRunId: string;
    workflowStepRunId: string;
    workflowStepId: string;
    mode: ExecutionPlanMode;
    shardCount: number;
    metadata?: Record<string, ActionJson>;
  },
) {
  const timestamp = now();
  const executionPlanId = id("wfp");
  db.prepare(
    `
    INSERT INTO execution_plans (
      id, workflow_run_id, workflow_step_run_id, workflow_step_id,
      status, mode, shard_count, metadata_json, created_at, updated_at
    )
    VALUES (
      :id, :workflowRunId, :workflowStepRunId, :workflowStepId,
      'planned', :mode, :shardCount, :metadataJson, :createdAt, :updatedAt
    )
  `,
  ).run({
    id: executionPlanId,
    workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
    workflowStepId: input.workflowStepId,
    mode: input.mode,
    shardCount: input.shardCount,
    metadataJson: JSON.stringify(input.metadata ?? {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return executionPlanId;
}

export function recordPlanShard(db: SqlDatabase, input: PlanShardInput) {
  const timestamp = now();
  db.prepare(
    `
    INSERT OR IGNORE INTO execution_plan_shards (
      id, execution_plan_id, workflow_task_id, shard_index, shard_kind,
      assigned_worker_id, nats_subject, status, input_weight,
      source_locality, destination_locality, output_checksum,
      metadata_json, created_at, updated_at
    )
    VALUES (
      :id, :executionPlanId, :workflowTaskId, :shardIndex, :shardKind,
      :assignedWorkerId, :natsSubject, 'planned', :inputWeight,
      :sourceLocality, :destinationLocality, NULL,
      :metadataJson, :createdAt, :updatedAt
    )
  `,
  ).run({
    id: id("wfps"),
    executionPlanId: input.executionPlanId,
    workflowTaskId: input.workflowTaskId,
    shardIndex: input.shardIndex,
    shardKind: input.shardKind,
    assignedWorkerId: input.assignedWorkerId,
    natsSubject: input.natsSubject,
    inputWeight: input.inputWeight,
    sourceLocality: input.sourceLocality,
    destinationLocality: input.destinationLocality,
    metadataJson: JSON.stringify(input.metadata ?? {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function taskIdempotencyKey(input: {
  workflowStepRunId: string;
  taskKind: string;
  shardIndex?: number | null;
  input: Record<string, ActionJson>;
}) {
  return checksumJson({
    stepRunId: input.workflowStepRunId,
    taskKind: input.taskKind,
    shardIndex: input.shardIndex ?? null,
    input: input.input,
  });
}

export function checksumJson(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function estimateInputWeight(input: Record<string, ActionJson>) {
  return Buffer.byteLength(JSON.stringify(input));
}
