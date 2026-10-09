import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateWorkflowDecision,
  resolvePredicate,
  workflowPredicateError,
  type WorkflowDecision,
  type WorkflowDecisionContext,
  type WorkflowDecisionPredicate,
} from "./decisions.js";

const terminalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "not_reached",
]);

function context(
  input: {
    statuses?: Record<string, string>;
    outputs?: Record<string, Record<string, unknown>>;
    workflowInputs?: Record<string, unknown>;
  } = {},
): WorkflowDecisionContext {
  return {
    statusByNode: new Map(Object.entries(input.statuses ?? {})),
    outputsByStep: new Map(
      Object.entries(input.outputs ?? {}) as Array<
        [string, Record<string, never>]
      >,
    ),
    workflowInputs: (input.workflowInputs ?? {}) as Record<string, never>,
    workflowConfig: {},
  };
}

function decision(overrides: Partial<WorkflowDecision> = {}): WorkflowDecision {
  return {
    id: "dec_1",
    name: "Decision",
    kind: "if",
    enabled: true,
    joinMode: "all",
    handleFailure: false,
    ...overrides,
  };
}

function calibrationSwitch(eligible: number) {
  return evaluateWorkflowDecision({
    decision: decision({
      kind: "switch",
      cases: [
        {
          id: "one_gib",
          name: "1 GiB",
          predicate: {
            all: [
              {
                left: "${steps.pool.outputs.body.pools.qualifying.eligible}",
                op: "gte",
                right: 1,
              },
              {
                left: "${steps.pool.outputs.body.pools.qualifying.eligible}",
                op: "lte",
                right: 5,
              },
            ],
          },
        },
        {
          id: "five_gib",
          name: "5 GiB",
          predicate: {
            all: [
              {
                left: "${steps.pool.outputs.body.pools.qualifying.eligible}",
                op: "gte",
                right: 6,
              },
              {
                left: "${steps.pool.outputs.body.pools.qualifying.eligible}",
                op: "lte",
                right: 25,
              },
            ],
          },
        },
        {
          id: "ten_gib",
          name: "10 GiB",
          predicate: {
            left: "${steps.pool.outputs.body.pools.qualifying.eligible}",
            op: "gte",
            right: 26,
          },
        },
      ],
    }),
    inputNodeIds: ["pool"],
    context: context({
      statuses: { pool: "completed" },
      outputs: {
        pool: { body: { pools: { qualifying: { eligible } } } },
      },
    }),
    terminalStatuses,
  });
}

test("Switch selects the expected calibration branch at every boundary", () => {
  assert.equal(calibrationSwitch(0).branch, "default");
  assert.equal(calibrationSwitch(1).branch, "case:one_gib");
  assert.equal(calibrationSwitch(5).branch, "case:one_gib");
  assert.equal(calibrationSwitch(6).branch, "case:five_gib");
  assert.equal(calibrationSwitch(25).branch, "case:five_gib");
  assert.equal(calibrationSwitch(26).branch, "case:ten_gib");
});

test("Switch uses the first matching case and otherwise Default", () => {
  const outcome = evaluateWorkflowDecision({
    decision: decision({
      kind: "switch",
      cases: [
        { id: "first", name: "First", predicate: true },
        { id: "second", name: "Second", predicate: true },
      ],
    }),
    inputNodeIds: [],
    context: context(),
    terminalStatuses,
  });
  assert.equal(outcome.branch, "case:first");
  assert.equal(outcome.reason, "case_matched");

  const fallback = evaluateWorkflowDecision({
    decision: decision({
      kind: "switch",
      cases: [{ id: "never", name: "Never", predicate: false }],
    }),
    inputNodeIds: [],
    context: context(),
    terminalStatuses,
  });
  assert.equal(fallback.branch, "default");
  assert.equal(fallback.reason, "switch_default");
});

