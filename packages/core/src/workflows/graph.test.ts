import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LocalActionRegistry,
  WorkflowValidationError,
  runGraphWorkflow,
  validateGraphWorkflow,
  type ActionJson,
  type ActionManifest,
  type WorkflowGraphRunSnapshot,
} from "../index.js";
import { memoryStore } from "./test-helpers.js";

const manifest = {
  name: "@beam/graph",
  version: "1.0.0",
  apiVersion: "workflow-actions/v1",
  runtime: { placements: ["local-workers"] },
  inputs: {},
  outputs: {
    value: {},
    branch: {},
  },
} satisfies ActionManifest;

test("runs graph fan-out and fan-in with skipped conditional branches", async () => {
  const registry = new LocalActionRegistry();
  registry.registerPackage({
    source: "builtin",
    manifest,
    execute: ({ inputs, config }) => ({
      outputs: {
        value: inputs.value ?? config.value ?? null,
        branch: inputs.branch ?? config.branch ?? null,
      },
    }),
  });
  const store = memoryStore();

  await runGraphWorkflow(
    {
      workflowRunId: "wfr_graph",
      templateId: "wft_graph",
      graphVersion: "workflow-graph/v1",
      templateSnapshot: {},
      runtimeInputs: { useLeft: true },
      steps: [
        step("start", 0, { value: "root" }),
        step("left", 1, { value: "${steps.start.outputs.value}", branch: "left" }),
        step("right", 2, { value: "unused", branch: "right" }),
        step("join", 3, { value: "${steps.left.outputs.branch}" }),
      ],
      edges: [
        { from: "start", to: "left", condition: "${workflow.input.useLeft} == true" },
        { from: "start", to: "right", condition: "${workflow.input.useLeft} == false" },
        { from: "left", to: "join" },
        { from: "right", to: "join" },
      ],
    },
    { registry, store, graphConcurrency: 2 },
  );

  assert.equal(store.workflowStatus, "completed");
  assert.equal(store.statuses.get("right"), "skipped");
  assert.equal(store.statuses.get("join"), "completed");
  assert.deepEqual(store.stepOutputs.get("join"), { value: "left", branch: null });
});

test("rejects workflow graph cycles", () => {
  assert.throws(
    () =>
      validateGraphWorkflow({
        workflowRunId: "wfr_cycle",
        templateId: "wft_cycle",
        graphVersion: "workflow-graph/v1",
        templateSnapshot: {},
        runtimeInputs: {},
        steps: [step("a", 0, {}), step("b", 1, {})],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      }),
    WorkflowValidationError,
  );
});

function step(
  id: string,
  position: number,
  inputBindings: Record<string, ActionJson>,
): WorkflowGraphRunSnapshot["steps"][number] {
  return {
    id,
    position,
    enabled: true,
    actionPackage: "@beam/graph",
    versionRange: "1.0.0",
    config: {},
    inputBindings,
  };
}
