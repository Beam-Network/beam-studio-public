import type { SqlDatabase } from "@beam-studio/db";
import { taskSubjectFor } from "@beam-studio/core";
import type { Row, TaskBroker } from "./types.js";
import { appendExecutionLog, id, now, parseJsonObject } from "./utils.js";

export function maintainDistributedTasks(
  db: SqlDatabase,
  options: {
    batchSize: number;
    logger: { info(payload: unknown, message: string): void };
    broker: TaskBroker;
  },
) {
  replanStaleTaskAssignments(db, options);
  rescueExpiredTasks(db, options);
  publishQueuedTasks(db, options);
  refreshDistributedProgress(db);
}

function publishQueuedTasks(
  db: SqlDatabase,
  options: { batchSize: number; broker: TaskBroker },
) {
  const rows = db
    .prepare(
      `
      SELECT id, task_kind, action_package_name, target_worker_id, nats_subject
      FROM workflow_tasks
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT :limit
    `,
    )
    .all({ limit: options.batchSize }) as Row[];
  for (const row of rows) {
    options.broker.publishTask(taskPublishRequest(row));
  }
}

function rescueExpiredTasks(
  db: SqlDatabase,
  options: {
    batchSize: number;
    logger: { info(payload: unknown, message: string): void };
    broker: TaskBroker;
  },
) {
  const timestamp = now();
  const rows = db
    .prepare(
      `
      SELECT *
      FROM workflow_tasks
      WHERE status = 'running'
        AND lock_expires_at IS NOT NULL
        AND lock_expires_at <= :now
      LIMIT :limit
    `,
    )
    .all({ now: timestamp, limit: options.batchSize }) as Row[];
  for (const row of rows) {
    const exhausted =
      Number(row.attempts ?? 0) >= Number(row.max_attempts ?? 1);
    const status = exhausted ? "dead_letter" : "queued";
    db.prepare(
      `
      UPDATE workflow_tasks
      SET status = :status, locked_by = NULL, lock_expires_at = NULL,
          target_worker_id = CASE WHEN :exhausted = 1 THEN target_worker_id ELSE NULL END,
          error = :error, completed_at = CASE WHEN :exhausted = 1 THEN :completedAt ELSE completed_at END,
          updated_at = :updatedAt
      WHERE id = :id AND status = 'running'
    `,
    ).run({
      id: String(row.id),
      status,
      exhausted: exhausted ? 1 : 0,
      error: exhausted ? "workflow task lock expired" : null,
      completedAt: timestamp,
      updatedAt: timestamp,
    });
    if (exhausted) {
      moveTaskToDeadLetter(db, row, "lock_expired");
      failWorkflowForTask(db, row, "workflow task lock expired");
    } else {
      options.broker.publishTask(
        taskPublishRequest({ ...row, target_worker_id: null }),
      );
    }
  }
  if (rows.length) {
    options.logger.info({ count: rows.length }, "Workflow task leases rescued");
  }
}

function replanStaleTaskAssignments(
  db: SqlDatabase,
  options: { batchSize: number; broker: TaskBroker },
) {
  const rows = db
    .prepare(
      `
      SELECT t.*
      FROM workflow_tasks t
      LEFT JOIN worker_runtime_state w ON w.worker_id = t.target_worker_id
      WHERE t.status = 'queued'
        AND t.target_worker_id IS NOT NULL
        AND (
          w.worker_id IS NULL OR w.status != 'active' OR w.heartbeat_at < :staleAfter
        )
      LIMIT :limit
    `,
    )
    .all({
      staleAfter: new Date(Date.now() - 45_000).toISOString(),
      limit: options.batchSize,
    }) as Row[];
  for (const row of rows) {
    const natsSubject = taskSubjectFor({
      actionPackageName: String(row.action_package_name),
      taskKind: String(row.task_kind),
    });
    db.prepare(
      `
      UPDATE workflow_tasks
      SET target_worker_id = NULL, nats_subject = :natsSubject,
          updated_at = :updatedAt
      WHERE id = :id AND status = 'queued'
    `,
    ).run({ id: String(row.id), natsSubject, updatedAt: now() });
    db.prepare(
      `
      UPDATE execution_plan_shards
      SET assigned_worker_id = NULL, nats_subject = :natsSubject,
          status = 'replanned', updated_at = :updatedAt
      WHERE workflow_task_id = :taskId
    `,
    ).run({ taskId: String(row.id), natsSubject, updatedAt: now() });
    options.broker.publishTask(
      taskPublishRequest({ ...row, nats_subject: natsSubject }),
    );
  }
}