test("predicate validation rejects malformed structures", () => {
  assert.equal(workflowPredicateError({ left: 1, op: "gte", right: 0 }), null);
  assert.match(workflowPredicateError({ all: [] }) ?? "", /at least one/);
  assert.match(workflowPredicateError({ left: 1, op: "gte" }) ?? "", /right/);
  assert.match(
    workflowPredicateError({ left: 1, op: "made_up", right: 2 }) ?? "",
    /supported operator/,
  );
});

test("waits while any input is still running", () => {
  const outcome = evaluateWorkflowDecision({
    decision: decision(),
    inputNodeIds: ["a", "b"],
    context: context({ statuses: { a: "completed", b: "running" } }),
    terminalStatuses,
  });
  assert.equal(outcome.evaluated, false);
  assert.equal(outcome.reason, "inputs_pending");
  assert.equal(outcome.branch, null);
});

test("all join takes the true branch when every input completed", () => {
  const outcome = evaluateWorkflowDecision({
    decision: decision({ joinMode: "all" }),
    inputNodeIds: ["a", "b"],
    context: context({ statuses: { a: "completed", b: "completed" } }),
    terminalStatuses,
  });
  assert.equal(outcome.branch, "true");
  assert.equal(outcome.reason, "predicate_absent");
});

test("all join takes the false branch when one input failed", () => {
  const outcome = evaluateWorkflowDecision({
    decision: decision({ joinMode: "all" }),
    inputNodeIds: ["a", "b"],
    context: context({ statuses: { a: "completed", b: "failed" } }),
    terminalStatuses,
  });
  assert.equal(outcome.evaluated, true, "a failed input must still evaluate");
  assert.equal(outcome.branch, "false");
  assert.equal(outcome.reason, "join_unsatisfied");
});

test("any_settled join takes the true branch when one of several completed", () => {
  const outcome = evaluateWorkflowDecision({
    decision: decision({ joinMode: "any_settled" }),
    inputNodeIds: ["a", "b"],
    context: context({ statuses: { a: "failed", b: "completed" } }),
    terminalStatuses,
  });
  assert.equal(outcome.branch, "true");
});

test("any_settled still waits for every input to settle", () => {
  const outcome = evaluateWorkflowDecision({
    decision: decision({ joinMode: "any_settled" }),
    inputNodeIds: ["fast", "slow"],
    context: context({ statuses: { fast: "completed", slow: "running" } }),
    terminalStatuses,
  });
  assert.equal(
    outcome.evaluated,
    false,
    "any_settled is a barrier, not short-circuit",
  );
  assert.equal(outcome.reason, "inputs_pending");
});

test("skipped and not_reached inputs count as unsatisfied", () => {
  const outcome = evaluateWorkflowDecision({
    decision: decision({ joinMode: "any_settled" }),
    inputNodeIds: ["a", "b"],
    context: context({ statuses: { a: "skipped", b: "not_reached" } }),
    terminalStatuses,
  });
  assert.equal(outcome.branch, "false");
  assert.equal(outcome.reason, "join_unsatisfied");
});

test("handled failures are recorded only when the node opts in", () => {
  const inputs = ["a", "b"];
  const statuses = { a: "failed", b: "completed" };
  const off = evaluateWorkflowDecision({
    decision: decision({ handleFailure: false }),
    inputNodeIds: inputs,
    context: context({ statuses }),
    terminalStatuses,
  });
  assert.deepEqual(off.handledFailures, []);

  const on = evaluateWorkflowDecision({
    decision: decision({ handleFailure: true }),
    inputNodeIds: inputs,
    context: context({ statuses }),
    terminalStatuses,
  });
  assert.deepEqual(
    on.handledFailures,
    ["a"],
    "only the failed input is consumed",
  );
});

test("a decision with no inputs does not stall", () => {
  const outcome = evaluateWorkflowDecision({
    decision: decision({ joinMode: "any_settled" }),
    inputNodeIds: [],
    context: context(),
    terminalStatuses,
  });
  assert.equal(outcome.branch, "true");
});

