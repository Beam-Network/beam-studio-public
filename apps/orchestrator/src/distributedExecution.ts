import {
  closeAggregationCollection,
  type ActionJson,
  type ActionManifest,
  type DistributedTask as GraphV3DistributedTask,
} from "@beam-studio/core";
import { createHash } from "node:crypto";
import {
  createPartitionPlan,
  groupIndexes,
} from "./distributedPartitioning.js";

type Input = Record<string, ActionJson>;

export function frozenV3RetentionObligationId(
  scopeId: string,
  stepId: string,
  logicalId: string,
  port: string,
) {
  return `v3-${createHash("sha256")
    .update(JSON.stringify([scopeId, stepId, logicalId, port]))
    .digest("hex")}`;
}

/** One publication obligation belongs to one logical output task, even when
 * 100 input partitions share the same frozen graph member template. */
export function partitionedRoomTaskMetadata(
  template: Record<string, unknown> | undefined,
  scopeId: string,
  stepId: string,
  logicalId: string,
): Record<string, unknown> {
  const source = template?.v3OutputRoutes;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return {
    v3OutputRoutes: Object.fromEntries(
      Object.entries(source).map(([port, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Frozen V3 output publication intent is invalid.");
        return [
          port,
          {
            ...value,
            retentionObligationId: frozenV3RetentionObligationId(
              scopeId,
              stepId,
              logicalId,
              port,
            ),
          },
        ];
      }),
    ),
  };
}

/** Aggregation invocations bypass the ordinary V3 room task planner. Every
 * partial and final reduction therefore needs its own retained output plan. */
export function v3AggregationTaskMetadata(input: {
  scopeId: string;
  stepId: string;
  taskId: string;
  roomId: string;
  channelId: string;
  outputPorts: readonly string[];
}) {
  return {
    v3OutputRoutes: Object.fromEntries(input.outputPorts.map((port) => [
      port,
      {
        roomId: input.roomId,
        channelId: input.channelId,
        targetMemberIds: [],
        retentionObligationId: frozenV3RetentionObligationId(
          input.scopeId, input.stepId, input.taskId, port,
        ),
        requiredUntil: new Date(Date.now() + 86_400_000).toISOString(),
        availability: "temporary",
      },
    ])),
  };
}
export type DistributedTask = {
  kind: string;
  input: Input;
  index?: number;
  count?: number;
  memberId?: string;
  eligibleMemberIds?: string[];
  logicalId?: string;
};
export type DistributedActionPlan = {
  mode:
    | "single"
    | "map-reduce"
    | "hierarchical-reduce"
    | "per-member"
    | "partition-map";
  groupSize: number;
  tasks: DistributedTask[];
  partitionPlanVersion?: "logical/v1";
  maxParallelism?: number;
};

export type FrozenRoomStepPlanning = {
  resolvedTasks: readonly GraphV3DistributedTask[];
  stepId: string;
  input: Input;
  maxParallelism: number;
  distribution:
    | { kind: "input-partitions"; inputKey: string }
    | { kind: "per-member" };
};

/** Adapts the graph V3 resolver's frozen cohort to the task plan persisted by
 * createStepRunAndTaskPg. The caller supplies routing inputs and keeps the V3
 * launch gate until those inputs and aggregation are available. */
export function planFrozenRoomStepTasks(
  request: FrozenRoomStepPlanning,
): DistributedActionPlan {
  const memberPlan = planFrozenMemberTasks(
    request.resolvedTasks,
    request.stepId,
    request.input,
    request.maxParallelism,
  );
  if (request.distribution.kind === "per-member") return memberPlan;
  const values = request.input[request.distribution.inputKey];
  if (!Array.isArray(values))
    throw new Error("Frozen input partitions require a collection input.");
  return planFrozenInputPartitions(
    values,
    request.distribution.inputKey,
    request.input,
    memberPlan.tasks.map((task) => task.memberId!),
    request.maxParallelism,
  );
}

/** A V3 map step consumes identified input partitions. Each task receives a
 * one-item collection because the locked distributed manifest declares its
 * partition input as a required many-cardinality artifact port. Task count
 * comes from the closed input collection, while placement is limited to the
 * frozen eligible member cohort. */
export function planFrozenInputPartitions(
  values: readonly ActionJson[],
  inputKey: string,
  baseInput: Input,
  eligibleMemberIds: readonly string[],
  maxParallelism: number,
): DistributedActionPlan {
  if (
    !inputKey ||
    !eligibleMemberIds.length ||
    eligibleMemberIds.some((memberId) => !memberId) ||
    new Set(eligibleMemberIds).size !== eligibleMemberIds.length ||
    !Number.isSafeInteger(maxParallelism) ||
    maxParallelism < 1
  )
    throw new Error("Frozen input partition plan is invalid.");
  const cohort = [...eligibleMemberIds];
  return {
    mode: "partition-map",
    groupSize: 1,
    partitionPlanVersion: "logical/v1",
    maxParallelism,
    tasks: values.map((value, index) => ({
      kind: "step-partition",
      input: { ...baseInput, [inputKey]: [value] },
      index,
      count: values.length,
      logicalId: `partition:${index}`,
      eligibleMemberIds: [...cohort],
    })),
  };
}

/** Bridges a resolved V3 member cohort to persistent task identities. The V3
 * launch gate remains in place until routing and aggregation are integrated. */
export function planFrozenMemberTasks(
  resolved: readonly {
    stepId: string;
    memberId: string;
    index: number;
    placement: "studio" | "room-member";
  }[],
  stepId: string,
  input: Input,
  maxParallelism: number,
): DistributedActionPlan {
  const cohort = resolved
    .filter((task) => task.stepId === stepId)
    .sort((left, right) => left.index - right.index);
  if (
    !cohort.length ||
    !Number.isSafeInteger(maxParallelism) ||
    maxParallelism < 1 ||
    new Set(cohort.map((task) => task.memberId)).size !== cohort.length ||
    cohort.some(
      (task, index) =>
        !task.memberId ||
        task.index !== index ||
        !["studio", "room-member"].includes(task.placement),
    )
  )
    throw new Error("Frozen per-member task cohort is invalid.");
  return {
    mode: "per-member",
    groupSize: 1,
    partitionPlanVersion: "logical/v1",
    maxParallelism,
    tasks: cohort.map((task) => ({
      kind: "step-member",
      input: { ...input },
      index: task.index,
      count: cohort.length,
      memberId: task.memberId,
      logicalId: `member:${task.memberId}`,
    })),
  };
}

/** Planning reads the frozen manifest, never the current registry. */
export function planActionTasks(
  manifest: ActionManifest | undefined,
  input: Input,
): DistributedActionPlan {
  const distribution = manifest?.execution?.distribution;
  const values = distribution ? input[distribution.inputKey] : undefined;
  if (
    manifest?.execution?.taskMode !== "distributed-workers" ||
    distribution?.mode !== "partitioned-reduce" ||
    !Array.isArray(values) ||
    values.length <= Math.max(1, distribution.preferredItemsPerTask ?? 8)
  ) {
    return {
      mode: "single",
      groupSize: 1,
      tasks: [{ kind: "step", input }] as DistributedTask[],
    };
  }
  const reductionStrategy =
    manifest.apiVersion === "workflow-actions/v2"
      ? (distribution.reductionStrategy ?? "flat")
      : undefined;
  if (
    reductionStrategy === "hierarchical" &&
    manifest.contracts?.computation.partitioning?.aggregation !==
      "associative-commutative"
  )
    throw new Error(
      "Hierarchical reduction requires an associative-commutative V2 action contract.",
    );
  const plan = createPartitionPlan(values, {
    preferredItemsPerTask: distribution.preferredItemsPerTask ?? 8,
    maxParallelism: distribution.maxParallelism ?? 8,
    activeWorkers: 0,
    estimatedInputWeight: Buffer.byteLength(JSON.stringify(input)),
    averageLoadScore: 1,
    partitionPlanVersion: distribution.partitionPlanVersion,
    reductionStrategy,
  });
  return {
    mode: plan.mode,
    groupSize: plan.intermediateGroupSize,
    ...(distribution.partitionPlanVersion
      ? {
          partitionPlanVersion: distribution.partitionPlanVersion,
          maxParallelism: distribution.maxParallelism ?? 8,
        }
      : {}),
    tasks: plan.shards.map(
      (values, index): DistributedTask => ({
        kind: "step-shard",
        input: { ...input, [distribution.inputKey]: values },
        index,
        count: plan.shards.length,
        ...(distribution.partitionPlanVersion
          ? { logicalId: `shard:${index}` }
          : {}),
      }),
    ),
  };
}

export function nextReduceTasks(
  manifest: ActionManifest,
  input: Input,
  mode: string,
  groupSize: number,
  tasks: {
    task_kind: string;
    status: string;
    shard_index: number | null;
    shard_count?: number | null;
    output_json: Input;
  }[],
  expectedShardCount?: number,
): DistributedTask[] {
  const distribution = manifest.execution?.distribution;
  if (
    !distribution ||
    distribution.mode !== "partitioned-reduce" ||
    tasks.some((task) => task.task_kind === "step-reduce")
  )
    return [];
  const shards = tasks
    .filter((task) => task.task_kind === "step-shard")
    .sort((a, b) => (a.shard_index ?? 0) - (b.shard_index ?? 0));
  if (
    !shards.length ||
    (manifest.apiVersion === "workflow-actions/v1" &&
      shards.some((task) => task.status !== "completed"))
  )
    return [];
  const value = (task: (typeof shards)[number]) => {
    if (manifest.apiVersion === "workflow-actions/v2") {
      if (!Object.hasOwn(task.output_json, distribution.outputKey))
        throw new Error(
          `Accepted contribution is missing output "${distribution.outputKey}".`,
        );
      return task.output_json[distribution.outputKey]!;
    }
    return (
      task.output_json[distribution.outputKey] ??
      task.output_json.value ??
      task.output_json
    );
  };
  const closedValues = (
    sources: typeof shards,
    count: number,
    kind: string,
  ) => {
    if (!Number.isInteger(count) || count < 1)
      throw new Error(
        "Distributed collection requires a frozen positive source count.",
      );
    return closeAggregationCollection(
      Array.from({ length: count }, (_, index) => ({
        stepId: kind,
        taskId: String(index),
        port: distribution.outputKey,
        index,
      })),
      sources
        .filter((task) => task.status === "completed")
        .map((task) => ({
          stepId: kind,
          taskId: String(task.shard_index),
          port: distribution.outputKey,
          accepted: true as const,
          value: value(task),
        })),
    )?.values;
  };
  const shardValues =
    manifest.apiVersion === "workflow-actions/v2"
      ? closedValues(
          shards,
          expectedShardCount ?? shards[0]?.shard_count ?? -1,
          "step-shard",
        )
      : shards.map(value);
  if (!shardValues) return [];
  const intermediate = tasks
    .filter((task) => task.task_kind === "step-intermediate-reduce")
    .sort((a, b) => (a.shard_index ?? 0) - (b.shard_index ?? 0));
  if (mode === "hierarchical-reduce" && !intermediate.length) {
    const groups = groupIndexes(shardValues.length, groupSize);
    return groups.map((indexes, index) => ({
      kind: "step-intermediate-reduce",
      index,
      count: groups.length,
      input: {
        ...input,
        [distribution.inputKey]: indexes.map((i) => shardValues[i]!),
      },
    }));
  }
  const sources = mode === "hierarchical-reduce" ? intermediate : shards;
  if (
    !sources.length ||
    (manifest.apiVersion === "workflow-actions/v1" &&
      sources.some((task) => task.status !== "completed"))
  )
    return [];
  const sourceValues =
    manifest.apiVersion === "workflow-actions/v2" &&
    mode === "hierarchical-reduce"
      ? closedValues(
          sources,
          groupIndexes(shardValues.length, groupSize).length,
          "step-intermediate-reduce",
        )
      : mode === "hierarchical-reduce"
        ? sources.map(value)
        : shardValues;
  if (!sourceValues) return [];
  return [
    {
      kind: "step-reduce",
      input: { ...input, [distribution.inputKey]: sourceValues },
    },
  ];
}
