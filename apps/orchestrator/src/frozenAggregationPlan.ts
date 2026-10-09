import {
  prepareAggregationActionInput,
  planAggregationInvocations,
  validateActionManifestV2,
  type AcceptedAggregationContribution,
  type ActionJson,
  type ActionManifestV2,
  type PlannedAggregationInvocation,
} from "@beam-studio/core";
import {
  ArtifactAcceptanceError,
  freezeWorkflowArtifactInputPg,
  type PgClient,
} from "@beam-studio/db";

export type FrozenLogicalPartitionPlan = {
  mode: string;
  partitionPlanVersion?: string;
  maxParallelism?: number;
  groupSize?: number;
  tasks: {
    kind: string;
    logicalId?: string;
    index?: number;
    count?: number;
    input: Record<string, ActionJson>;
    eligibleMemberIds?: string[];
  }[];
};

export type FrozenAggregationPlan = {
  version: "workflow-aggregation/v1";
  sourcePlanVersion: "logical/v1";
  scopeId: string;
  sourceStepId: string;
  stepId: string;
  placement: "room-member";
  aggregatorMemberId: string;
  invocations: PlannedAggregationInvocation[];
  admitted?: Record<string, { collectionId: string; contentChecksum: string }>;
  blocked?: Record<string, { sourceTaskId: string; reason: string }>;
};

/** The accepted source key is (source step, logical partition ID), never worker ID. */
export function planAggregationForFrozenPartitions(input: {
  scopeId: string;
  sourceStepId: string;
  sourcePort: string;
  stepId: string;
  /** Frozen assignedMemberId from the resolved graph task. */
  aggregatorMemberId: string;
  strategy: "flat" | "hierarchical";
  mapPlan: FrozenLogicalPartitionPlan;
  contributionIdsByLogicalId: Readonly<Record<string, string>>;
  action: ActionManifestV2;
}): FrozenAggregationPlan {
  const { mapPlan, action } = input;
  validateActionManifestV2(action);
  const contract = action.contracts.computation.aggregation;
  if (!contract)
    throw new Error("The locked action has no aggregation contract.");
  if (!action.runtime.placements.includes("room-members"))
    throw new Error("Aggregation action must support room-member placement.");
  if (
    mapPlan.mode !== "partition-map" ||
    mapPlan.partitionPlanVersion !== "logical/v1" ||
    !Number.isSafeInteger(mapPlan.maxParallelism) ||
    (mapPlan.maxParallelism ?? 0) < 1
  )
    throw new Error("Aggregation requires a frozen logical/v1 partition plan.");
  const tasks = [...mapPlan.tasks].sort(
    (a, b) => (a.index ?? -1) - (b.index ?? -1),
  );
  if (
    !tasks.length ||
    tasks.some(
      (task, index) =>
        task.kind !== "step-partition" ||
        task.index !== index ||
        task.count !== tasks.length ||
        !task.logicalId ||
        !task.eligibleMemberIds?.length ||
        new Set(task.eligibleMemberIds).size !== task.eligibleMemberIds.length,
    ) ||
    new Set(tasks.map((task) => task.logicalId)).size !== tasks.length
  )
    throw new Error(
      "Aggregation requires complete unique frozen logical partitions.",
    );
  const aggregatorMemberId = input.aggregatorMemberId;
  if (!aggregatorMemberId.trim() ||
      tasks.some((task) => !task.eligibleMemberIds!.includes(aggregatorMemberId)))
    throw new Error("Graph-assigned aggregator is outside the frozen map cohort.");
  const invocations = planAggregationInvocations({
    scopeId: input.scopeId,
    stepId: input.stepId,
    inputPort: contract.inputPort,
    outputPort: contract.outputPort,
    contributionFormat: contract.contributionFormat,
    maxArtifacts: action.contracts.resources.maxArtifacts,
    strategy: input.strategy,
    associative: contract.associative,
    closedUnderCombination: contract.closedUnderCombination,
    sources: tasks.map((task) => ({
      stepId: input.sourceStepId,
      taskId: task.logicalId!,
      contributionId: input.contributionIdsByLogicalId[task.logicalId!] ?? "",
      port: input.sourcePort,
      index: task.index!,
    })),
  });
  return {
    version: "workflow-aggregation/v1",
    sourcePlanVersion: "logical/v1",
    scopeId: input.scopeId,
    sourceStepId: input.sourceStepId,
    stepId: input.stepId,
    placement: "room-member",
    aggregatorMemberId,
    invocations,
  };
}

