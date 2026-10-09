import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  completionTriggerMatches,
  extendCompletionLineage,
  failedRequiredArtifactSource,
  isSerializedScheduleRun,
} from "./postgresOrchestration.js";
import type { ApiWorkflowStep } from "./types.js";

test("failed producers block only required artifact consumers", () => {
  const statuses = new Map([
    ["producer", { status: "failed" }],
    ["independent", { status: "completed" }],
  ]);
  const step = {
    inputBindings: {
      payload: "${steps.producer.outputs.payload}",
      note: "${steps.independent.outputs.note}",
    },
    manifestSnapshot: {
      inputs: {
        payload: { type: "artifact", required: true },
      },
    },
  } as unknown as ApiWorkflowStep;
  assert.equal(failedRequiredArtifactSource(step, statuses), "producer");
  step.manifestSnapshot!.inputs!.payload!.required = false;
  assert.equal(failedRequiredArtifactSource(step, statuses), null);
  step.manifestSnapshot!.inputs!.payload!.required = true;
  step.inputBindings.payload = "${steps.independent.outputs.payload}";
  assert.equal(failedRequiredArtifactSource(step, statuses), null);
});

test("completion triggers match their source and selected terminal statuses", () => {
  const config = {
    sourceId: "wft_source",
    sourceKind: "workflow",
    statuses: ["completed"],
  };
  assert.equal(
    completionTriggerMatches(config, {
      sourceId: "wft_source",
      sourceKind: "workflow",
      status: "completed",
    }),
    true,
  );
  assert.equal(
    completionTriggerMatches(config, {
      sourceId: "wft_source",
      sourceKind: "workflow",
      status: "failed",
    }),
    false,
  );
});

test("completion trigger lineage prevents workflow cycles", () => {
  assert.deepEqual(extendCompletionLineage(["workflow:a"], "b"), [
    "workflow:a",
    "workflow:b",
  ]);
  assert.equal(
    extendCompletionLineage(["workflow:a", "workflow:b"], "a"),
    null,
  );
});

test("queue_new schedule runs are serialized while other runs start normally", () => {
  assert.equal(
    isSerializedScheduleRun({
      trigger: "schedule",
      trigger_event_json: { overlapPolicy: "queue_new" },
    }),
    true,
  );
  assert.equal(
    isSerializedScheduleRun({
      trigger: "schedule",
      trigger_event_json: { overlapPolicy: "allow_parallel" },
    }),
    false,
  );
  assert.equal(
    isSerializedScheduleRun({
      trigger: "manual",
      trigger_event_json: { overlapPolicy: "queue_new" },
    }),
    false,
  );
});
