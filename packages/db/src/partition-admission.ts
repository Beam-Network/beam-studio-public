import { pgOne, type PgClient } from "./postgres.js";

/** Call inside the task-claim transaction before changing task status.
 * The plan row serializes claims for different tasks in the same logical plan.
 * Historical plans without logical/v1 keep their original admission behavior.
 */
export async function lockLogicalPartitionAdmissionPg(
  client: PgClient,
  taskId: string,
): Promise<boolean> {
  const plan = await pgOne<{
    id: string;
    metadata_json: Record<string, unknown>;
  }>(
    client,
    `SELECT plan.id,plan.metadata_json FROM execution.execution_plans plan
     JOIN execution.execution_plan_shards shard ON shard.execution_plan_id=plan.id
     WHERE shard.workflow_task_id=$1 FOR UPDATE OF plan`,
    [taskId],
  );
  if (plan?.metadata_json.partitionPlanVersion !== "logical/v1") return true;
  const limit = Number(plan.metadata_json.maxParallelism);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Invalid frozen logical partition admission limit.");
  const active = await pgOne<{ count: number }>(
    client,
    `SELECT count(*)::int AS count FROM execution.execution_plan_shards shard
     JOIN execution.workflow_tasks task ON task.id=shard.workflow_task_id
     WHERE shard.execution_plan_id=$1 AND (
       task.status IN ('leased','running') OR EXISTS (
         SELECT 1 FROM execution.executor_assignments assignment
         WHERE assignment.task_id=task.id AND assignment.cleanup_confirmed_at IS NULL
       )
     )`,
    [plan.id],
  );
  return Number(active?.count ?? 0) < limit;
}
