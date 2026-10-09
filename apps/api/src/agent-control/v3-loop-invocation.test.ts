import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { PgClient } from "@beam-studio/db";
import { frozenV3LoopInvocationConfigPg } from "./v3-loop-invocation.js";

const memberId = "member_a";
const targetMemberId = "member_b";
const scopeId = "run:ring:1";
const logicalPartition = {
  version: "logical/v1",
  id: `member:${memberId}`,
  memberId,
  index: 0,
};
const ring = {
  scopeId,
  iteration: 1,
  sourceMemberId: memberId,
  targetMemberId,
};
const plan = {
  graphVersion: "workflow-graph/v3",
  selectedMemberIds: [memberId, targetMemberId, "member_c"],
  logicalTasks: [{ logicalId: logicalPartition.id, index: 0 }],
  routes: [
    {
      from: { stepId: "transform", memberId },
      to: { stepId: "transform", memberId: targetMemberId },
    },
  ],
  loop: {
    scopeId,
    iteration: 1,
    targets: {
      [logicalPartition.id]: {
        sourceMemberId: memberId,
        targetMemberId,
      },
    },
  },
};
const client = (planJson: unknown) =>
  ({
    async query() {
      return { rows: [{ plan_json: planJson }] };
    },
  }) as unknown as PgClient;

test("ring assignment gets exact frozen one-based config and rejects a changed target", async () => {
  const task = {
    id: "task",
    workflow_step_id: "transform",
    metadata_json: {
      logicalPartition,
      v3Loop: ring,
    },
  };
  const step = { actionPackage: "@beam/ring-batch-transform" };
  assert.deepEqual(
    await frozenV3LoopInvocationConfigPg(
      client(plan),
      task,
      step,
      "step-run",
      memberId,
      { stale: true },
    ),
    {
      sourceMemberId: memberId,
      targetMemberId,
      iteration: 1,
    },
  );
  await assert.rejects(
    () =>
      frozenV3LoopInvocationConfigPg(
        client(plan),
        {
          ...task,
          metadata_json: {
            ...task.metadata_json,
            v3Loop: { ...ring, targetMemberId: "member_c" },
          },
        },
        step,
        "step-run",
        memberId,
        {},
      ),
    /frozen iteration plan/,
  );
});

test("seed identity is stable per run/member and checked against its plan", async () => {
  const hex = createHash("sha256").update("run:member_a").digest("hex");
  const seed = {
    scopeId: "run:ring:seed",
    memberId,
    batchId: `batch-${hex}`,
    lotId: `lot-${hex}`,
  };
  const task = {
    id: "seed-task",
    workflow_run_id: "run",
    workflow_step_id: "seed",
    metadata_json: { logicalPartition, v3Seed: seed },
  };
  const seedPlan = {
    graphVersion: "workflow-graph/v3",
    selectedMemberIds: [memberId],
    routes: [
      {
        from: { stepId: "seed", memberId },
        to: { stepId: "transform", memberId },
      },
    ],
    seed: {
      targets: { [logicalPartition.id]: seed },
    },
  };
  assert.deepEqual(
    await frozenV3LoopInvocationConfigPg(
      client(seedPlan),
      task,
      { actionPackage: "@beam/ring-batch-seed" },
      "seed-run",
      memberId,
      {},
    ),
    {
      memberId,
      batchId: seed.batchId,
      lotId: seed.lotId,
    },
  );
  await assert.rejects(
    () =>
      frozenV3LoopInvocationConfigPg(
        client(seedPlan),
        {
          ...task,
          metadata_json: {
            ...task.metadata_json,
            v3Seed: { ...seed, lotId: "lot-tampered" },
          },
        },
        { actionPackage: "@beam/ring-batch-seed" },
        "seed-run",
        memberId,
        {},
      ),
    /frozen iteration plan/,
  );
});
