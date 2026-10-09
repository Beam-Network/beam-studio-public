import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionManifest } from "@beam-studio/core";
import {
  planActionTasks,
  planFrozenInputPartitions,
  planFrozenMemberTasks,
  planFrozenRoomStepTasks,
  partitionedRoomTaskMetadata,
} from "./distributedExecution.js";
import { createPartitionPlan } from "./distributedPartitioning.js";

const values = Array.from({ length: 100 }, (_, index) => index);
const options = {
  preferredItemsPerTask: 1,
  maxParallelism: 3,
  activeWorkers: 3,
  estimatedInputWeight: 100,
  averageLoadScore: 1,
};

test("100 logical map outputs keep distinct retention obligations without a stale member identity", () => {
  const template = {
    v3Route: { memberId: "member-a", assignedMemberId: "member-a" },
    v3OutputRoutes: {
      counts: {
        roomId: "room-a",
        channelId: "objects-a",
        targetMemberIds: ["member-c"],
        retentionObligationId: "member-template",
      },
    },
  };
  const rows = Array.from({ length: 100 }, (_, index) =>
    partitionedRoomTaskMetadata(template, "run-a", "map", `partition:${index}`),
  );
  const intents = rows.map(
    (row) =>
      (row.v3OutputRoutes as Record<string, Record<string, unknown>>).counts!,
  );
  assert.equal(
    new Set(intents.map((intent) => intent.retentionObligationId)).size,
    100,
  );
  assert.ok(intents.every((intent) => intent.channelId === "objects-a"));
  assert.ok(rows.every((row) => !Object.hasOwn(row, "v3Route")));
  assert.deepEqual(
    partitionedRoomTaskMetadata(template, "run-a", "map", "partition:0"),
    rows[0],
  );
  assert.equal(
    template.v3OutputRoutes.counts.retentionObligationId,
    "member-template",
  );
});

test("logical partitions remain stable when execution concurrency is three", () => {
  const plan = createPartitionPlan(values, {
    ...options,
    partitionPlanVersion: "logical/v1",
  });
  assert.equal(plan.shards.length, 100);
  assert.deepEqual(plan.shards.flat(), values);
  assert.ok(plan.shards.every((shard) => shard.length === 1));
  assert.equal(plan.mode, "map-reduce");
  const weighted = createPartitionPlan(values, {
    ...options,
    preferredItemsPerTask: 100,
    estimatedInputWeight: 99_000_000,
    partitionPlanVersion: "logical/v1",
  });
  assert.equal(weighted.shards.length, 99);
  assert.deepEqual(weighted.shards.flat(), values);
  assert.ok(weighted.shards.every((shard) => shard.length > 0));
});

test("historical plans retain maxParallelism shard cap and >8 hierarchy", () => {
  assert.equal(createPartitionPlan(values, options).shards.length, 3);
  assert.equal(
    createPartitionPlan(values, { ...options, maxParallelism: 9 }).mode,
    "hierarchical-reduce",
  );
});

test("empty collection produces no phantom logical shard", () => {
  assert.deepEqual(
    createPartitionPlan([], { ...options, partitionPlanVersion: "logical/v1" })
      .shards,
    [],
  );
});

test("frozen manifest opts in and preserves every shard index", () => {
  const manifest = {
    execution: {
      taskMode: "distributed-workers",
      distribution: {
        mode: "partitioned-reduce",
        inputKey: "items",
        outputKey: "items",
        preferredItemsPerTask: 1,
        maxParallelism: 3,
        partitionPlanVersion: "logical/v1",
      },
    },
  } as ActionManifest;
  const plan = planActionTasks(manifest, { items: values });
  assert.equal(plan.tasks.length, 100);
  assert.equal(plan.maxParallelism, 3);
  assert.equal(plan.partitionPlanVersion, "logical/v1");
  assert.deepEqual(
    plan.tasks.map((task) => task.index),
    values,
  );
  assert.ok(plan.tasks.every((task) => task.count === 100));
  assert.equal(plan.tasks[0]?.logicalId, "shard:0");
});

test("100 frozen input partitions share three eligible members without shrinking task count", () => {
  const selectedMembers = ["member_a", "member_b", "member_c"];
  const plan = planFrozenInputPartitions(
    values,
    "document",
    { other: true },
    selectedMembers,
    3,
  );
  selectedMembers.push("late_member");
  assert.equal(plan.mode, "partition-map");
  assert.equal(plan.tasks.length, 100);
  assert.deepEqual(
    plan.tasks.map((task) => task.logicalId),
    values.map((index) => `partition:${index}`),
  );
  assert.deepEqual(plan.tasks[99]?.input, { other: true, document: [99] });
  assert.ok(
    plan.tasks.every(
      (task) =>
        task.count === 100 &&
        task.eligibleMemberIds?.join(",") === "member_a,member_b,member_c",
    ),
  );
  assert.deepEqual(
    planFrozenInputPartitions([], "document", {}, ["member_a"], 3).tasks,
    [],
  );
});

test("the V3 adapter turns one resolved cohort into either 100 map tasks or three member tasks", () => {
  const resolvedTasks = ["member_a", "member_b", "member_c"].map(
    (memberId, index) => ({
      stepId: "map",
      memberId,
      index,
      placement: "room-member" as const,
    }),
  );
  const map = planFrozenRoomStepTasks({
    resolvedTasks,
    stepId: "map",
    input: { documents: values },
    maxParallelism: 3,
    distribution: { kind: "input-partitions", inputKey: "documents" },
  });
  const perMember = planFrozenRoomStepTasks({
    resolvedTasks,
    stepId: "map",
    input: {},
    maxParallelism: 3,
    distribution: { kind: "per-member" },
  });
  assert.equal(map.tasks.length, 100);
  assert.equal(perMember.tasks.length, 3);
  assert.deepEqual(
    perMember.tasks.map((task) => task.memberId),
    ["member_a", "member_b", "member_c"],
  );
  assert.throws(
    () =>
      planFrozenRoomStepTasks({
        resolvedTasks,
        stepId: "map",
        input: {},
        maxParallelism: 3,
        distribution: { kind: "input-partitions", inputKey: "documents" },
      }),
    /collection input/,
  );
});

test("a frozen V3 cohort yields one member-bound logical task per participant", () => {
  const resolved = Array.from({ length: 100 }, (_, index) => ({
    stepId: "compute",
    memberId: `member_${String(index).padStart(3, "0")}`,
    index,
    placement: "room-member" as const,
  }));
  const plan = planFrozenMemberTasks(resolved, "compute", { value: 1 }, 3);
  resolved.push({
    stepId: "compute",
    memberId: "late_member",
    index: 100,
    placement: "room-member",
  });
  assert.equal(plan.mode, "per-member");
  assert.equal(plan.tasks.length, 100);
  assert.equal(plan.maxParallelism, 3);
  assert.deepEqual(
    plan.tasks.map((task) => task.memberId),
    resolved.slice(0, 100).map((task) => task.memberId),
  );
  assert.ok(plan.tasks.every((task) => task.count === 100));
  assert.equal(plan.tasks[0]?.logicalId, "member:member_000");
  assert.throws(
    () =>
      planFrozenMemberTasks(
        resolved.slice(0, 2).concat(resolved[0]!),
        "compute",
        {},
        3,
      ),
    /cohort is invalid/,
  );
});
