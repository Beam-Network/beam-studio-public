import assert from "node:assert/strict";
import test from "node:test";
import {
  firstActionTriggerConnection,
  nextNodePosition,
} from "./workflow-action-placement";
import { createNode, createTrigger } from "./workflow-graph-model";
import type { ActionPackage } from "./workflow-graph-types";

const action: ActionPackage = {
  id: "wait",
  name: "@beam/wait",
  version: "1.0.0",
  checksum: "",
  manifest: { inputs: {}, outputs: {} },
};

test("a new node goes after the right-most node, on its row", () => {
  const trigger = createTrigger("manual", 0);
  assert.deepEqual(nextNodePosition([trigger]), {
    x: trigger.position.x + 340,
    y: trigger.position.y,
  });
  assert.equal(nextNodePosition([]), null);
});

test("the first action connects to the only trigger", () => {
  const trigger = createTrigger("manual", 0);
  const first = createNode(action, 1, "action");
  const plan = firstActionTriggerConnection({
    nodes: [trigger],
    edges: [],
    action: first,
  });
  assert.ok(plan);
  assert.equal(plan.visualEdges.length, 1);
  assert.equal(plan.visualEdges[0]?.source, trigger.id);
  assert.equal(plan.visualEdges[0]?.target, first.id);
});

test("later actions and several triggers are left for the customer to wire", () => {
  const trigger = createTrigger("manual", 0);
  const existing = createNode(action, 1, "action");
  assert.equal(
    firstActionTriggerConnection({
      nodes: [trigger, existing],
      edges: [],
      action: createNode(action, 2, "action"),
    }),
    null,
  );
  assert.equal(
    firstActionTriggerConnection({
      nodes: [trigger, createTrigger("schedule", 1)],
      edges: [],
      action: createNode(action, 2, "action"),
    }),
    null,
  );
});