type PlanStore = {
  query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: T[] }>;
};

/** Freeze the serializable plan once in the existing PostgreSQL plan_json slot. */
export async function persistFrozenAggregationPlanPg(
  client: PlanStore,
  executionPlanId: string,
  workflowStepRunId: string,
  plan: FrozenAggregationPlan,
) {
  const serialized = JSON.stringify(plan);
  const inserted = await client.query<{ id: string }>(
    `UPDATE execution.execution_plans
     SET plan_json=$3::jsonb, updated_at=now()
     WHERE id=$1 AND workflow_step_run_id=$2 AND plan_json='{}'::jsonb
     RETURNING id`,
    [executionPlanId, workflowStepRunId, serialized],
  );
  if (inserted.rows.length) return;
  const existing = await client.query<{ same: boolean }>(
    `SELECT plan_json - 'admitted' - 'blocked' = $3::jsonb - 'admitted' - 'blocked' AS same
     FROM execution.execution_plans
     WHERE id=$1 AND workflow_step_run_id=$2`,
    [executionPlanId, workflowStepRunId, serialized],
  );
  if (existing.rows[0]?.same) return;
  throw new Error(
    "Frozen aggregation plan is missing or conflicts with the persisted plan.",
  );
}

type AcceptedTaskRow = {
  id: string;
  status: string;
  manifest_id: string | null;
  manifest_status: string | null;
  accepted_count: string;
  artifacts_json: unknown;
  result_json: unknown;
};

export type FrozenAggregationArtifactInput = {
  manifestId: string;
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  location: {
    kind: "member" | "storage";
    roomId: string;
    channelId: string;
    sourceMemberId: string;
    memberId: string;
    transferId: string;
  };
};

/**
 * Called inside the orchestration transaction. The callback must persist the
 * ready action task in that same transaction; no broker publish happens here.
 */
