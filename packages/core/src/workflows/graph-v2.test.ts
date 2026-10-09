import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKFLOW_GRAPH_V2,
  WorkflowGraphV2ValidationError,
  convertWorkflowGraphV1ToV2,
  conditionTraceForEvaluation,
  dynamicAttemptKey,
  dynamicInstanceKey,
  resolveFanOutItems,
  resolveDynamicGraphValue,
  resolveLoopIterations,
  validateWorkflowGraphV2,
  workflowGraphV2Limits,
  type WorkflowGraphV2Definition,
} from "../index.js";

const steps = [
  { id: "before", enabled: true },
  { id: "body_a", enabled: true },
  { id: "body_b", enabled: true },
  { id: "after", enabled: true },
];

test("converts an ordinary V1 DAG to V2 without changing its edges", () => {
  const edges = [
    { id: "edge_a", from: "before", to: "after", condition: true },
  ];
  const converted = convertWorkflowGraphV1ToV2({ edges });

  assert.deepEqual(converted, {
    version: WORKFLOW_GRAPH_V2,
    controls: [],
    edges,
  });
  assert.notEqual(converted.edges, edges);
  validateWorkflowGraphV2(converted, [steps[0]!, steps[3]!]);
});

test("validates a bounded loop as a structured acyclic region", () => {
  const graph: WorkflowGraphV2Definition = {
    version: WORKFLOW_GRAPH_V2,
    controls: [
      {
        id: "repeat",
        kind: "loop",
        iterations: 3,
        outputMode: "all",
        body: {
          stepIds: ["body_a", "body_b"],
          entryStepId: "body_a",
          outputStepId: "body_b",
          edges: [{ from: "body_a", to: "body_b" }],
        },
      },
    ],
    edges: [
      { from: "before", to: "repeat" },
      { from: "repeat", to: "after" },
    ],
  };

  const result = validateWorkflowGraphV2(graph, steps);
  assert.equal(result.maximumExpandedInstances, 8);
  assert.deepEqual([...result.ownedStepIds], ["body_a", "body_b"]);
});

test("validates fan-out and fan-in boundary direction", () => {
  const graph = fanOutGraph(["same", "same", "different"]);
  const result = validateWorkflowGraphV2(graph, steps);

  assert.equal(result.maximumExpandedInstances, 8);
  assert.throws(
    () =>
      validateWorkflowGraphV2(
        {
          ...graph,
          edges: [
            { from: "before", to: "parallel" },
            { from: "parallel", to: "after" },
          ],
        },
        steps,
      ),
    /leave through fan-in/,
  );
});

test("accepts an empty fan-out and rejects invalid runtime values", () => {
  assert.deepEqual(resolveFanOutItems([]), []);
  assert.throws(
    () => resolveFanOutItems({ value: "not-an-array" }),
    /must resolve to an array/,
  );
  assert.throws(() => resolveLoopIterations(0), /positive integer/);
  assert.throws(() => resolveLoopIterations(1.5), /positive integer/);
  assert.throws(
    () => resolveLoopIterations(workflowGraphV2Limits.maxLoopIterations + 1),
    /exceeds the limit/,
  );
});

test("rejects malformed regions, cross-boundary edges, and body cycles", () => {
  const graph = fanOutGraph([1]);
  const control = graph.controls[0]!;
  assert.equal(control.kind, "fan-out");

  assert.throws(
    () =>
      validateWorkflowGraphV2(
        {
          ...graph,
          controls: [
            {
              ...control,
              body: {
                ...control.body,
                edges: [
                  { from: "body_a", to: "body_b" },
                  { from: "body_b", to: "body_a" },
                ],
              },
            },
          ],
        },
        steps,
      ),
    /contains a cycle/,
  );

  assert.throws(
    () =>
      validateWorkflowGraphV2(
        {
          ...graph,
          controls: [
            {
              ...control,
              body: {
                ...control.body,
                edges: [{ from: "body_a", to: "after" }],
              },
            },
          ],
        },
        steps,
      ),
    /crosses a region boundary/,
  );
});

test("rejects excessive concurrency, item count, and expansion", () => {
  const graph = fanOutGraph([1]);
  const control = graph.controls[0]!;
  assert.equal(control.kind, "fan-out");

  assert.throws(
    () =>
      validateWorkflowGraphV2(
        {
          ...graph,
          controls: [
            {
              ...control,
              concurrency: workflowGraphV2Limits.maxFanOutConcurrency + 1,
            },
          ],
        },
        steps,
      ),
    /concurrency must be between/,
  );

  assert.throws(
    () =>
      resolveFanOutItems(
        Array.from(
          { length: workflowGraphV2Limits.maxFanOutItems + 1 },
          () => null,
        ),
      ),
    /exceeds the limit/,
  );

  assert.throws(
    () =>
      validateWorkflowGraphV2(graph, steps, {
        ...workflowGraphV2Limits,
        maxExpandedActionInstances: 3,
      }),
    /action instances/,
  );
});

test("dynamic instance and attempt identities are stable and index-based", () => {
  const coordinate = {
    workflowRunId: "wfr:1",
    controlPath: "parallel/main",
    workflowStepId: "body_a",
    instanceIndex: 2,
  };

  assert.equal(dynamicInstanceKey(coordinate), dynamicInstanceKey(coordinate));
  assert.notEqual(
    dynamicInstanceKey(coordinate),
    dynamicInstanceKey({ ...coordinate, instanceIndex: 3 }),
  );
  assert.match(dynamicAttemptKey({ ...coordinate, attempt: 2 }), /attempt:2$/);
  assert.throws(
    () => dynamicAttemptKey({ ...coordinate, attempt: 0 }),
    WorkflowGraphV2ValidationError,
  );
});

test("resolves dynamic bindings and emits structured condition reasons", () => {
  assert.deepEqual(
    resolveDynamicGraphValue(
      {
        index: "${graph.parallel.index}",
        item: "${graph.parallel.item.payload}",
      },
      {
        parallel: {
          index: 4,
          item: { payload: "value" },
        },
      },
    ),
    { index: 4, item: "value" },
  );
  assert.deepEqual(
    conditionTraceForEvaluation({ conditionPresent: true, result: false }),
    { outcome: "skipped", result: false, reason: "condition_false" },
  );
  assert.deepEqual(
    conditionTraceForEvaluation({
      conditionPresent: true,
      upstreamStatus: "failed",
    }),
    { outcome: "not_reached", result: null, reason: "upstream_failed" },
  );
  assert.deepEqual(
    conditionTraceForEvaluation({
      conditionPresent: true,
      upstreamStatus: "skipped",
    }),
    { outcome: "not_reached", result: null, reason: "upstream_skipped" },
  );
});

function fanOutGraph(items: unknown[]): WorkflowGraphV2Definition {
  return {
    version: WORKFLOW_GRAPH_V2,
    controls: [
      {
        id: "parallel",
        kind: "fan-out",
        items: items as never,
        concurrency: 2,
        fanInId: "parallel_join",
        body: {
          stepIds: ["body_a", "body_b"],
          entryStepId: "body_a",
          outputStepId: "body_b",
          edges: [{ from: "body_a", to: "body_b" }],
        },
      },
    ],
    edges: [
      { from: "before", to: "parallel" },
      { from: "parallel_join", to: "after" },
    ],
  };
}
