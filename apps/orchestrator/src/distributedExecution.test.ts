import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionManifest } from "@beam-studio/core";
import { nextReduceTasks, planActionTasks } from "./distributedExecution.js";

const legacy: ActionManifest = {
  name: "@test/sum",
  version: "1.0.0",
  apiVersion: "workflow-actions/v1",
  runtime: { placements: ["local-workers"] },
  inputs: {},
  outputs: {},
  execution: {
    taskMode: "distributed-workers",
    distribution: {
      mode: "partitioned-reduce",
      inputKey: "values",
      outputKey: "sum",
      preferredItemsPerTask: 1,
      maxParallelism: 16,
    },
  },
};

test("new actions keep flat reduction beyond eight partitions unless explicitly compatible", () => {
  const input = { values: Array.from({ length: 16 }, (_, index) => index) };
  assert.equal(planActionTasks(legacy, input).mode, "hierarchical-reduce");
  const next = structuredClone(legacy);
  next.apiVersion = "workflow-actions/v2";
  next.contracts = {
    resources: {
      cpuMillis: 1000,
      memoryMiB: 256,
      timeoutSeconds: 60,
      maxArtifactBytes: 32768,
      maxArtifacts: 16,
      maxInputBytes: 32768,
      maxOutputBytes: 32768,
    },
    recovery: { retry: "idempotent", externalEffects: "none" },
    computation: {
      semanticId: "test.sum/v1",
      partitioning: {
        inputPort: "values",
        outputPort: "sum",
        aggregation: "ordered-concatenate",
        equivalentToSingleTask: true,
      },
    },
  };
  assert.equal(planActionTasks(next, input).mode, "map-reduce");
  next.execution!.distribution!.reductionStrategy = "hierarchical";
  assert.throws(() => planActionTasks(next, input), /associative-commutative/);
  next.contracts.computation.partitioning!.aggregation =
    "associative-commutative";
  assert.equal(planActionTasks(next, input).mode, "hierarchical-reduce");
});

test("new reduction waits for a complete accepted index set and preserves empty outputs", () => {
  const manifest = structuredClone(legacy);
  manifest.apiVersion = "workflow-actions/v2";
  const input = { values: [1, 2, 3] };
  const task = (index: number, value: number[] | null) => ({
    task_kind: "step-shard",
    shard_index: index,
    shard_count: 3,
    status: "completed",
    output_json: { sum: value },
  });
  const source = [task(2, null), task(0, []), task(1, [5])];
  assert.deepEqual(
    nextReduceTasks(manifest, input, "map-reduce", 2, source.slice(0, 2), 3),
    [],
  );
  const reduce = nextReduceTasks(
    manifest,
    input,
    "map-reduce",
    2,
    [...source, source[0]!],
    3,
  );
  assert.deepEqual(reduce[0]?.input.values, [[], [5], null]);
  assert.throws(
    () =>
      nextReduceTasks(
        manifest,
        input,
        "map-reduce",
        2,
        [...source, task(1, [6])],
        3,
      ),
    /conflicting/,
  );
});

test("hierarchical groups use the frozen count after duplicate shard and group notifications", () => {
  const manifest = structuredClone(legacy);
  manifest.apiVersion = "workflow-actions/v2";
  const input = { values: [0, 1, 2, 3] };
  const shards = Array.from({ length: 4 }, (_, index) => ({
    task_kind: "step-shard",
    shard_index: index,
    shard_count: 4,
    status: "completed",
    output_json: { sum: index },
  }));
  const first = nextReduceTasks(
    manifest,
    input,
    "hierarchical-reduce",
    2,
    [...shards].reverse().concat(shards[1]!),
    4,
  );
  assert.deepEqual(
    first.map((task) => task.input.values),
    [
      [0, 1],
      [2, 3],
    ],
  );
  const groups = first.map((task, index) => ({
    task_kind: "step-intermediate-reduce",
    shard_index: index,
    shard_count: 2,
    status: "completed",
    output_json: { sum: task.input.values! },
  }));
  const final = nextReduceTasks(
    manifest,
    input,
    "hierarchical-reduce",
    2,
    [...shards, shards[1]!, ...groups, groups[0]!],
    4,
  );
  assert.deepEqual(final[0]?.input.values, [
    [0, 1],
    [2, 3],
  ]);
});
