import assert from "node:assert/strict";
import test from "node:test";
import type {
  ActionJson,
  WorkflowDecision,
  WorkflowDecisionEdge,
} from "@beam-studio/core";
import { decisionEdgeState, resolveDecisions } from "./decisions.js";

function decision(
  id: string,
  patch: Partial<WorkflowDecision> = {},
): WorkflowDecision {
  return {
    id,
    name: id,
    kind: "if",
    enabled: true,
    joinMode: "all",
    handleFailure: false,
    predicate: true,
    ...patch,
  };
}

function resolve(
  decisions: WorkflowDecision[],
  decisionEdges: WorkflowDecisionEdge[],
  statuses: Array<[string, string]> = [["source", "completed"]],
  outputs: Array<[string, Record<string, ActionJson>]> = [],
) {
  return resolveDecisions({
    decisions,
    decisionEdges,
    statusByNode: new Map(statuses),
    outputsByStep: new Map(outputs),
    runtimeInputs: {},
    templateSnapshot: {},
    terminalStatuses: new Set([
      "completed",
      "failed",
      "skipped",
      "not_reached",
    ]),
  });
}

const entry: WorkflowDecisionEdge = {
  id: "entry",
  fromStepId: "source",
  toDecisionId: "first",
};
const trueEdge: WorkflowDecisionEdge = {
  id: "true",
  fromDecisionId: "first",
  toDecisionId: "second",
  branch: "true",
};
const exit: WorkflowDecisionEdge = {
  id: "exit",
  fromDecisionId: "second",
  toStepId: "notify",
  branch: "false",
};

test("an untaken branch settles the entire decision chain without taking either output", () => {
  const chain: WorkflowDecisionEdge = {
    id: "chain",
    fromDecisionId: "second",
    toDecisionId: "third",
    branch: "false",
  };
  const result = resolve(
    [
      decision("third"),
      decision("second"),
      decision("first", { predicate: false }),
    ],
    [entry, trueEdge, chain, exit],
  );
  assert.equal(result.outcomes.get("first")?.branch, "false");
  for (const id of ["second", "third"]) {
    assert.equal(result.outcomes.get(id)?.evaluated, false);
    assert.equal(result.outcomes.get(id)?.branch, null);
  }
  assert.equal(decisionEdgeState(exit, result.outcomes), "not_taken");
  assert.equal(
    decisionEdgeState({ ...exit, branch: "true" }, result.outcomes),
    "not_taken",
  );
});

test("a taken false branch evaluates the next decision", () => {
  const result = resolve(
    [decision("second"), decision("first", { predicate: false })],
    [entry, { ...trueEdge, branch: "false" }],
  );
  assert.equal(result.outcomes.get("second")?.branch, "true");
});

test("pending decisions keep downstream waiting, while disabled ones settle as not reached", () => {
  const pending = resolve(
    [decision("first"), decision("second")],
    [entry, trueEdge],
    [["source", "running"]],
  );
  assert.equal(pending.outcomes.size, 0);
  assert.equal(decisionEdgeState(exit, pending.outcomes), "waiting");
  const disabled = resolve(
    [decision("first", { enabled: false }), decision("second")],
    [entry, trueEdge],
  );
  assert.equal(decisionEdgeState(exit, disabled.outcomes), "not_taken");
});

test("join modes account for each incoming branch, including two ports of the same decision", () => {
  const edges = [
    entry,
    trueEdge,
    { ...trueEdge, id: "false", branch: "false" as const },
  ];
  const all = resolve([decision("first"), decision("second")], edges);
  assert.equal(all.outcomes.get("second")?.evaluated, false);
  const any = resolve(
    [decision("first"), decision("second", { joinMode: "any_settled" })],
    edges,
  );
  assert.equal(any.outcomes.get("second")?.branch, "true");
});

