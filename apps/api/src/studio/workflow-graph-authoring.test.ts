import assert from "node:assert/strict";
import test from "node:test";
import { saveWorkflowGraph } from "./workflow-graph-authoring.js";

test("Studio and MCP graph writes reject malformed collections before storage", async () => {
  for (const body of [
    { steps: "not-an-array", edges: [] },
    { steps: [], edges: {} },
    { steps: [], edges: [], controls: "invalid" },
    { steps: [], edges: [], triggerEdges: {} },
  ]) {
    await assert.rejects(
      saveWorkflowGraph({
        organizationId: "org",
        workflowTemplateId: "workflow",
        body,
      }),
      (error: unknown) =>
        (error as { code?: string; statusCode?: number }).code ===
          "workflow_graph_invalid" &&
        (error as { statusCode?: number }).statusCode === 400,
    );
  }
});