export async function admitFrozenAggregationInvocationPg(
  client: PgClient,
  input: {
    executionPlanId: string;
    workflowRunId: string;
    workflowStepRunId: string;
    sourceStepRunId: string;
    taskId: string;
    consumerMemberId: string;
    /** Recheck the live room authority for this frozen reader and source. */
    authorizeRead: (artifact: FrozenAggregationArtifactInput) => Promise<void>;
    /** Persist the step's blocked/not_reached state in this same transaction. */
    block: (failure: {
      taskId: string;
      sourceTaskId: string;
      reason: string;
    }) => Promise<void>;
    enqueue: (ready: {
      input: Record<string, ActionJson>;
      collectionId: string;
      contentChecksum: string;
      expectedContributionIds: string[];
      taskId: string;
      targetMemberId: string;
      placement: "room-member";
      metadata: {
        aggregation: {
          id: string;
          executionPlanId: string;
          collectionId: string;
          expectedContributionIds: string[];
          contentChecksum: string;
          targetMemberId: string;
        };
        artifactInputs: Record<string, FrozenAggregationArtifactInput[]>;
      };
    }) => Promise<void>;
  },
): Promise<"waiting" | "admitted" | "already-admitted" | "blocked"> {
  const selected = await client.query<{ plan_json: unknown }>(
    `SELECT plan_json FROM execution.execution_plans
     WHERE id=$1 AND workflow_step_run_id=$2 FOR UPDATE`,
    [input.executionPlanId, input.workflowStepRunId],
  );
  const plan = selected.rows[0]?.plan_json as FrozenAggregationPlan | undefined;
  if (plan?.version !== "workflow-aggregation/v1")
    throw new Error("No frozen aggregation plan exists for this step run.");
  if (plan.placement !== "room-member" ||
      plan.aggregatorMemberId !== input.consumerMemberId)
    throw new Error("Aggregation reader differs from the frozen room member.");
  const invocation = plan.invocations.find(
    (item) => item.taskId === input.taskId,
  );
  if (!invocation)
    throw new Error("Aggregation invocation is absent from the frozen plan.");
  if (plan.admitted?.[input.taskId]) return "already-admitted";
  if (plan.blocked?.[input.taskId]) return "blocked";
  const block = async (sourceTaskId: string, reason: string) => {
    await input.block({ taskId: input.taskId, sourceTaskId, reason });
    plan.blocked = {
      ...plan.blocked,
      [input.taskId]: { sourceTaskId, reason },
    };
    await client.query<Record<string, unknown>>(
      `UPDATE execution.execution_plans
       SET plan_json=$3::jsonb,updated_at=now()
       WHERE id=$1 AND workflow_step_run_id=$2`,
      [input.executionPlanId, input.workflowStepRunId, JSON.stringify(plan)],
    );
    return "blocked" as const;
  };
  const notifications: AcceptedAggregationContribution[] = [];
  const artifactInputs: FrozenAggregationArtifactInput[] = [];
  for (const source of invocation.collection.sources) {
    const sourceStepRunId =
      source.stepId === plan.sourceStepId
        ? input.sourceStepRunId
        : source.stepId === plan.stepId
          ? input.workflowStepRunId
          : null;
    if (!sourceStepRunId)
      throw new Error(
        "Aggregation source is outside the frozen map/reduce steps.",
      );
    const logicalPath =
      source.stepId === plan.sourceStepId ? "logicalPartition" : "aggregation";
    const rows = await client.query<AcceptedTaskRow>(
      `SELECT t.id,t.status,m.id AS manifest_id,m.status AS manifest_status,
         m.artifacts_json,m.result_json,
         (SELECT count(*)::text FROM execution.workflow_artifact_manifests accepted
          WHERE accepted.task_id=t.id AND accepted.status='accepted') AS accepted_count
       FROM execution.workflow_tasks t
       LEFT JOIN LATERAL (
         SELECT id,status,artifacts_json,result_json
         FROM execution.workflow_artifact_manifests
         WHERE task_id=t.id
         ORDER BY (status='accepted') DESC,attempt DESC
         LIMIT 1
       ) m ON true
       WHERE t.workflow_step_run_id=$1 AND t.workflow_run_id=$2
         AND t.metadata_json->$3->>'id'=$4
       FOR UPDATE OF t`,
      [sourceStepRunId, input.workflowRunId, logicalPath, source.taskId],
    );
    if (!rows.rows.length) return "waiting";
    if (rows.rows.length !== 1)
      throw new Error(
        "Aggregation source has duplicate accepted task identities.",
      );
    const row = rows.rows[0]!;
    if (Number(row.accepted_count) > 1)
      throw new Error(
        "Aggregation source has multiple accepted artifact manifests.",
      );
    if (["failed", "dead_letter", "cancelled"].includes(row.status))
      return block(source.taskId, `Required source ended with ${row.status}.`);
    if (row.status !== "completed") return "waiting";
    if (!row.manifest_id || row.manifest_status !== "accepted")
      return block(source.taskId, "Required source completed without an accepted artifact manifest.");
    const manifestArtifacts = Array.isArray(row.artifacts_json)
      ? row.artifacts_json
      : [];
    const result = row.result_json as { artifacts?: unknown[] } | null;
    const resultArtifacts = Array.isArray(result?.artifacts)
      ? result.artifacts
      : [];
    const matching = manifestArtifacts.filter(
      (
        artifact,
      ): artifact is {
        artifactId: string;
        port: string;
        mediaType: string;
        sha256: string;
        sizeBytes: number;
      } =>
        !!artifact &&
        typeof artifact === "object" &&
        (artifact as { port?: unknown }).port === source.port,
    );
    if (matching.length !== 1)
      throw new Error(
        "Accepted aggregation source lacks exactly one output artifact.",
      );
    const artifact = matching[0]!;
    if (artifact.mediaType !== invocation.collection.contributionFormat)
      throw new Error(
        "Accepted aggregation source has an incompatible format.",
      );
    const value = resultArtifacts.find(
      (item) =>
        !!item &&
        typeof item === "object" &&
        ((item as { id?: unknown }).id === artifact.artifactId ||
          ((item as { id?: unknown }).id === undefined &&
            (item as { metadata?: { port?: unknown } }).metadata?.port ===
              source.port)),
    );
    if (!value || typeof value !== "object")
      throw new Error(
        "Accepted aggregation source has no retained artifact value.",
      );
    const available = await client.query<{ available: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM execution.workflow_artifact_locations
         WHERE manifest_id=$1 AND artifact_id=$2 AND state='available'
           AND (durable_until IS NULL OR durable_until>now())
       ) AS available`,
      [row.manifest_id, artifact.artifactId],
    );
    if (!available.rows[0]?.available)
      throw new Error("Accepted aggregation artifact is unavailable.");
    let frozen: FrozenAggregationArtifactInput;
    try {
      frozen = await freezeWorkflowArtifactInputPg(client, {
        manifestId: row.manifest_id,
        artifactId: artifact.artifactId,
        destinationMemberId: input.consumerMemberId,
      });
    } catch (error) {
      if (error instanceof ArtifactAcceptanceError &&
          error.message === "Routed artifact lacks verified recipient availability.")
        return "waiting";
      throw error;
    }
    if (
      frozen.manifestId !== row.manifest_id ||
      frozen.artifactId !== artifact.artifactId ||
      frozen.sha256 !== artifact.sha256 ||
      frozen.sizeBytes !== artifact.sizeBytes ||
      frozen.mediaType !== artifact.mediaType ||
      frozen.location.memberId !== input.consumerMemberId
    )
      throw new Error(
        "Frozen aggregation input differs from the accepted artifact or reader.",
      );
    await input.authorizeRead(frozen);
    artifactInputs.push(frozen);
    notifications.push({
      stepId: source.stepId,
      taskId: source.taskId,
      port: source.port,
      accepted: true,
      format: artifact.mediaType,
      value: value as ActionJson,
    });
  }
  const ready = prepareAggregationActionInput(
    invocation.collection,
    notifications,
  );
  if (!ready) return "waiting";
  await input.enqueue({
    ...ready,
    taskId: input.taskId,
    targetMemberId: plan.aggregatorMemberId,
    placement: plan.placement,
    metadata: {
      aggregation: {
        id: input.taskId,
        executionPlanId: input.executionPlanId,
        collectionId: ready.collectionId,
        expectedContributionIds: ready.expectedContributionIds,
        contentChecksum: ready.contentChecksum,
        targetMemberId: plan.aggregatorMemberId,
      },
      artifactInputs: { [invocation.collection.inputPort]: artifactInputs },
    },
  });
  plan.admitted = {
    ...plan.admitted,
    [input.taskId]: {
      collectionId: ready.collectionId,
      contentChecksum: ready.contentChecksum,
    },
  };
  await client.query<Record<string, unknown>>(
    `UPDATE execution.execution_plans
     SET plan_json=$3::jsonb,updated_at=now()
     WHERE id=$1 AND workflow_step_run_id=$2`,
    [input.executionPlanId, input.workflowStepRunId, JSON.stringify(plan)],
  );
  return "admitted";
}
