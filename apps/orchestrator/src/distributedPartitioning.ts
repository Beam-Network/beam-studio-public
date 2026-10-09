import type { ActionJson } from "@beam-studio/core";

export type PartitionPlan = {
  mode: "map-reduce" | "hierarchical-reduce";
  shards: ActionJson[][];
  intermediateGroupSize: number;
};

export function createPartitionPlan(
  values: ActionJson[],
  options: {
    preferredItemsPerTask: number;
    maxParallelism: number;
    activeWorkers: number;
    estimatedInputWeight: number;
    averageLoadScore: number;
    partitionPlanVersion?: "logical/v1";
    reductionStrategy?: "flat" | "hierarchical";
  },
): PartitionPlan {
  if (!values.length)
    return { mode: "map-reduce", shards: [], intermediateGroupSize: 2 };
  const preferredItems = adaptivePreferredItems(options);
  const inputShardCount = Math.ceil(values.length / preferredItems);
  const weightShardCount = Math.ceil(options.estimatedInputWeight / 1_000_000);
  const workerShardCount = Math.max(2, options.activeWorkers * 2 || 2);
  // Historical manifests used maxParallelism as a shard-count ceiling. New
  // plans keep every logical partition and apply this limit at admission.
  const shardCount =
    options.partitionPlanVersion === "logical/v1"
      ? Math.min(values.length, Math.max(1, inputShardCount, weightShardCount))
      : clamp(
          Math.max(2, inputShardCount, weightShardCount, workerShardCount),
          1,
          Math.max(1, options.maxParallelism),
        );
  const shards =
    options.partitionPlanVersion === "logical/v1"
      ? splitEvenly(values, shardCount)
      : splitHistorically(values, shardCount);
  return {
    mode:
      options.reductionStrategy === "flat"
        ? "map-reduce"
        : options.reductionStrategy === "hierarchical"
          ? "hierarchical-reduce"
          : options.partitionPlanVersion !== "logical/v1" && shards.length > 8
            ? "hierarchical-reduce"
            : "map-reduce",
    shards,
    intermediateGroupSize: Math.max(2, Math.ceil(Math.sqrt(shards.length))),
  };
}

function splitEvenly(values: ActionJson[], count: number) {
  const baseSize = Math.floor(values.length / count);
  const remainder = values.length % count;
  return Array.from({ length: count }, (_, index) => {
    const start = index * baseSize + Math.min(index, remainder);
    return values.slice(start, start + baseSize + (index < remainder ? 1 : 0));
  });
}

function splitHistorically(values: ActionJson[], count: number) {
  const chunkSize = Math.ceil(values.length / count);
  return Array.from({ length: count }, (_, index) =>
    values.slice(index * chunkSize, (index + 1) * chunkSize),
  ).filter((shard) => shard.length > 0);
}

export function groupIndexes(total: number, groupSize: number) {
  const groups: number[][] = [];
  for (let index = 0; index < total; index += groupSize) {
    groups.push(
      Array.from(
        { length: Math.min(groupSize, total - index) },
        (_, offset) => index + offset,
      ),
    );
  }
  return groups;
}

function adaptivePreferredItems(options: {
  preferredItemsPerTask: number;
  averageLoadScore: number;
}) {
  const base = Math.max(1, options.preferredItemsPerTask);
  if (options.averageLoadScore > 1.5) {
    return base * 2;
  }
  if (options.averageLoadScore < 0.5) {
    return Math.max(1, Math.floor(base / 2));
  }
  return base;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
