import {
  pgOne,
  type PgClient,
  WorkflowAuthorizationError,
} from "@beam-studio/db";
import { createHash } from "node:crypto";

type Row = Record<string, any>;

/** Rebuild per-member ring config from the persisted plan, never from a fresh
 * room listing or a mutable task payload. Retries receive the same tuple. */
export async function frozenV3LoopInvocationConfigPg(
  client: PgClient,
  task: Row,
  step: Row,
  stepRunId: string,
  memberId: string,
  baseConfig: Row,
): Promise<Row> {
  const frozen = task.metadata_json?.v3Loop;
  const seed = task.metadata_json?.v3Seed;
  if (!frozen && !seed) return baseConfig;
  const deny = (): never => {
    throw new WorkflowAuthorizationError(
      "executor_v3_loop_plan_invalid",
      "Ring invocation differs from its frozen iteration plan.",
    );
  };
  const logical = task.metadata_json?.logicalPartition;
  if (seed) {
    const identity = createHash("sha256")
      .update(`${task.workflow_run_id}:${memberId}`)
      .digest("hex");
    const row = await pgOne<{ plan_json: Row }>(
      client,
      `SELECT p.plan_json FROM execution.execution_plans p
       JOIN execution.execution_plan_shards s ON s.execution_plan_id=p.id
       WHERE s.workflow_task_id=$1 AND p.workflow_step_run_id=$2`,
      [task.id, stepRunId],
    );
    const expected = row?.plan_json?.seed?.targets?.[logical?.id];
    if (
      frozen ||
      row?.plan_json?.graphVersion !== "workflow-graph/v3" ||
      logical?.version !== "logical/v1" ||
      logical.memberId !== memberId ||
      seed.memberId !== memberId ||
      seed.batchId !== `batch-${identity}` ||
      seed.lotId !== `lot-${identity}` ||
      expected?.scopeId !== seed.scopeId ||
      expected?.memberId !== memberId ||
      expected?.batchId !== seed.batchId ||
      expected?.lotId !== seed.lotId ||
      !row?.plan_json?.selectedMemberIds?.includes(memberId) ||
      !Array.isArray(row?.plan_json?.routes) ||
      !row.plan_json.routes.some(
        (route: Row) =>
          route.from?.stepId === task.workflow_step_id &&
          route.from?.memberId === memberId &&
          route.to?.memberId === memberId,
      )
    )
      deny();
    const overlay = {
      memberId,
      batchId: seed.batchId,
      lotId: seed.lotId,
    };
    return step.actionPackage === "@beam/ring-batch-seed"
      ? overlay
      : { ...baseConfig, ...overlay };
  }
  if (
    logical?.version !== "logical/v1" ||
    logical.memberId !== memberId ||
    frozen.sourceMemberId !== memberId ||
    typeof frozen.targetMemberId !== "string" ||
    typeof frozen.scopeId !== "string" ||
    !Number.isSafeInteger(frozen.iteration) ||
    frozen.iteration < 1 ||
    frozen.iteration > 128
  )
    deny();
  const row = await pgOne<{ plan_json: Row }>(
    client,
    `SELECT p.plan_json FROM execution.execution_plans p
     JOIN execution.execution_plan_shards s ON s.execution_plan_id=p.id
     WHERE s.workflow_task_id=$1 AND p.workflow_step_run_id=$2`,
    [task.id, stepRunId],
  );
  const plan = row?.plan_json;
  const ring = plan?.loop;
  const target = ring?.targets?.[logical.id];
  if (
    plan?.graphVersion !== "workflow-graph/v3" ||
    ring?.scopeId !== frozen.scopeId ||
    ring?.iteration !== frozen.iteration ||
    target?.sourceMemberId !== memberId ||
    target?.targetMemberId !== frozen.targetMemberId ||
    !Array.isArray(plan.selectedMemberIds) ||
    !plan.selectedMemberIds.includes(memberId) ||
    !plan.selectedMemberIds.includes(frozen.targetMemberId) ||
    frozen.targetMemberId === memberId ||
    !Array.isArray(plan.routes) ||
    !plan.routes.some(
      (route: Row) =>
        route.from?.stepId === task.workflow_step_id &&
        route.from?.memberId === memberId &&
        route.to?.memberId === frozen.targetMemberId,
    ) ||
    !Array.isArray(plan.logicalTasks) ||
    !plan.logicalTasks.some(
      (item: Row) =>
        item.logicalId === logical.id && item.index === logical.index,
    )
  )
    deny();
  const overlay = {
    sourceMemberId: memberId,
    targetMemberId: frozen.targetMemberId,
    iteration: frozen.iteration,
  };
  // The ring package's manifest has an exact three-field config schema.
  return step.actionPackage === "@beam/ring-batch-transform"
    ? overlay
    : { ...baseConfig, ...overlay };
}
