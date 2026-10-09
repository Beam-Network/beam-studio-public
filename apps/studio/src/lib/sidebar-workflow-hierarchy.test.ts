import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canNestWorkflow,
  emptyWorkflowHierarchy,
  parseWorkflowCollapse,
  workflowParents,
  workflowTreeRows,
} from "./sidebar-workflow-hierarchy";

const workflows = [
  { id: "parent", name: "Transfers" },
  { id: "child", name: "Europe replication" },
  { id: "grandchild", name: "Archive" },
  { id: "other", name: "Reports" },
];
const ids = new Set(workflows.map((workflow) => workflow.id));
const hierarchy = {
  ...emptyWorkflowHierarchy(),
  parents: { child: "parent", grandchild: "child" },
};

test("nested workflows preserve order and collapse whole subtrees", () => {
  assert.deepEqual(
    workflowTreeRows(workflows, hierarchy, "").map(({ workflow, depth }) => [
      workflow.id,
      depth,
    ]),
    [
      ["parent", 0],
      ["child", 1],
      ["grandchild", 2],
      ["other", 0],
    ],
  );
  assert.deepEqual(
    workflowTreeRows(
      workflows,
      { ...hierarchy, collapsed: ["parent"] },
      "",
    ).map(({ workflow }) => workflow.id),
    ["parent", "other"],
  );
});

test("moves reject self, descendants, unknown workflows and corrupt ancestor cycles", () => {
  assert.equal(
    canNestWorkflow(ids, hierarchy.parents, "parent", "grandchild"),
    false,
  );
  assert.equal(
    canNestWorkflow(ids, hierarchy.parents, "child", "child"),
    false,
  );
  assert.equal(
    canNestWorkflow(ids, hierarchy.parents, "child", "missing"),
    false,
  );
  assert.equal(canNestWorkflow(ids, hierarchy.parents, "missing", null), false);
  assert.equal(
    canNestWorkflow(
      ids,
      { child: "grandchild", grandchild: "child" },
      "other",
      "child",
    ),
    false,
  );
  assert.equal(canNestWorkflow(ids, hierarchy.parents, "child", "other"), true);
  assert.equal(canNestWorkflow(ids, hierarchy.parents, "child", null), true);
});

test("moving a subtree to root retains its descendants", () => {
  assert.deepEqual(
    workflowTreeRows(
      workflows,
      { ...hierarchy, parents: { grandchild: "child" } },
      "",
    ).map(({ workflow, depth }) => [workflow.id, depth]),
    [
      ["parent", 0],
      ["child", 0],
      ["grandchild", 1],
      ["other", 0],
    ],
  );
});

test("search reveals ancestors and children inside collapsed folders", () => {
  const collapsed = { ...hierarchy, collapsed: ["parent", "child"] };
  assert.deepEqual(
    workflowTreeRows(workflows, collapsed, "archive").map(
      ({ workflow }) => workflow.id,
    ),
    ["parent", "child", "grandchild"],
  );
  assert.deepEqual(
    workflowTreeRows(workflows, collapsed, "transfers").map(
      ({ workflow }) => workflow.id,
    ),
    ["parent", "child", "grandchild"],
  );
  assert.deepEqual(workflowTreeRows(workflows, collapsed, "missing"), []);
});

test("deleted or inaccessible parents and corrupt cycles never hide workflows", () => {
  const broken = {
    ...hierarchy,
    parents: { parent: "child", child: "parent", grandchild: "deleted" },
  };
  const rows = workflowTreeRows(workflows, broken, "");
  assert.equal(rows.length, workflows.length);
  assert.equal(
    new Set(rows.map(({ workflow }) => workflow.id)).size,
    workflows.length,
  );
  assert.equal(workflowParents(ids, broken.parents).grandchild, undefined);
});

test("collapse preference parses safely and never supplies parent relationships", () => {
  assert.deepEqual(parseWorkflowCollapse('["parent",42,"child"]'), [
    "parent",
    "child",
  ]);
  for (const value of [
    null,
    "{broken",
    "null",
    "[]",
    JSON.stringify(hierarchy),
  ])
    assert.deepEqual(parseWorkflowCollapse(value), []);
});