function refreshDistributedProgress(db: SqlDatabase) {
  syncPlanShardStatuses(db);
  const rows = db
    .prepare(
      `
      SELECT sr.*
      FROM workflow_step_runs sr
      WHERE sr.status IN ('queued', 'running')
        AND EXISTS (
          SELECT 1 FROM workflow_tasks t WHERE t.workflow_step_run_id = sr.id
        )
    `,
    )
    .all() as Row[];
  for (const stepRun of rows) {
    const tasks = db
      .prepare(
        "SELECT status, error FROM workflow_tasks WHERE workflow_step_run_id = :id",
      )
      .all({ id: String(stepRun.id) }) as Row[];
    const total = tasks.length;
    const completed = count(tasks, "completed");
    const running = count(tasks, "running");
    const failed = count(tasks, "failed") + count(tasks, "dead_letter");
    const progress = total ? Math.round((completed / total) * 100) : 0;
    const errors = tasks
      .map((task) => task.error && String(task.error))
      .filter((value): value is string => Boolean(value))
      .slice(0, 5);
    const metadata = {
      ...parseJsonObject(stepRun.metadata_json),
      distributedProgress: { total, completed, running, failed, progress },
      shardErrors: errors,
    };
    db.prepare(
      `
      UPDATE workflow_step_runs
      SET metadata_json = :metadataJson,
          status = CASE WHEN :running > 0 THEN 'running' ELSE status END,
          updated_at = :updatedAt
      WHERE id = :id
    `,
    ).run({
      id: String(stepRun.id),
      running,
      metadataJson: JSON.stringify(metadata),
      updatedAt: now(),
    });
  }
}

function syncPlanShardStatuses(db: SqlDatabase) {
  db.prepare(
    `
    UPDATE execution_plan_shards
    SET status = COALESCE((
          SELECT status FROM workflow_tasks WHERE workflow_tasks.id = workflow_task_id
        ), status),
        output_checksum = COALESCE((
          SELECT output_checksum FROM workflow_tasks WHERE workflow_tasks.id = workflow_task_id
        ), output_checksum),
        updated_at = :updatedAt
    WHERE workflow_task_id IS NOT NULL
  `,
  ).run({ updatedAt: now() });
}

function taskPublishRequest(row: Row) {
  return {
    taskId: String(row.id),
    taskKind: String(row.task_kind),
    actionPackageName: String(row.action_package_name),
    targetWorkerId: row.target_worker_id ? String(row.target_worker_id) : null,
    subject: row.nats_subject ? String(row.nats_subject) : null,
  };
}

function moveTaskToDeadLetter(db: SqlDatabase, row: Row, reason: string) {
  const timestamp = now();
  db.prepare(
    `
    INSERT OR IGNORE INTO workflow_task_dead_letters (
      id, workflow_task_id, workflow_run_id, workflow_step_run_id,
      reason, error, attempts, max_attempts, payload_json, created_at
    )
    VALUES (
      :id, :taskId, :workflowRunId, :workflowStepRunId,
      :reason, :error, :attempts, :maxAttempts, :payloadJson, :createdAt
    )
  `,
  ).run({
    id: id("wftdl"),
    taskId: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    workflowStepRunId: row.workflow_step_run_id
      ? String(row.workflow_step_run_id)
      : null,
    reason,
    error: String(row.error ?? reason),
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
    payloadJson: JSON.stringify(row),
    createdAt: timestamp,
  });
}

function failWorkflowForTask(db: SqlDatabase, row: Row, error: string) {
  const timestamp = now();
  db.prepare(
    "UPDATE workflow_step_runs SET status = 'failed', error = :error, completed_at = :completedAt, updated_at = :updatedAt WHERE id = :id",
  ).run({
    id: String(row.workflow_step_run_id),
    error,
    completedAt: timestamp,
    updatedAt: timestamp,
  });
  db.prepare(
    "UPDATE workflow_runs SET status = 'failed', error = :error, completed_at = COALESCE(completed_at, :completedAt), updated_at = :updatedAt WHERE id = :id AND status IN ('queued', 'running', 'cancel_requested')",
  ).run({
    id: String(row.workflow_run_id),
    error,
    completedAt: timestamp,
    updatedAt: timestamp,
  });
  appendExecutionLog(db, "workflow_task_dead_lettered", {
    workflowRunId: String(row.workflow_run_id),
    workflowTaskId: String(row.id),
    error,
  });
}

function count(rows: Row[], status: string) {
  return rows.filter((row) => row.status === status).length;
}
