import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvePredicate,
  type WorkflowDecisionPredicate,
} from "@beam-studio/core/workflows/decisions";
import {
  emptyGroup,
  parsePredicate,
  serializePredicate,
  type PredicateGroup,
} from "./workflow-predicate-model";

const comparison = {
  all: [{ left: "${steps.wfs_1.outputs.bytes}", op: "gt", right: 0 }],
};

test("an absent predicate opens an empty builder, not a broken one", () => {
  assert.deepEqual(parsePredicate(null), emptyGroup());
  assert.deepEqual(parsePredicate(undefined), emptyGroup());
});

test("a comparison round-trips unchanged", () => {
  const parsed = parsePredicate(comparison);
  assert.ok(parsed);
  assert.deepEqual(serializePredicate(parsed), comparison);
});

test("a step status operand is shown as the expression used everywhere else", () => {
  const parsed = parsePredicate({
    all: [
      {
        left: { step: "wfs_1", field: "status" },
        op: "eq",
        right: "completed",
      },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.entries.length, 1);
  const row = parsed.entries[0];
  assert.equal(row?.kind, "row");
  assert.equal(row.kind === "row" ? row.left : "", "${steps.wfs_1.status}");
});

test("numbers and booleans survive the text round-trip as JSON values", () => {
  const group: PredicateGroup = {
    kind: "group",
    mode: "all",
    entries: [
      { kind: "row", left: "${a}", operator: "gt", right: "10" },
      { kind: "row", left: "${b}", operator: "eq", right: "true" },
      { kind: "row", left: "${c}", operator: "eq", right: "null" },
      { kind: "row", left: "${d}", operator: "eq", right: "beam" },
    ],
  };
  assert.deepEqual(serializePredicate(group), {
    all: [
      { left: "${a}", op: "gt", right: 10 },
      { left: "${b}", op: "eq", right: true },
      { left: "${c}", op: "eq", right: null },
      { left: "${d}", op: "eq", right: "beam" },
    ],
  });
});

test("unary operators emit no right operand", () => {
  const group: PredicateGroup = {
    kind: "group",
    mode: "all",
    entries: [
      { kind: "row", left: "${a}", operator: "exists", right: "ignored" },
    ],
  };
  assert.deepEqual(serializePredicate(group), {
    all: [{ left: "${a}", op: "exists" }],
  });
});

test("none-of maps to the not/any shape in both directions", () => {
  const stored = { not: { any: [{ left: "${a}", op: "eq", right: "x" }] } };
  const parsed = parsePredicate(stored);
  assert.ok(parsed);
  assert.equal(parsed.mode, "none");
  assert.deepEqual(serializePredicate(parsed), stored);
});

test("nested groups round-trip", () => {
  const stored = {
    all: [
      { left: "${a}", op: "eq", right: "x" },
      { any: [{ left: "${b}", op: "eq", right: "y" }] },
    ],
  };
  const parsed = parsePredicate(stored);
  assert.ok(parsed);
  assert.deepEqual(serializePredicate(parsed), stored);
});

test("a bare comparison is wrapped so the builder always has a root group", () => {
  const parsed = parsePredicate({ left: "${a}", op: "eq", right: "x" });
  assert.ok(parsed);
  assert.equal(parsed.mode, "all");
  assert.equal(parsed.entries.length, 1);
});

test("an empty builder serialises to null rather than an empty group", () => {
  assert.equal(serializePredicate(emptyGroup()), null);
  assert.equal(
    serializePredicate({
      kind: "group",
      mode: "all",
      entries: [{ kind: "row", left: "  ", operator: "eq", right: "x" }],
    }),
    null,
    "a row with no left operand contributes nothing",
  );
});

test("a predicate the form cannot draw is refused, not rewritten", () => {
  // A bare boolean, an unknown operator, an unsupported not shape, and an
  // operand the form has no field for all fall back to JSON editing.
  assert.equal(parsePredicate(true), null);
  assert.equal(
    parsePredicate({ all: [{ left: "${a}", op: "matches", right: "x" }] }),
    null,
  );
  assert.equal(
    parsePredicate({ not: { left: "${a}", op: "eq", right: "x" } }),
    null,
  );
  assert.equal(
    parsePredicate({ all: [{ left: { step: "a", field: "name" }, op: "eq" }] }),
    null,
  );
  assert.equal(parsePredicate({ all: "not-an-array" }), null);
});

test("editing another row preserves literal types and predicate outcomes", () => {
  const context = {
    statusByNode: new Map<string, string>(),
    outputsByStep: new Map(),
    workflowInputs: {},
    workflowConfig: {},
  };
  for (const value of [
    null,
    "001",
    "true",
    "false",
    "null",
    "",
    "  ",
    '"quoted"',
    1e-8,
    1e21,
  ]) {
    const predicate: WorkflowDecisionPredicate = {
      all: [{ left: value, op: "eq", right: value }],
    };
    const group = parsePredicate(predicate);
    assert.ok(group);
    // Adding another condition causes all the existing rows to be serialized.
    group.entries.push({ kind: "row", left: "1", operator: "eq", right: "1" });
    const saved = serializePredicate(group) as {
      all: WorkflowDecisionPredicate[];
    };
    assert.deepEqual(saved.all[0], predicate.all[0]);
    assert.deepEqual(
      resolvePredicate(saved, context),
      resolvePredicate(predicate, context),
    );
  }
});

test("explicit empty groups stay in JSON mode, including nested groups", () => {
  for (const predicate of [
    { any: [] },
    { all: [] },
    { not: { any: [] } },
    { all: [{ any: [] }] },
  ]) {
    assert.equal(parsePredicate(predicate), null);
  }
});