test("predicate can branch on an upstream step status", () => {
  const outcome = evaluateWorkflowDecision({
    decision: decision({
      predicate: {
        left: { step: "a", field: "status" },
        op: "eq",
        right: "failed",
      },
    }),
    inputNodeIds: ["a"],
    context: context({ statuses: { a: "completed" } }),
    terminalStatuses,
  });
  assert.equal(outcome.branch, "false");
  assert.equal(outcome.reason, "predicate_false");
});

test("comparison operators", () => {
  const ctx = context({
    outputs: { a: { bytes: 10, name: "beam", tags: ["x"] } },
  });
  const cases: Array<[WorkflowDecisionPredicate, boolean]> = [
    [{ left: "${steps.a.outputs.bytes}", op: "gt", right: 0 }, true],
    [{ left: "${steps.a.outputs.bytes}", op: "gte", right: 10 }, true],
    [{ left: "${steps.a.outputs.bytes}", op: "lt", right: 10 }, false],
    [{ left: "${steps.a.outputs.bytes}", op: "lte", right: 10 }, true],
    [{ left: "${steps.a.outputs.name}", op: "eq", right: "beam" }, true],
    [{ left: "${steps.a.outputs.name}", op: "ne", right: "other" }, true],
    [{ left: "${steps.a.outputs.name}", op: "exists" }, true],
    [{ left: "${steps.a.outputs.missing}", op: "exists" }, false],
    [{ left: "${steps.a.outputs.missing}", op: "empty" }, true],
    [{ left: "${steps.a.outputs.tags}", op: "contains", right: "x" }, true],
    [{ left: "${steps.a.outputs.name}", op: "contains", right: "ea" }, true],
  ];
  for (const [predicate, expected] of cases) {
    assert.equal(
      resolvePredicate(predicate, ctx).result,
      expected,
      JSON.stringify(predicate),
    );
  }
});

test("ordered comparison against a non-numeric operand is false, not an error", () => {
  const ctx = context({ outputs: { a: { name: "beam" } } });
  const outcome = resolvePredicate(
    { left: "${steps.a.outputs.name}", op: "gt", right: 5 },
    ctx,
  );
  assert.equal(outcome.result, false);
  assert.equal(outcome.reason, "predicate_false");
});

test("all / any / not grouping", () => {
  const ctx = context({
    statuses: { a: "completed" },
    outputs: { a: { bytes: 10 } },
  });
  assert.equal(
    resolvePredicate(
      {
        all: [
          {
            left: { step: "a", field: "status" },
            op: "eq",
            right: "completed",
          },
          { left: "${steps.a.outputs.bytes}", op: "gt", right: 0 },
        ],
      },
      ctx,
    ).result,
    true,
  );
  assert.equal(
    resolvePredicate({ any: [false, { not: true }] }, ctx).result,
    false,
  );
  assert.equal(resolvePredicate({ not: { not: true } }, ctx).result, true);
});

test("missing step outputs resolve to null instead of throwing", () => {
  const outcome = resolvePredicate(
    { left: "${steps.never_ran.outputs.bytes}", op: "gt", right: 0 },
    context(),
  );
  assert.equal(outcome.result, false);
  assert.equal(
    outcome.reason,
    "predicate_false",
    "must not surface as invalid",
  );
});

test("a malformed predicate resolves false rather than crashing the run", () => {
  const outcome = resolvePredicate(
    { nonsense: true } as unknown as WorkflowDecisionPredicate,
    context(),
  );
  assert.equal(outcome.result, false);
  assert.equal(outcome.reason, "predicate_invalid");
});

test("workflow input bindings resolve", () => {
  const outcome = resolvePredicate(
    { left: "${workflow.input.tier}", op: "eq", right: "premium" },
    context({ workflowInputs: { tier: "premium" } }),
  );
  assert.equal(outcome.result, true);
});
