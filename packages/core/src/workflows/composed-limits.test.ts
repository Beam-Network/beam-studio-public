import assert from "node:assert/strict";
import test from "node:test";
import {
  assertComposedWorkflowLimits,
  type ComposedDefinitionShape,
} from "./composed-limits.js";
import { workflowGraphV2Limits, type WorkflowGraphV2Loop } from "./graph-v2.js";

const step = (id: string, child?: string) => ({
  id,
  enabled: true,
  calledWorkflowId: child,
});
const loop = (
  id: string,
  iterations: number | string,
): WorkflowGraphV2Loop => ({
  id: "loop",
  kind: "loop",
  iterations,
  body: { stepIds: [id], entryStepId: id, outputStepId: id, edges: [] },
});
test("composed loops multiply descendants and include call overhead", () => {
  const definitions = new Map<string, ComposedDefinitionShape>([
    [
      "parent",
      { steps: [step("invoke", "child")], controls: [loop("invoke", 100)] },
    ],
    ["child", { steps: [step("compute")], controls: [loop("compute", 1000)] }],
  ]);
  assert.throws(
    () => assertComposedWorkflowLimits("parent", definitions),
    /expansion limit/,
  );
  definitions.get("parent")!.controls = [loop("invoke", 99)];
  assert.equal(assertComposedWorkflowLimits("parent", definitions), 99099);
});
test("data-dependent fan-out uses the configured worst-case cardinality", () => {
  const definitions = new Map<string, ComposedDefinitionShape>([
    [
      "parent",
      {
        steps: [step("invoke", "child")],
        controls: [
          {
            id: "fan",
            kind: "fan-out",
            items: "${workflow.input.items}",
            fanInId: "join",
            body: {
              stepIds: ["invoke"],
              entryStepId: "invoke",
              outputStepId: "invoke",
              edges: [],
            },
          },
        ],
      },
    ],
    [
      "child",
      {
        steps: Array.from({ length: 9 }, (_, i) => step(`s${i}`)),
        controls: [],
      },
    ],
  ]);
  assert.equal(assertComposedWorkflowLimits("parent", definitions), 100000);
  definitions.get("child")!.steps.push(step("extra"));
  assert.throws(
    () => assertComposedWorkflowLimits("parent", definitions),
    /expansion limit/,
  );
});
test("shared references are counted per invocation and depth is checked on cached paths", () => {
  const definitions = new Map<string, ComposedDefinitionShape>([
    [
      "root",
      { steps: [step("short", "leaf"), step("long", "chain-0")], controls: [] },
    ],
    ["leaf", { steps: [step("compute")], controls: [] }],
  ]);
  for (let i = 0; i < 15; i++)
    definitions.set(`chain-${i}`, {
      steps: [step(`call-${i}`, i === 14 ? "leaf" : `chain-${i + 1}`)],
      controls: [],
    });
  assert.throws(
    () => assertComposedWorkflowLimits("root", definitions),
    /depth exceeds 16/,
  );
  definitions.get("root")!.steps = [
    step("a", "leaf"),
    step("b", "leaf"),
    { ...step("disabled", "leaf"), enabled: false },
  ];
  assert.equal(assertComposedWorkflowLimits("root", definitions), 4);
  definitions.get("leaf")!.steps = [step("cycle", "root")];
  assert.throws(
    () => assertComposedWorkflowLimits("root", definitions),
    /Recursive workflow call/,
  );
});
test("custom dynamic limits are respected for binding-driven loops", () => {
  const definitions = new Map<string, ComposedDefinitionShape>([
    [
      "root",
      {
        steps: [step("compute")],
        controls: [loop("compute", "${workflow.input.count}")],
      },
    ],
  ]);
  assert.equal(
    assertComposedWorkflowLimits("root", definitions, {
      ...workflowGraphV2Limits,
      maxLoopIterations: 7,
    }),
    7,
  );
});
