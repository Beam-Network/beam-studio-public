import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ActionManifestV2 } from "@beam-studio/core";
import type { PgClient } from "@beam-studio/db";
import {
  planFrozenInputPartitions,
  v3AggregationTaskMetadata,
} from "./distributedExecution.js";
import {
  admitFrozenAggregationInvocationPg,
  planAggregationForFrozenPartitions,
  persistFrozenAggregationPlanPg,
  type FrozenLogicalPartitionPlan,
} from "./frozenAggregationPlan.js";

const action = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/core/src/workflows/fixtures/term-count-reduce-v2.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ActionManifestV2;

test("logical/v1 map tasks feed 100 document contributions across three eligible members", () => {
  const members = ["member_a", "member_b", "member_c"];
  const mapPlan = planFrozenInputPartitions(
    Array.from({ length: 100 }, (_, index) => `Document ${index}`),
    "document",
    {},
    members,
    3,
  );
  const contributionIdsByLogicalId = Object.fromEntries(
    mapPlan.tasks.map((task) => [task.logicalId, `doc_${task.index}`]),
  );
  const request = {
    scopeId: "workflow-run-100",
    sourceStepId: "map",
    sourcePort: "counts",
    stepId: "reduce",
    aggregatorMemberId: "member_a",
    strategy: "hierarchical" as const,
    mapPlan,
    contributionIdsByLogicalId,
    action,
  };
  const plan = planAggregationForFrozenPartitions(request);
  assert.equal(plan.version, "workflow-aggregation/v1");
  assert.equal(plan.placement, "room-member");
  assert.equal(plan.aggregatorMemberId, "member_a");
  assert.equal(plan.invocations.length, 8);
  const publications = plan.invocations.map((invocation) =>
    v3AggregationTaskMetadata({
      scopeId: plan.scopeId,
      stepId: plan.stepId,
      taskId: invocation.taskId,
      roomId: "room",
      channelId: "objects",
      outputPorts: ["counts"],
    }).v3OutputRoutes.counts,
  );
  assert.equal(publications.length, 8);
  assert.equal(new Set(publications.map((item) =>
    item?.retentionObligationId)).size, 8);
  assert.ok(publications.every((item) =>
    item?.channelId === "objects" &&
    item.availability === "temporary" &&
    item.targetMemberIds.length === 0 &&
    Date.parse(item.requiredUntil) > Date.now()));
  assert.deepEqual(
    plan.invocations[0]?.collection.sources.map((source) => source.taskId),
    mapPlan.tasks.slice(0, 15).map((task) => task.logicalId),
  );
  assert.deepEqual(
    plan.invocations.at(-1)?.collection.expectedContributionIds,
    mapPlan.tasks.map((task) => `doc_${task.index}`),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  assert.throws(
    () => planAggregationForFrozenPartitions({ ...request, aggregatorMemberId: "member_elsewhere" }),
    /outside the frozen map cohort/,
  );
  assert.deepEqual(
    planAggregationForFrozenPartitions({
      ...request,
      mapPlan: { ...mapPlan, tasks: [...mapPlan.tasks].reverse() },
    }),
    plan,
  );
  assert.throws(
    () =>
      planAggregationForFrozenPartitions({
        ...request,
        contributionIdsByLogicalId: {
          ...contributionIdsByLogicalId,
          "partition:0": "",
        },
      }),
    /unique nonempty contribution IDs/,
  );
});

test("persisted collection plan accepts identical replay and rejects a changed cohort", async () => {
  const mapPlan: FrozenLogicalPartitionPlan = {
    mode: "partition-map",
    partitionPlanVersion: "logical/v1",
    maxParallelism: 1,
    tasks: [
      {
        kind: "step-partition",
        logicalId: "partition:0",
        index: 0,
        count: 1,
        input: { document: "" },
        eligibleMemberIds: ["member_a"],
      },
    ],
  };
  const plan = planAggregationForFrozenPartitions({
    scopeId: "run:reduce",
    sourceStepId: "map",
    sourcePort: "counts",
    stepId: "reduce",
    aggregatorMemberId: "member_a",
    strategy: "flat",
    mapPlan,
    contributionIdsByLogicalId: { "partition:0": "doc_0" },
    action,
  });
  let stored: Record<string, unknown> = {};
  const client = {
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params: unknown[],
    ): Promise<{ rows: T[] }> => {
      const proposed = JSON.parse(String(params[2])) as Record<string, unknown>;
      if (sql.includes("UPDATE execution.execution_plans")) {
        if (Object.keys(stored).length) return { rows: [] };
        stored = proposed;
        return { rows: [{ id: "plan_1" }] as unknown as T[] };
      }
      if (sql.includes("SELECT plan_json - 'admitted'"))
        return {
          rows: [
            {
              same:
                JSON.stringify({ ...stored, admitted: undefined }) ===
                JSON.stringify({ ...proposed, admitted: undefined }),
            },
          ] as unknown as T[],
        };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  await persistFrozenAggregationPlanPg(client, "plan_1", "step_run_1", plan);
  await persistFrozenAggregationPlanPg(client, "plan_1", "step_run_1", plan);
  await assert.rejects(
    () =>
      persistFrozenAggregationPlanPg(client, "plan_1", "step_run_1", {
        ...plan,
        scopeId: "different-run",
      }),
    /conflicts/,
  );
});

test("transactional admission waits for accepted available artifacts and admits once", async () => {
  const mapPlan: FrozenLogicalPartitionPlan = {
    mode: "partition-map",
    partitionPlanVersion: "logical/v1",
    maxParallelism: 2,
    tasks: [0, 1].map((index) => ({
      kind: "step-partition",
      logicalId: `partition:${index}`,
      index,
      count: 2,
      input: { document: "" },
      eligibleMemberIds: ["member_a", "member_b"],
    })),
  };
  const plan = planAggregationForFrozenPartitions({
    scopeId: "run:reduce-step",
    sourceStepId: "map",
    sourcePort: "counts",
    stepId: "reduce",
    aggregatorMemberId: "member_a",
    strategy: "flat",
    mapPlan,
    contributionIdsByLogicalId: {
      "partition:0": "doc_0",
      "partition:1": "doc_1",
    },
    action,
  });
  const accepted = new Map<string, Record<string, unknown>>();
  let available = true;
  let recipientAvailable = true;
  const artifact = (index: number) => ({
    id: `artifact_${index}`,
    type: "application/json",
    name: "counts",
    uri: `data:application/vnd.beam.term-counts.v1+json;base64,${Buffer.from(
      JSON.stringify({ documentIds: [`doc_${index}`], counts: {} }),
    ).toString("base64")}`,
    mediaType: "application/vnd.beam.term-counts.v1+json",
    metadata: { port: "counts" },
  });
  const row = (index: number) => ({
    id: `task_${index}`,
    status: "completed",
    manifest_id: `manifest_${index}`,
    manifest_status: "accepted",
    accepted_count: "1",
    artifacts_json: [
      {
        artifactId: `artifact_${index}`,
        port: "counts",
        mediaType: "application/vnd.beam.term-counts.v1+json",
        sha256: `sha256:${String(index).padStart(64, "0")}`,
        sizeBytes: 32,
      },
    ],
    result_json: { artifacts: [artifact(index)] },
  });
  accepted.set("partition:0", row(0));
  let persisted: Record<string, unknown> = structuredClone(plan);
  const client = {
    query: async <T extends Record<string, unknown>>(
      sql: string,
      params: unknown[],
    ): Promise<{ rows: T[] }> => {
      if (sql.includes("SELECT plan_json"))
        return { rows: [{ plan_json: persisted }] as unknown as T[] };
      if (sql.includes("FROM execution.workflow_tasks")) {
        const found = accepted.get(String(params[3]));
        return { rows: (found ? [found] : []) as unknown as T[] };
      }
      if (sql.includes("SELECT i.sha256,i.size_bytes,i.media_type"))
        return { rows: recipientAvailable ? [{
          sha256: `sha256:${String(params[1]).slice(-1).padStart(64, "0")}`,
          size_bytes: "32",
          media_type: "application/vnd.beam.term-counts.v1+json",
          room_id: "room_1",
          channel_id: "channel_1",
          source_member_id: "member_a",
          member_id: frozenReader,
          transfer_id: "transfer_1",
        }] as unknown as T[] : [] };
      if (sql.includes("workflow_artifact_locations"))
        return { rows: [{ available }] as unknown as T[] };
      if (sql.includes("SET plan_json=")) {
        persisted = JSON.parse(String(params[2])) as Record<string, unknown>;
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const enqueued: unknown[] = [];
  const blocked: unknown[] = [];
  let frozenReader = "member_a";
  const request = {
    executionPlanId: "plan_1",
    workflowRunId: "run_1",
    workflowStepRunId: "reduce_step_run",
    sourceStepRunId: "map_step_run",
    taskId: "studio",
    consumerMemberId: "member_a",
    authorizeRead: async () => {},
    block: async (failure: unknown) => { blocked.push(failure); },
    enqueue: async (ready: unknown) => {
      enqueued.push(ready);
    },
  };
  assert.equal(
    await admitFrozenAggregationInvocationPg(client as unknown as PgClient, request),
    "waiting",
  );
  assert.equal(enqueued.length, 0);
  accepted.set("partition:1", { ...row(1), status: "running" });
  assert.equal(
    await admitFrozenAggregationInvocationPg(client as unknown as PgClient, request),
    "waiting",
  );
  accepted.set("partition:1", { ...row(1), status: "failed" });
  assert.equal(await admitFrozenAggregationInvocationPg(client as unknown as PgClient, request), "blocked");
  assert.deepEqual(blocked.at(-1), {
    taskId: "studio", sourceTaskId: "partition:1", reason: "Required source ended with failed.",
  });
  assert.equal(await admitFrozenAggregationInvocationPg(client as unknown as PgClient, request), "blocked");
  assert.equal(blocked.length, 1);
  persisted = structuredClone(plan);
  accepted.set("partition:1", { ...row(1), manifest_id: null });
  assert.equal(await admitFrozenAggregationInvocationPg(client as unknown as PgClient, request), "blocked");
  assert.match((blocked.at(-1) as { reason: string }).reason, /without an accepted/);
  persisted = structuredClone(plan);
  accepted.set("partition:1", { ...row(1), accepted_count: "2" });
  await assert.rejects(
    () => admitFrozenAggregationInvocationPg(client as unknown as PgClient, request),
    /multiple accepted/,
  );
  accepted.set("partition:1", row(1));
  available = false;
  await assert.rejects(
    () => admitFrozenAggregationInvocationPg(client as unknown as PgClient, request),
    /unavailable/,
  );
  available = true;
  recipientAvailable = false;
  assert.equal(
    await admitFrozenAggregationInvocationPg(client as unknown as PgClient, request),
    "waiting",
  );
  recipientAvailable = true;
  frozenReader = "wrong_member";
  await assert.rejects(
    () => admitFrozenAggregationInvocationPg(client as unknown as PgClient, request),
    /accepted artifact or reader/,
  );
  frozenReader = "member_a";
  assert.equal(
    await admitFrozenAggregationInvocationPg(client as unknown as PgClient, request),
    "admitted",
  );
  assert.equal(enqueued.length, 1);
  assert.equal((enqueued[0] as { targetMemberId: string }).targetMemberId, "member_a");
  assert.equal((enqueued[0] as { placement: string }).placement, "room-member");
  assert.deepEqual(
    (enqueued[0] as { expectedContributionIds: string[] })
      .expectedContributionIds,
    ["doc_0", "doc_1"],
  );
  assert.deepEqual(
    (enqueued[0] as {
      metadata: { aggregation: { id: string }; artifactInputs: { contributions: unknown[] } };
    }).metadata.aggregation.id,
    "studio",
  );
  assert.equal(
    (enqueued[0] as { metadata: { artifactInputs: { contributions: unknown[] } } })
      .metadata.artifactInputs.contributions.length,
    2,
  );
  assert.equal(
    await admitFrozenAggregationInvocationPg(client as unknown as PgClient, request),
    "already-admitted",
  );
  assert.equal(enqueued.length, 1);
});
