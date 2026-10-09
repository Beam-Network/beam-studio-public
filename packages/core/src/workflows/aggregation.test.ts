import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  aggregationCollectionId,
  closeAggregationCollection,
  planAggregationInvocations,
  prepareAggregationActionInput,
} from "./aggregation.js";
import { validateActionManifest, type ActionManifestV2 } from "./actions.js";
import {
  resolveWorkflowGraphV3,
  validateWorkflowGraphV3,
  type WorkflowGraphV3Definition,
} from "./graph-v3.js";

const format = "application/vnd.beam.term-counts.v1+json";
const manifestFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/term-count-reduce-v2.json", import.meta.url),
    "utf8",
  ),
) as ActionManifestV2;

function aggregationAction(associative = true): ActionManifestV2 {
  const manifest = structuredClone(manifestFixture);
  manifest.contracts.computation.aggregation!.associative = associative;
  manifest.contracts.computation.aggregation!.closedUnderCombination =
    associative;
  return manifest;
}

function graph(count: number, strategy: "flat" | "hierarchical") {
  const ids = Array.from({ length: count }, (_, index) => `document_${index}`);
  const definition: WorkflowGraphV3Definition = {
    version: "workflow-graph/v3",
    controls: [],
    edges: [{ from: "map", to: "reduce" }],
    distribution: {
      partitions: [
        {
          id: "documents",
          members: { kind: "explicit", memberIds: ids },
          order: "declared",
        },
      ],
      steps: [
        {
          stepId: "map",
          partitionId: "documents",
          placement: "room-member",
          inputs: [],
          outputs: [
            { name: "counts", kind: "artifact", cardinality: "one", format },
          ],
        },
        {
          stepId: "reduce",
          partitionId: "documents",
          placement: "room-member",
          inputs: [
            {
              name: "contributions",
              kind: "artifact",
              cardinality: "non-empty-many",
              format,
            },
          ],
          outputs: [
            { name: "counts", kind: "artifact", cardinality: "one", format },
          ],
          aggregation: { strategy },
        },
      ],
      routes: [
        {
          from: { stepId: "map", port: "counts" },
          to: { stepId: "reduce", port: "contributions" },
          association: { kind: "collect" },
        },
      ],
    },
  };
  return {
    definition,
    steps: [
      { id: "map", enabled: true },
      { id: "reduce", enabled: true },
    ],
    members: { documents: ids.map((memberId) => ({ memberId })) },
  };
}

test("a flat aggregation is one explicit action after its frozen sources", () => {
  const action = aggregationAction(false);
  validateActionManifest(action);
  const input = graph(3, "flat");
  validateWorkflowGraphV3(input.definition, input.steps);
  const plan = resolveWorkflowGraphV3(
    input.definition,
    input.steps,
    input.members,
    { reduce: action },
    "workflow-run-1",
  );
  assert.equal(plan.tasks.length, 4);
  assert.equal(plan.routes.length, 3);
  assert.equal(plan.tasks.at(-1)?.assignedMemberId, "document_0");
  assert.equal(plan.tasks.at(-1)?.placement, "room-member");
  assert.deepEqual(
    plan.tasks
      .find((task) => task.stepId === "reduce")
      ?.collection?.sources.map(({ taskId }) => taskId),
    ["document_0", "document_1", "document_2"],
  );
  assert.throws(
    () =>
      resolveWorkflowGraphV3(
        graph(3, "hierarchical").definition,
        input.steps,
        input.members,
        { reduce: action },
        "workflow-run-1",
      ),
    /associative closed combination/,
  );
});

test("aggregation placement follows its own frozen partition when partitions differ", () => {
  const input = graph(3, "flat");
  input.definition.distribution.partitions.push({
    id: "reducers",
    members: { kind: "explicit", memberIds: ["member_elsewhere"] },
    order: "declared",
  });
  input.definition.distribution.steps[1]!.partitionId = "reducers";
  const plan = resolveWorkflowGraphV3(
    input.definition,
    input.steps,
    { ...input.members, reducers: [{ memberId: "member_elsewhere" }] },
    { reduce: aggregationAction(false) },
    "workflow-run-1",
  );
  assert.equal(plan.tasks.at(-1)?.assignedMemberId, "member_elsewhere");
  assert.equal(plan.tasks.at(-1)?.placement, "room-member");
});

