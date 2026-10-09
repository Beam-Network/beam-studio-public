import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWorkflowEdges,
  validateTriggerTargets,
  workflowNodeDefinition,
} from "@beam-studio/core/workflows/graph-semantics";
import { isWorkflowTemplateId, workflowTemplateDraft } from "./workflow-creation";
import {
  presentationGraphFromWorkflowBundle,
  toSavePayload,
} from "./workflow-graph-model";
import type { WorkflowBundle } from "./workflow-graph-types";

// What Studio returns for a workflow it has just created: no steps, and the
// manual trigger every new workflow gets.
function newWorkflow(triggers = [defaultTrigger]) {
  return {
    template: { id: "wft_new", graphVersion: "workflow-graph/v1" },
    triggers,
    triggerEdges: [],
    steps: [],
    edges: [],
    runCount: 0,
  } as unknown as WorkflowBundle;
}

const defaultTrigger = {
  id: "wftg_default",
  workflowTemplateId: "wft_new",
  type: "manual",
  name: "Trigger manually",
  enabled: true,
  config: {},
  state: {},
  canvasX: -260,
  canvasY: 120,
};

function simpleTransferDraft(workflow = newWorkflow()) {
  const draft = workflowTemplateDraft(workflow, "simple-transfer");
  assert.ok(draft);
  return draft;
}

test("only known templates are accepted from the editor URL", () => {
  assert.equal(isWorkflowTemplateId("simple-transfer"), true);
  assert.equal(isWorkflowTemplateId("blank"), true);
  assert.equal(isWorkflowTemplateId("unknown"), false);
  assert.equal(isWorkflowTemplateId(null), false);
});

test("the blank canvas adds nothing to the new workflow", () => {
  assert.equal(workflowTemplateDraft(newWorkflow(), "blank"), null);
});

test("simple transfer starts from the workflow's own manual trigger", () => {
  const draft = simpleTransferDraft();
  assert.deepEqual(draft.triggers, [defaultTrigger]);

  const [source, destination, transfer] = draft.steps;
  assert.deepEqual(
    draft.triggerEdges.map((edge) => [edge.triggerId, edge.toStepId]),
    [
      [defaultTrigger.id, source?.id],
      [defaultTrigger.id, destination?.id],
    ],
  );
  assert.deepEqual(
    draft.edges.map((edge) => [edge.fromStepId, edge.toStepId]),
    [
      [source?.id, transfer?.id],
      [destination?.id, transfer?.id],
    ],
  );
  assert.deepEqual(transfer?.inputBindings, {
    destinationEndpoints: [`\${steps.${destination?.id}.outputs.endpoint}`],
    sourceEndpoints: [`\${steps.${source?.id}.outputs.endpoint}`],
  });
});

test("simple transfer names its steps as the editor names its own", () => {
  const [source, destination, transfer] = simpleTransferDraft().steps;
  // The endpoints the editor adds to a transfer are named this way.
  assert.equal(source?.config.name, "Source endpoint");
  assert.equal(destination?.config.name, "Destination endpoint");
  // An action the editor adds carries no name, so the canvas and the Name
  // field show the action's display name: Beam Transfer.
  assert.equal(transfer?.name, undefined);
  assert.equal(transfer?.config.name, undefined);
});

test("a workflow without a trigger gets an enabled manual one", () => {
  const draft = simpleTransferDraft(newWorkflow([]));
  assert.equal(draft.triggers.length, 1);
  assert.equal(draft.triggers[0]?.type, "manual");
  assert.equal(draft.triggers[0]?.enabled, true);
  assert.ok(
    draft.triggerEdges.every((edge) => edge.triggerId === draft.triggers[0]?.id),
  );
});

test("simple transfer passes the API's trigger-target rule", () => {
  const draft = simpleTransferDraft();
  const nodes = draft.steps.map((step) => ({
    id: step.id,
    enabled: step.enabled,
    actionPackageName: step.actionPackageName,
    inputBindings: step.inputBindings,
    definition: workflowNodeDefinition({
      actionPackageName: step.actionPackageName,
    }),
  }));
  const errors = validateTriggerTargets({
    graph: {
      nodes,
      edges: normalizeWorkflowEdges({ nodes, edges: draft.edges }),
    },
    triggerEdges: draft.triggerEdges,
    enabledTriggerIds: new Set(draft.triggers.map((trigger) => trigger.id)),
  });
  assert.deepEqual(errors, []);
});

test("every draft gets its own step and edge ids", () => {
  const ids = (draft: WorkflowBundle) => [
    ...draft.triggerEdges.map((edge) => edge.id),
    ...draft.steps.map((step) => step.id),
    ...draft.edges.map((edge) => edge.id),
  ];
  const first = ids(simpleTransferDraft());
  const second = ids(simpleTransferDraft());
  assert.equal(new Set(first).size, first.length);
  assert.equal(new Set([...first, ...second]).size, first.length * 2);
});

test("the editor renders the draft and saves it with its trigger", () => {
  const draft = simpleTransferDraft();
  const canvas = presentationGraphFromWorkflowBundle(draft, new Map());
  assert.deepEqual(
    canvas.nodes.map((node) => node.id).sort(),
    [defaultTrigger.id, ...draft.steps.map((step) => step.id)].sort(),
  );

  const saved = toSavePayload(canvas.nodes, canvas.edges);
  assert.deepEqual(
    saved.triggers.map((trigger) => trigger.id),
    [defaultTrigger.id],
  );
  assert.deepEqual(
    saved.triggerEdges.map((edge) => [edge.triggerId, edge.toStepId]).sort(),
    draft.triggerEdges.map((edge) => [edge.triggerId, edge.toStepId]).sort(),
  );
  assert.deepEqual(
    saved.edges.map((edge) => [edge.fromStepId, edge.toStepId]).sort(),
    draft.edges.map((edge) => [edge.fromStepId, edge.toStepId]).sort(),
  );
  const transfer = saved.steps.find(
    (step) => step.actionPackageName === "@beam/transfer",
  );
  assert.deepEqual(transfer?.inputBindings, draft.steps[2]?.inputBindings);
});
