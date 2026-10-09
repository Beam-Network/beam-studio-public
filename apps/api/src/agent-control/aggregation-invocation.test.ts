import assert from "node:assert/strict";
import { test } from "node:test";
import type { PgClient } from "@beam-studio/db";
import { frozenAggregationInvocationConfigPg } from "./aggregation-invocation.js";

test("room-member assignment derives reduce config from the admitted collection", async () => {
  const plan = {
    version: "workflow-aggregation/v1",
    placement: "room-member",
    aggregatorMemberId: "member_a",
    invocations: [{
      taskId: "studio",
      collection: {
        collectionId: "collection_1",
        expectedContributionIds: ["doc_0", "doc_1"],
      },
    }],
    admitted: { studio: { collectionId: "collection_1", contentChecksum: "hash_1" } },
  };
  const client = {
    query: async () => ({ rows: [{ plan_json: plan }] }),
  } as unknown as PgClient;
  const task = {
    metadata_json: { aggregation: {
      id: "studio",
      executionPlanId: "plan_1",
      collectionId: "collection_1",
      expectedContributionIds: ["doc_0", "doc_1"],
      contentChecksum: "hash_1",
      targetMemberId: "member_a",
    } },
  };
  const step = {
    config: {},
    manifestSnapshot: {
      contracts: { computation: {
        semanticId: "beam.term-count-reduce/v1",
        aggregation: { inputPort: "contributions" },
      } },
    },
  };
  assert.deepEqual(
    await frozenAggregationInvocationConfigPg(client, task, step, "step_run_1", "member_a"),
    { collectionId: "collection_1", expectedDocumentIds: ["doc_0", "doc_1"] },
  );
  await assert.rejects(
    () => frozenAggregationInvocationConfigPg(client, task, step, "step_run_1", "member_b"),
    /frozen plan/,
  );
  task.metadata_json.aggregation.expectedContributionIds = ["doc_1", "doc_0"];
  await assert.rejects(
    () => frozenAggregationInvocationConfigPg(client, task, step, "step_run_1", "member_a"),
    /frozen plan/,
  );
});
