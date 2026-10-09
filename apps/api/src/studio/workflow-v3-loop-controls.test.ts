import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeWorkflowGraphControls } from "./store.js";

test("V3 authoring keeps initial and carried routes in the saved control", () => {
  const loop = {
    id: "ring", kind: "loop", iterations: 5,
    body: { stepIds: ["transform"], entryStepId: "transform",
      outputStepId: "transform", edges: [] },
    initial: { routes: [{ from: { stepId: "seed", port: "batch" },
      to: { stepId: "transform", port: "batch" }, association: "identity" }] },
    carry: { routes: [{ from: { stepId: "transform", port: "batch" },
      to: { stepId: "transform", port: "batch" },
      association: "ring-successor" }] },
  };
  const saved = sanitizeWorkflowGraphControls([loop], true);
  assert.deepEqual((saved[0] as typeof loop).initial, loop.initial);
  assert.deepEqual((saved[0] as typeof loop).carry, loop.carry);
  assert.equal((sanitizeWorkflowGraphControls([loop], false)[0] as typeof loop).carry,
    undefined);
});
