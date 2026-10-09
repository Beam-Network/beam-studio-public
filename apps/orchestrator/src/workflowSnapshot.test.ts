import assert from "node:assert/strict";
import test from "node:test";
import { workflowGraphVersionFromSnapshot } from "./postgresOrchestration.js";

test("scheduled database snapshots preserve graph-v2 orchestration", () => {
  assert.equal(
    workflowGraphVersionFromSnapshot({
      workflowTemplate: { graph_version: "workflow-graph/v2" },
    }),
    "workflow-graph/v2",
  );
});

test("API snapshots and missing versions resolve deterministically", () => {
  assert.equal(
    workflowGraphVersionFromSnapshot({
      workflowTemplate: { graphVersion: "workflow-graph/v2" },
    }),
    "workflow-graph/v2",
  );
  assert.equal(
    workflowGraphVersionFromSnapshot({ graphVersion: "workflow-graph/v2" }),
    "workflow-graph/v2",
  );
  assert.equal(workflowGraphVersionFromSnapshot({}), "workflow-graph/v1");
  assert.equal(
    workflowGraphVersionFromSnapshot({ graphVersion: "workflow-graph/v3" }),
    "workflow-graph/v3",
  );
});