test("hierarchical aggregation groups contiguous sources only with a closed associative contract", () => {
  const action = aggregationAction();
  validateActionManifest(action);
  const input = graph(100, "hierarchical");
  const plan = resolveWorkflowGraphV3(
    input.definition,
    input.steps,
    input.members,
    { reduce: action },
    "workflow-run-1",
  );
  const reductions = plan.tasks.filter((task) => task.stepId === "reduce");
  assert.equal(reductions.length, 8);
  assert.ok(reductions.every((task) => task.assignedMemberId === "document_0"));
  assert.equal(plan.routes.length, 107);
  assert.deepEqual(
    reductions[0]?.collection?.sources.map(({ taskId }) => taskId),
    Array.from({ length: 15 }, (_, index) => `document_${index}`),
  );
  assert.deepEqual(
    reductions.at(-1)?.collection?.sources.map(({ taskId }) => taskId),
    Array.from({ length: 7 }, (_, index) => `aggregation_0_${index}`),
  );
  assert.deepEqual(
    reductions.at(-1)?.collection?.expectedContributionIds,
    Array.from({ length: 100 }, (_, index) => `document_${index}`),
  );
  assert.throws(() => {
    const flat = graph(100, "flat");
    resolveWorkflowGraphV3(
      flat.definition,
      flat.steps,
      flat.members,
      {
        reduce: action,
      },
      "workflow-run-1",
    );
  }, /artifact limit/);
});

test("100 logical document tasks retain their identities across three eligible members", () => {
  const logicalTasks = Array.from({ length: 100 }, (_, index) => ({
    logicalId: `partition:${index}`,
    index,
    documentId: `doc_${index}`,
    eligibleMemberIds: ["member_a", "member_b", "member_c"],
  }));
  const options = {
    scopeId: "workflow-run-100",
    stepId: "reduce",
    inputPort: "contributions",
    outputPort: "counts",
    contributionFormat: format,
    maxArtifacts: 16,
    strategy: "hierarchical" as const,
    associative: true,
    closedUnderCombination: true,
    sources: logicalTasks.map((task) => ({
      stepId: "map",
      taskId: task.logicalId,
      contributionId: task.documentId,
      port: "counts",
      index: task.index,
    })),
  };
  const plan = planAggregationInvocations(options);
  assert.equal(plan.length, 8);
  assert.equal(plan[0]?.collection.sources.length, 15);
  assert.deepEqual(
    plan[0]?.collection.sources.map((source) => source.taskId),
    logicalTasks.slice(0, 15).map((task) => task.logicalId),
  );
  assert.deepEqual(
    plan.at(-1)?.collection.expectedContributionIds,
    logicalTasks.map((task) => task.documentId),
  );
  assert.equal(
    plan.at(-1)?.collection.collectionId,
    planAggregationInvocations({
      ...options,
      sources: [...options.sources].reverse(),
    }).at(-1)?.collection.collectionId,
  );
  assert.equal(logicalTasks[0]?.eligibleMemberIds.length, 3);
});

test("closure waits for accepted empty contributions and ignores delivery order and repeats", () => {
  const expected = [
    { stepId: "map", taskId: "b", port: "counts", index: 1 },
    { stepId: "map", taskId: "a", port: "counts", index: 0 },
    { stepId: "map", taskId: "c", port: "counts", index: 2 },
  ];
  const accepted = [
    {
      stepId: "map",
      taskId: "c",
      port: "counts",
      accepted: true as const,
      value: null,
    },
    {
      stepId: "map",
      taskId: "b",
      port: "counts",
      accepted: true as const,
      value: {},
    },
    {
      stepId: "map",
      taskId: "a",
      port: "counts",
      accepted: true as const,
      value: [],
    },
  ];
  assert.equal(
    closeAggregationCollection(expected, accepted.slice(0, 2)),
    null,
  );
  const first = closeAggregationCollection(expected, accepted)!;
  const second = closeAggregationCollection(expected, [
    accepted[2]!,
    accepted[1]!,
    accepted[0]!,
    accepted[2]!,
  ])!;
  assert.equal(first.collectionId, second.collectionId);
  const frozenId = aggregationCollectionId(
    "workflow-run-1",
    { stepId: "reduce", taskId: "studio" },
    expected,
  );
  assert.equal(
    closeAggregationCollection(expected, accepted, frozenId)?.collectionId,
    frozenId,
  );
  const frozen = {
    collectionId: frozenId,
    inputPort: "contributions",
    contributionFormat: format,
    sources: expected,
    expectedContributionIds: ["a", "b", "c"],
  };
  const formatted = accepted.map((contribution) => ({
    ...contribution,
    format,
  }));
  assert.equal(
    prepareAggregationActionInput(frozen, formatted.slice(0, 2)),
    null,
  );
  assert.deepEqual(prepareAggregationActionInput(frozen, formatted), {
    input: { contributions: [[], {}, null] },
    collectionId: frozenId,
    contentChecksum: first.contentChecksum,
    expectedContributionIds: ["a", "b", "c"],
  });
  assert.throws(
    () =>
      prepareAggregationActionInput(frozen, [
        { ...formatted[0]!, format: "text/plain" },
      ]),
    /incompatible format/,
  );
  assert.deepEqual(first.values, [[], {}, null]);
  assert.throws(
    () =>
      closeAggregationCollection(expected, [
        ...accepted,
        { ...accepted[2]!, value: { changed: true } },
      ]),
    /conflicting/,
  );
  assert.throws(
    () =>
      closeAggregationCollection(expected, [
        { ...accepted[0]!, taskId: "unknown" },
      ]),
    /unexpected/,
  );
});
