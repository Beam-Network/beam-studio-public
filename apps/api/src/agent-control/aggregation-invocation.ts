import { isDeepStrictEqual } from "node:util";
import { pgOne, type PgClient } from "@beam-studio/db";
import { WorkflowAuthorizationError } from "@beam-studio/db";

type Row = Record<string, any>;

/** Derive dynamic action configuration from the admitted, frozen collection. */
export async function frozenAggregationInvocationConfigPg(
  client: PgClient,
  task: Row,
  step: Row,
  stepRunId: string,
  memberId: string,
): Promise<Row> {
  const metadata = task.metadata_json?.aggregation;
  if (!metadata) return step.config ?? {};
  const deny = () => {
    throw new WorkflowAuthorizationError(
      "executor_aggregation_plan_invalid",
      "Aggregation invocation differs from its frozen plan.",
    );
  };
  if (
    typeof metadata.executionPlanId !== "string" ||
    typeof metadata.id !== "string" ||
    typeof metadata.collectionId !== "string" ||
    !Array.isArray(metadata.expectedContributionIds) ||
    typeof metadata.contentChecksum !== "string" ||
    metadata.targetMemberId !== memberId
  ) deny();
  const row = await pgOne<{ plan_json: Row }>(
    client,
    `SELECT plan_json FROM execution.execution_plans
     WHERE id=$1 AND workflow_step_run_id=$2`,
    [metadata.executionPlanId, stepRunId],
  );
  const plan = row?.plan_json;
  const invocation = plan?.invocations?.find(
    (item: Row) => item.taskId === metadata.id,
  );
  const admitted = plan?.admitted?.[metadata.id];
  if (
    plan?.version !== "workflow-aggregation/v1" ||
    plan.placement !== "room-member" ||
    plan.aggregatorMemberId !== memberId ||
    !invocation ||
    invocation.collection?.collectionId !== metadata.collectionId ||
    !isDeepStrictEqual(
      invocation.collection?.expectedContributionIds,
      metadata.expectedContributionIds,
    ) ||
    admitted?.collectionId !== metadata.collectionId ||
    admitted?.contentChecksum !== metadata.contentChecksum ||
    !step.manifestSnapshot?.contracts?.computation?.aggregation
  ) deny();
  if (
    step.manifestSnapshot.contracts.computation.semanticId ===
    "beam.term-count-reduce/v1"
  )
    return {
      ...(step.config ?? {}),
      collectionId: metadata.collectionId,
      expectedDocumentIds: [...metadata.expectedContributionIds],
    };
  return step.config ?? {};
}
