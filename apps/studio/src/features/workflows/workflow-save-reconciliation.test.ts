import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSaveResponse } from "./workflow-save-reconciliation.js";

const base = {
  requestId: 1,
  appliedRequestId: 0,
  requestSignature: "graph-a",
  currentSignature: "graph-a",
};

test("an untouched canvas takes the saved graph from the server", () => {
  assert.deepEqual(reconcileSaveResponse(base), {
    apply: true,
    preserveLocalEdits: false,
  });
});

test("an edit made while the save was in flight survives the response", () => {
  // The response describes what was sent. The canvas has moved on, so applying
  // it would silently drop the newer change.
  assert.deepEqual(
    reconcileSaveResponse({ ...base, currentSignature: "graph-b" }),
    { apply: true, preserveLocalEdits: true },
  );
});

test("a response overtaken by a newer save is ignored", () => {
  assert.deepEqual(
    reconcileSaveResponse({ ...base, requestId: 2, appliedRequestId: 3 }),
    { apply: false, preserveLocalEdits: false },
  );
});

test("overlapping saves settle on the newest response whatever the order", () => {
  // Two saves in flight; the second returns first, then the first returns.
  let applied = 0;
  const responses = [
    { requestId: 2, requestSignature: "graph-b" },
    { requestId: 1, requestSignature: "graph-a" },
  ];
  const outcomes = responses.map((response) => {
    const decision = reconcileSaveResponse({
      ...response,
      appliedRequestId: applied,
      currentSignature: "graph-b",
    });
    if (decision.apply) applied = response.requestId;
    return decision.apply;
  });

  assert.deepEqual(outcomes, [true, false], "the stale first save is dropped");
  assert.equal(applied, 2);
});

test("a save that completes after the canvas returns to the sent state applies", () => {
  // Edited then undone during the request: the signatures match again, so the
  // server graph is authoritative and history may reset.
  assert.deepEqual(
    reconcileSaveResponse({ ...base, requestId: 4, appliedRequestId: 3 }),
    { apply: true, preserveLocalEdits: false },
  );
});