test("an unreachable all join does not absorb failures, but a reachable any join can", () => {
  const edges = [
    entry,
    trueEdge,
    { id: "failure", fromStepId: "failed", toDecisionId: "second" },
  ];
  const statuses: Array<[string, string]> = [
    ["source", "completed"],
    ["failed", "failed"],
  ];
  const all = resolve(
    [
      decision("first", { predicate: false }),
      decision("second", { handleFailure: true }),
    ],
    edges,
    statuses,
  );
  assert.equal(all.outcomes.get("second")?.evaluated, false);
  assert.equal(all.handledFailures.size, 0);
  const any = resolve(
    [
      decision("first", { predicate: false }),
      decision("second", { joinMode: "any_settled", handleFailure: true }),
    ],
    edges,
    statuses,
  );
  assert.equal(any.outcomes.get("second")?.branch, "false");
  assert.deepEqual([...any.handledFailures], ["failed"]);
});

test("skipped steps cannot reactivate a decision behind an untaken branch", () => {
  const result = resolve(
    [decision("first", { handleFailure: true })],
    [entry],
    [["source", "skipped"]],
  );
  assert.equal(result.outcomes.get("first")?.evaluated, false);
  assert.equal(result.handledFailures.size, 0);
});

test("a failed step still takes the recovery branch and records its handled failure", () => {
  const result = resolve(
    [decision("first", { handleFailure: true })],
    [entry],
    [["source", "failed"]],
  );
  assert.equal(result.outcomes.get("first")?.branch, "false");
  assert.deepEqual([...result.handledFailures], ["source"]);
});

test("a Switch marks exactly one transfer branch as taken", () => {
  const gateway = decision("size", {
    kind: "switch",
    cases: [
      {
        id: "one_gib",
        name: "1 GiB",
        predicate: {
          left: "${steps.source.outputs.eligible}",
          op: "lte",
          right: 5,
        },
      },
      {
        id: "five_gib",
        name: "5 GiB",
        predicate: {
          left: "${steps.source.outputs.eligible}",
          op: "lte",
          right: 25,
        },
      },
      { id: "ten_gib", name: "10 GiB", predicate: true },
    ],
  });
  const edges: WorkflowDecisionEdge[] = [
    { id: "in", fromStepId: "source", toDecisionId: "size" },
    ...["one_gib", "five_gib", "ten_gib"].map((id) => ({
      id,
      fromDecisionId: "size",
      toStepId: `transfer_${id}`,
      branch: `case:${id}` as const,
    })),
    {
      id: "default",
      fromDecisionId: "size",
      toStepId: "no_transfer",
      branch: "default",
    },
  ];
  const result = resolve(
    [gateway],
    edges,
    [["source", "completed"]],
    [["source", { eligible: 6 }]],
  );
  assert.equal(result.outcomes.get("size")?.branch, "case:five_gib");
  assert.deepEqual(
    edges
      .filter((edge) => edge.fromDecisionId === "size")
      .map((edge) => decisionEdgeState(edge, result.outcomes)),
    ["not_taken", "taken", "not_taken", "not_taken"],
  );
});

test("a failed HTTP input takes only Switch Default and leaves the failure unhandled", () => {
  const gateway = decision("size", {
    kind: "switch",
    cases: [
      { id: "one_gib", name: "1 GiB", predicate: true },
      { id: "five_gib", name: "5 GiB", predicate: true },
      { id: "ten_gib", name: "10 GiB", predicate: true },
    ],
  });
  const edges: WorkflowDecisionEdge[] = [
    { id: "in", fromStepId: "http", toDecisionId: "size" },
    ...["one_gib", "five_gib", "ten_gib"].map((id) => ({
      id,
      fromDecisionId: "size",
      toStepId: `transfer_${id}`,
      branch: `case:${id}` as const,
    })),
    {
      id: "default",
      fromDecisionId: "size",
      toStepId: "no_transfer",
      branch: "default",
    },
  ];
  const result = resolve([gateway], edges, [["http", "failed"]]);
  assert.equal(result.outcomes.get("size")?.branch, "default");
  assert.deepEqual([...result.handledFailures], []);
  assert.deepEqual(
    edges
      .filter((edge) => edge.fromDecisionId === "size")
      .map((edge) => decisionEdgeState(edge, result.outcomes)),
    ["not_taken", "not_taken", "not_taken", "taken"],
  );
});
