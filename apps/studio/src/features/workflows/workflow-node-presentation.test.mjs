import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const actionNode = readFileSync(
  new URL("./workflow-step-node.tsx", import.meta.url),
  "utf8",
);
const nodeCard = readFileSync(
  new URL("./workflow-node-card.tsx", import.meta.url),
  "utf8",
);
const triggerNode = readFileSync(
  new URL("./workflow-trigger-node.tsx", import.meta.url),
  "utf8",
);
const controlNode = readFileSync(
  new URL("./workflow-control-node.tsx", import.meta.url),
  "utf8",
);
const graphModel = readFileSync(
  new URL("./workflow-graph-model.ts", import.meta.url),
  "utf8",
);
const graphEditor = readFileSync(
  new URL("./workflow-graph-editor.tsx", import.meta.url),
  "utf8",
);
const editorCanvas = readFileSync(
  new URL("./workflow-editor-canvas.tsx", import.meta.url),
  "utf8",
);
const triggerPicker = readFileSync(
  new URL("./workflow-trigger-picker-dialog.tsx", import.meta.url),
  "utf8",
);
const workflowOverview = readFileSync(
  new URL("./workflow-overview.tsx", import.meta.url),
  "utf8",
);
const graphBindings = readFileSync(
  new URL("./workflow-graph-bindings.ts", import.meta.url),
  "utf8",
);
const connectionPlanner = readFileSync(
  new URL("./workflow-connection-planner.ts", import.meta.url),
  "utf8",
);
const graphSemantics = readFileSync(
  new URL(
    "../../../../../packages/core/src/workflows/graph-semantics.ts",
    import.meta.url,
  ),
  "utf8",
);

test("action nodes expose a useful summary and plain-language status", () => {
  assert.match(actionNode, /stepSummary\(data\)/);
  assert.match(actionNode, /data\.credentialNatsUrl/);
  assert.match(nodeCard, /Needs attention/);
  assert.doesNotMatch(
    actionNode,
    /Runs locally|Runs on Beam|Runs on a custom worker|placementLabel/,
  );
  assert.match(actionNode, /Double-click to configure/);
});

test("trigger and control nodes explain what they do", () => {
  assert.match(triggerNode, /Starts when you press Run/);
  assert.match(triggerNode, /data\.name \|\| label/);
  assert.match(controlNode, /For each item/);
  assert.match(controlNode, /Continue after all items/);
  assert.match(controlNode, /Repeat \$\{control\.iterations\}/);
  assert.doesNotMatch(controlNode, /data\.controlId/);
});

test("connection handles stay quiet until the node is active", () => {
  for (const source of [actionNode, triggerNode, controlNode]) {
    assert.match(source, /group-hover:!opacity-100/);
    assert.doesNotMatch(source, /group-hover:!-?translate-[xy]/);
  }
  assert.match(graphModel, /isControlBodyEdge\s*\? "4 4"/);
});

test("steps can be chained without requiring a data binding", () => {
  assert.match(connectionPlanner, /planSemanticConnection\(/);
  assert.match(graphSemantics, /return "flow"/);
  assert.match(graphEditor, /\.\.\.plan\.visualEdges/);
  assert.match(editorCanvas, /connectionRadius=\{28\}/);
});

test("Beam transfer separates workflow and endpoint connections", () => {
  assert.match(actionNode, /portId\(data, "input", WORKFLOW_INPUT_HANDLE\)/);
  assert.match(actionNode, /portId\(data, "output", WORKFLOW_OUTPUT_HANDLE\)/);
  assert.match(actionNode, /BEAM_TRANSFER_SOURCE_HANDLE/);
  assert.match(actionNode, /BEAM_TRANSFER_DESTINATION_HANDLE/);
  assert.match(actionNode, /onQuickAddEndpoint\?\.\("source"\)/);
  assert.match(actionNode, /onQuickAddEndpoint\?\.\("destination"\)/);
  assert.match(graphEditor, /endpointDraftConnection/);
  assert.match(graphSemantics, /id: "source-endpoints"/);
  assert.match(graphSemantics, /id: "destination-endpoints"/);
  assert.match(graphSemantics, /membership:/);
});

test("triggers connect to the Beam transfer workflow input", () => {
  assert.match(
    graphEditor,
    /planWorkflowConnection\(\{ connection, nodes, edges \}\)/,
  );
  assert.match(graphSemantics, /getCompositeEntryStepIds\(target\.id, graph\)/);
  assert.match(graphModel, /triggerTargetsForPresentationEdge/);
  assert.doesNotMatch(connectionPlanner, /BEAM_TRANSFER_ACTION/);
});

test("schedule enablement is first-class in workflow editing surfaces", () => {
  assert.match(triggerPicker, /Trigger availability/);
  assert.match(
    triggerPicker,
    /Control whether this entry point can start workflow runs/,
  );
  assert.match(triggerPicker, /onEnabledChange/);
  assert.match(workflowOverview, /ScheduleControl/);
  assert.match(workflowOverview, /Enable schedule/);
  assert.match(workflowOverview, /Disable schedule/);
  assert.match(workflowOverview, /TriggerRowActions/);
  assert.match(editorCanvas, /Edit trigger/);
  assert.doesNotMatch(editorCanvas, /setTriggerPickerNodeId/);
});

test("saving the trigger editor persists the updated graph", () => {
  assert.match(graphEditor, /const applyTriggerEditorSubmit = useCallback/);
  assert.match(graphEditor, /const nextNodes = nodes\.map/);
  assert.match(graphEditor, /setNodes\(nextNodes\)/);
  assert.match(graphEditor, /saveMutation\.mutate\(/);
  assert.match(graphEditor, /toDraftPayload\(\s*nextNodes,\s*edges,/);
});

test("removing endpoint edges also removes their input bindings", () => {
  assert.match(graphBindings, /export function removeAutomaticBinding/);
  assert.match(graphEditor, /removeBindingsForEdges\(current, removedEdges\)/);
  assert.match(graphEditor, /removeAutomaticBinding\(/);
});
