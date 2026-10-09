import assert from "node:assert/strict";
import test from "node:test";
import { workflowLayoutPatchSchema } from "./workflow-layout.js";

test("layout contract rejects malformed, duplicate, non-finite and semantic fields", () => {
  const valid = { revision: 0, positions: [{ nodeId: "a", x: -3, y: 0 }] };
  assert.equal(workflowLayoutPatchSchema.safeParse(valid).success, true);
  for (const value of [
    { ...valid, revision: -1 },
    { ...valid, revision: 0.5 },
    { ...valid, positions: [valid.positions[0], valid.positions[0]] },
    { ...valid, positions: [{ nodeId: "a", x: Infinity, y: 0 }] },
    { ...valid, positions: [{ nodeId: "a", x: 1e100, y: 0 }] },
    { ...valid, positions: [{ nodeId: "a", x: 0, y: NaN }] },
    { ...valid, positions: [{ nodeId: "", x: 0, y: 0 }] },
    { ...valid, config: {} },
  ])
    assert.equal(workflowLayoutPatchSchema.safeParse(value).success, false);
});
