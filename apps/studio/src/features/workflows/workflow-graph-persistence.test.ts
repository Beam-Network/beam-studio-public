import assert from "node:assert/strict";
import test from "node:test";
import {
  isTriggerEdge,
  toDraftPayload,
  presentationGraphFromWorkflowBundle,
  repairMissingWorkflowGraphReferences,
  workflowPayloadFromPresentationGraph,
} from "./workflow-graph-model";
import { validateGraph } from "./workflow-graph-validation";
import { autoLayoutGraph } from "./workflow-graph-operations";
import type {
  ActionPackage,
  WorkflowBundle,
  WorkflowStep,
} from "./workflow-graph-types";

const sourceBinding = "${steps.source.outputs.endpoint}";
const destinationBinding = "${steps.destination.outputs.endpoint}";

function action(name: string): ActionPackage {
  return {
    id: `action:${name}`,
    name,
    version: "1.0.0",
    checksum: `checksum:${name}`,
    manifest: {
      name,
      displayName: name === "@beam/transfer" ? "Transfer" : "Endpoint",
      inputs: {},
      outputs: { endpoint: { type: "object" } },
    },
  };
}

function step(
  id: string,
  actionPackageName: string,
  position: number,
  inputBindings: Record<string, unknown> = {},
): WorkflowStep {
  return {
    id,
    actionPackageName,
    actionVersionRange: "^1.0.0",
    position,
    enabled: true,
    config: {},
    inputBindings,
    placement: "local-workers",
    executionLocationId: null,
    canvasX: position * 120,
    canvasY: position * 40,
    timeoutSeconds: null,
    required: true,
    manifest: null,
  };
}

function bundle(): WorkflowBundle {
  const steps = [
    step("source", "@beam/object-storage-endpoint", 0),
    step("destination", "@beam/object-storage-endpoint", 1),
    step("transfer", "@beam/transfer", 2, {
      sourceEndpoints: [sourceBinding],
      destinationEndpoints: [destinationBinding],
    }),
  ];
  return {
    template: {
      inputSchema: { type: "object" },
      output: { schema: { type: "object" }, bindings: {} },
      failurePolicy: "stop_on_failure",
      id: "workflow",
      name: "Composite workflow",
      description: null,
      apiKeyId: null,
      enabled: true,
      graphVersion: "workflow-graph/v1",
      graph: {},
    },
    graph: {
      version: "workflow-graph/v1",
      controls: [],
      edges: [
        { id: "source-edge", from: "source", to: "transfer" },
        { id: "destination-edge", from: "destination", to: "transfer" },
      ],
    },
    controls: [],
    triggers: [
      {
        id: "trigger",
        workflowTemplateId: "workflow",
        type: "manual",
        name: "Manual",
        enabled: true,
        config: {},
        state: {},
        canvasX: -200,
        canvasY: 80,
      },
    ],
    triggerEdges: [
      {
        id: "trigger-source",
        workflowTemplateId: "workflow",
        triggerId: "trigger",
        toStepId: "source",
        condition: null,
      },
      {
        id: "trigger-destination",
        workflowTemplateId: "workflow",
        triggerId: "trigger",
        toStepId: "destination",
        condition: null,
      },
    ],
    steps,
    actionLocks: [],
    edges: [
      {
        id: "source-edge",
        fromStepId: "source",
        toStepId: "transfer",
        condition: null,
      },
      {
        id: "destination-edge",
        fromStepId: "destination",
        toStepId: "transfer",
        condition: null,
      },
    ],
    runCount: 0,
  };
}

const actionsByName = new Map(
  [action("@beam/transfer"), action("@beam/object-storage-endpoint")].map(
    (item) => [item.name, item],
  ),
);

test("bundle hydration projects resources around one transfer composite", () => {
  const graph = presentationGraphFromWorkflowBundle(bundle(), actionsByName);
  assert.equal(
    graph.nodes.find((node) => node.id === "source")?.data.workflowNodeKind,
    "resource",
  );
  assert.equal(
    graph.nodes.find((node) => node.id === "transfer")?.data.workflowNodeKind,
    "composite",
  );
  const triggerEdges = graph.edges.filter(isTriggerEdge);
  assert.equal(triggerEdges.length, 1);
  assert.equal(triggerEdges[0]?.target, "transfer");
  assert.equal(
    Array.isArray(triggerEdges[0]?.data?.runtimeEdges)
      ? triggerEdges[0].data.runtimeEdges.length
      : 0,
    2,
  );
});

test("a Switch renders a transfer branch with attached resources and no binding issues", () => {
  const workflow = bundle();
  const pool = step("pool", "@beam/wait", 3);
  const noTransfer = step("no-transfer", "@beam/wait", 4);
  const transfer = workflow.steps.find((item) => item.id === "transfer")!;
  transfer.config = { credentialId: "beam-credential" };
  workflow.steps.push(pool, noTransfer);
  workflow.triggerEdges = [
    {
      id: "trigger-pool",
      workflowTemplateId: "workflow",
      triggerId: "trigger",
      toStepId: pool.id,
      condition: null,
    },
  ];
  workflow.decisions = [
    {
      id: "dec-size",
      name: "Choose transfer size",
      kind: "switch",
      enabled: true,
      joinMode: "all",
      handleFailure: false,
      config: {
        cases: [{ id: "five-gib", name: "5 GiB", predicate: true }],
      },
      canvasX: 480,
      canvasY: 120,
    },
  ];
  workflow.decisionEdges = [
    {
      id: "pool-to-size",
      fromStepId: pool.id,
      fromDecisionId: null,
      toStepId: null,
      toDecisionId: "dec-size",
      branch: null,
    },
    {
      id: "size-to-transfer",
      fromStepId: null,
      fromDecisionId: "dec-size",
      toStepId: transfer.id,
      toDecisionId: null,
      branch: "case:five-gib",
    },
    {
      id: "size-default",
      fromStepId: null,
      fromDecisionId: "dec-size",
      toStepId: noTransfer.id,
      toDecisionId: null,
      branch: "default",
    },
  ];

  const graph = presentationGraphFromWorkflowBundle(
    workflow,
    new Map([...actionsByName, ["@beam/wait", action("@beam/wait")]]),
  );
  const validation = validateGraph(
    graph.nodes,
    graph.edges,
    new Map([...actionsByName, ["@beam/wait", action("@beam/wait")]]),
  );

  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.nodeIssues.get(transfer.id), undefined);
  assert.ok(
    graph.edges.some(
      (edge) => edge.source === "dec-size" && edge.target === transfer.id,
    ),
    "the Switch case connects visibly to the transfer composite",
  );
  assert.ok(
    graph.edges.some(
      (edge) => edge.source === "source" && edge.target === transfer.id,
    ),
    "the source resource attaches to the transfer",
  );
  assert.ok(
    graph.edges.some(
      (edge) => edge.source === transfer.id && edge.target === "destination",
    ),
    "the destination resource attaches to the transfer",
  );
});

test("save projects the visual composite trigger to persistent entry steps", () => {
  const graph = presentationGraphFromWorkflowBundle(bundle(), actionsByName);
  const payload = workflowPayloadFromPresentationGraph(
    graph.nodes,
    graph.edges,
  );
  assert.deepEqual(payload.triggerEdges.map((edge) => edge.toStepId).sort(), [
    "destination",
    "source",
  ]);
  assert.deepEqual(
    payload.steps.find((item) => item.id === "transfer")?.inputBindings,
    bundle().steps.find((item) => item.id === "transfer")?.inputBindings,
  );
  assert.equal(payload.steps.find((item) => item.id === "source")?.canvasX, 0);
});

test("repair removes only graph references whose nodes are missing", () => {
  const invalid = bundle();
  invalid.steps = invalid.steps.filter((item) => item.id !== "source");

  const repair = repairMissingWorkflowGraphReferences(invalid);

  assert.equal(repair.removedReferenceCount, 2);
  assert.deepEqual(
    repair.payload.edges.map((edge) => edge.id),
    ["destination-edge"],
  );
  assert.deepEqual(
    repair.payload.triggerEdges.map((edge) => edge.id),
    ["trigger-destination"],
  );
  assert.deepEqual(
    repair.payload.steps.map((item) => item.id),
    ["destination", "transfer"],
  );
});

test("removing one endpoint preserves and reprojects the trigger edge", () => {
  const graph = presentationGraphFromWorkflowBundle(bundle(), actionsByName);
  graph.nodes = graph.nodes.filter((node) => node.id !== "source");
  graph.edges = graph.edges.filter(
    (edge) =>
      isTriggerEdge(edge) ||
      (edge.source !== "source" && edge.target !== "source"),
  );
  const triggerEdge = graph.edges.find(isTriggerEdge);
  assert.equal(triggerEdge?.target, "transfer");
  const transfer = graph.nodes.find((node) => node.id === "transfer");
  if (transfer && transfer.data.nodeKind === "step") {
    transfer.data.inputBindings = {
      destinationEndpoints: [destinationBinding],
    };
  }
  const payload = workflowPayloadFromPresentationGraph(
    graph.nodes,
    graph.edges,
  );
  assert.deepEqual(
    payload.triggerEdges.map((edge) => edge.toStepId),
    ["destination"],
  );
});

test("two load-save round trips produce a stable payload", () => {
  const firstGraph = presentationGraphFromWorkflowBundle(
    bundle(),
    actionsByName,
  );
  const first = workflowPayloadFromPresentationGraph(
    firstGraph.nodes,
    firstGraph.edges,
  );
  const secondBundle = bundle();
  secondBundle.steps = first.steps.map((item) => ({ ...item, manifest: null }));
  secondBundle.edges = first.edges;
  secondBundle.triggerEdges = first.triggerEdges.map((edge) => ({
    ...edge,
    workflowTemplateId: "workflow",
  }));
  const secondGraph = presentationGraphFromWorkflowBundle(
    secondBundle,
    actionsByName,
  );
  const second = workflowPayloadFromPresentationGraph(
    secondGraph.nodes,
    secondGraph.edges,
  );
  assert.deepEqual(second, first);
});

test("auto layout keeps the trigger on the composite backbone", () => {
  const graph = presentationGraphFromWorkflowBundle(bundle(), actionsByName);
  const nodes = autoLayoutGraph(graph.nodes, graph.edges);
  const trigger = nodes.find((node) => node.id === "trigger");
  const transfer = nodes.find((node) => node.id === "transfer");
  const source = nodes.find((node) => node.id === "source");
  const destination = nodes.find((node) => node.id === "destination");

  assert.ok(trigger && transfer && source && destination);
  assert.ok(trigger.position.x < transfer.position.x);
  assert.equal(trigger.position.y, transfer.position.y);
  assert.ok(source.position.x < transfer.position.x);
  assert.ok(destination.position.x > transfer.position.x);
  assert.ok(source.position.y > transfer.position.y + 162);
  assert.ok(destination.position.y > transfer.position.y + 162);
});

test("auto layout stacks multiple resources in stable satellite lanes", () => {
  const workflow = bundle();
  workflow.steps.splice(
    1,
    0,
    step("source-2", "@beam/object-storage-endpoint", 1),
  );
  workflow.steps.splice(
    3,
    0,
    step("destination-2", "@beam/object-storage-endpoint", 3),
  );
  const transfer = workflow.steps.find((item) => item.id === "transfer");
  assert.ok(transfer);
  transfer.position = 4;
  transfer.inputBindings = {
    sourceEndpoints: [sourceBinding, "${steps.source-2.outputs.endpoint}"],
    destinationEndpoints: [
      destinationBinding,
      "${steps.destination-2.outputs.endpoint}",
    ],
  };
  for (const id of ["source-2", "destination-2"]) {
    workflow.edges.push({
      id: `${id}-edge`,
      fromStepId: id,
      toStepId: "transfer",
      condition: null,
    });
    workflow.graph.edges.push({
      id: `${id}-edge`,
      from: id,
      to: "transfer",
    });
    workflow.triggerEdges.push({
      id: `trigger-${id}`,
      workflowTemplateId: "workflow",
      triggerId: "trigger",
      toStepId: id,
      condition: null,
    });
  }

  const graph = presentationGraphFromWorkflowBundle(workflow, actionsByName);
  const nodes = autoLayoutGraph(graph.nodes, graph.edges);
  const sourcePositions = ["source", "source-2"].map(
    (id) => nodes.find((node) => node.id === id)?.position,
  );
  const destinationPositions = ["destination", "destination-2"].map(
    (id) => nodes.find((node) => node.id === id)?.position,
  );

  assert.ok(sourcePositions.every(Boolean));
  assert.ok(destinationPositions.every(Boolean));
  assert.equal(sourcePositions[0]?.x, sourcePositions[1]?.x);
  assert.equal(destinationPositions[0]?.x, destinationPositions[1]?.x);
  assert.notEqual(sourcePositions[0]?.y, sourcePositions[1]?.y);
  assert.notEqual(destinationPositions[0]?.y, destinationPositions[1]?.y);
});

test("a decision and its branches survive save and reload", () => {
  const actionsByName = new Map([
    ["@beam/transfer", action("@beam/transfer")],
    ["@beam/object-storage-endpoint", action("@beam/object-storage-endpoint")],
  ]);
  const source = bundle();
  const withDecision: WorkflowBundle = {
    ...source,
    steps: [...source.steps, step("recover", "@beam/transfer", 3)],
    decisions: [
      {
        id: "dec_1",
        name: "Transfer finished",
        kind: "if",
        enabled: true,
        joinMode: "all",
        handleFailure: true,
        config: {
          predicate: {
            left: { step: "transfer", field: "status" },
            op: "eq",
            right: "completed",
          },
        },
        canvasX: 640,
        canvasY: 120,
      },
    ],
    decisionEdges: [
      {
        id: "de_in",
        fromStepId: "transfer",
        fromDecisionId: null,
        toStepId: null,
        toDecisionId: "dec_1",
        branch: null,
      },
      {
        id: "de_true",
        fromStepId: null,
        fromDecisionId: "dec_1",
        toStepId: "recover",
        toDecisionId: null,
        branch: "true",
      },
      {
        id: "de_false",
        fromStepId: null,
        fromDecisionId: "dec_1",
        toStepId: "recover",
        toDecisionId: null,
        branch: "false",
      },
    ],
  };

  const graph = presentationGraphFromWorkflowBundle(
    withDecision,
    actionsByName,
  );
  const decisionNode = graph.nodes.find((node) => node.id === "dec_1");
  assert.ok(decisionNode, "the decision is rendered on the canvas");
  assert.equal(decisionNode?.type, "workflowDecision");

  const payload = workflowPayloadFromPresentationGraph(
    graph.nodes,
    graph.edges,
  );

  assert.equal(payload.decisions.length, 1);
  assert.deepEqual(
    {
      id: payload.decisions[0]?.id,
      joinMode: payload.decisions[0]?.joinMode,
      handleFailure: payload.decisions[0]?.handleFailure,
    },
    { id: "dec_1", joinMode: "all", handleFailure: true },
  );
  assert.deepEqual(
    payload.decisions[0]?.config,
    {
      predicate: {
        left: { step: "transfer", field: "status" },
        op: "eq",
        right: "completed",
      },
    },
    "the predicate round-trips unchanged",
  );

  const branches = payload.decisionEdges
    .map((edge) => `${edge.fromStepId ?? edge.fromDecisionId}->${edge.branch}`)
    .sort();
  assert.deepEqual(
    branches,
    ["dec_1->false", "dec_1->true", "transfer->null"],
    "each branch keeps the handle it left by",
  );

  assert.equal(
    payload.graphVersion,
    "workflow-graph/v2",
    "a decision forces v2 so the dynamic engine resolves it",
  );
  assert.ok(
    payload.edges.every(
      (edge) => edge.fromStepId !== "dec_1" && edge.toStepId !== "dec_1",
    ),
    "decision edges never leak into the step edge table",
  );
});

test("an ordered Switch and all stable output ids survive save and reload", () => {
  const source = bundle();
  const switched: WorkflowBundle = {
    ...source,
    steps: [...source.steps, step("selected", "@beam/transfer", 3)],
    decisions: [
      {
        id: "dec_size",
        name: "Choose calibration size",
        kind: "switch",
        enabled: true,
        joinMode: "all",
        handleFailure: false,
        config: {
          cases: [
            {
              id: "one_gib",
              name: "1 GiB",
              predicate: {
                left: "${steps.pool.outputs.body.pools.qualifying.eligible}",
                op: "lte",
                right: 5,
              },
            },
            {
              id: "five_gib",
              name: "5 GiB",
              predicate: {
                left: "${steps.pool.outputs.body.pools.qualifying.eligible}",
                op: "lte",
                right: 25,
              },
            },
            { id: "ten_gib", name: "10 GiB", predicate: true },
          ],
        },
        canvasX: 640,
        canvasY: 120,
      },
    ],
    decisionEdges: [
      {
        id: "de_in",
        fromStepId: "transfer",
        fromDecisionId: null,
        toStepId: null,
        toDecisionId: "dec_size",
        branch: null,
      },
      ...["one_gib", "five_gib", "ten_gib"].map((caseId) => ({
        id: `de_${caseId}`,
        fromStepId: null,
        fromDecisionId: "dec_size",
        toStepId: "selected",
        toDecisionId: null,
        branch: `case:${caseId}` as const,
      })),
      {
        id: "de_default",
        fromStepId: null,
        fromDecisionId: "dec_size",
        toStepId: "selected",
        toDecisionId: null,
        branch: "default",
      },
    ],
  };

  const graph = presentationGraphFromWorkflowBundle(switched, actionsByName);
  const payload = toDraftPayload(graph.nodes, graph.edges);
  assert.equal(payload.decisions[0]?.kind, "switch");
  assert.deepEqual(
    payload.decisions[0]?.config,
    switched.decisions?.[0]?.config,
  );
  assert.deepEqual(
    payload.decisionEdges
      .filter((edge) => edge.fromDecisionId === "dec_size")
      .map((edge) => edge.branch)
      .sort(),
    ["case:five_gib", "case:one_gib", "case:ten_gib", "default"],
  );

  const reloaded = presentationGraphFromWorkflowBundle(
    {
      ...switched,
      decisions: payload.decisions.map((entry) => ({
        ...entry,
        canvasX: entry.canvasX,
        canvasY: entry.canvasY,
      })),
      decisionEdges: payload.decisionEdges.map((entry) => ({ ...entry })),
    },
    actionsByName,
  );
  assert.deepEqual(toDraftPayload(reloaded.nodes, reloaded.edges), payload);
});

test("disabling a trigger target preserves the editor draft and can be undone", () => {
  const workflow = bundle();
  workflow.steps = [step("entry", "@beam/wait", 0)];
  workflow.edges = [];
  workflow.graph.edges = [];
  workflow.triggerEdges = [
    {
      id: "trigger-entry",
      workflowTemplateId: "workflow",
      triggerId: "trigger",
      toStepId: "entry",
      condition: null,
    },
  ];
  const graph = presentationGraphFromWorkflowBundle(
    workflow,
    new Map([["@beam/wait", action("@beam/wait")]]),
  );
  const before = workflowPayloadFromPresentationGraph(graph.nodes, graph.edges);
  const entry = graph.nodes.find((node) => node.id === "entry");
  assert.ok(entry && entry.data.nodeKind === "step");
  entry.data.enabled = false;
  const validation = validateGraph(
    graph.nodes,
    graph.edges,
    new Map([["@beam/wait", action("@beam/wait")]]),
  );
  assert.ok(
    validation.errors.some((issue) => issue.includes("disabled action")),
  );
  assert.ok(
    validation.nodeIssues
      .get("entry")
      ?.some((issue) => issue.includes("reconnect the trigger")),
  );
  const draft = toDraftPayload(graph.nodes, graph.edges);
  assert.equal(draft.steps[0]?.enabled, false);
  assert.deepEqual(draft.triggerEdges, before.triggerEdges);
  assert.notEqual(JSON.stringify(draft), JSON.stringify(before));
  assert.throws(
    () => workflowPayloadFromPresentationGraph(graph.nodes, graph.edges),
    /disabled action entry/,
  );
  entry.data.enabled = true;
  assert.deepEqual(
    workflowPayloadFromPresentationGraph(graph.nodes, graph.edges),
    before,
  );
});

test("a composite with no enabled members retains trigger links in its draft", () => {
  const graph = presentationGraphFromWorkflowBundle(bundle(), actionsByName);
  for (const node of graph.nodes) {
    if (node.data.nodeKind === "step") node.data.enabled = false;
  }
  const draft = toDraftPayload(graph.nodes, graph.edges);
  assert.deepEqual(draft.triggerEdges.map((edge) => edge.toStepId).sort(), [
    "destination",
    "source",
  ]);
  assert.throws(
    () => workflowPayloadFromPresentationGraph(graph.nodes, graph.edges),
    /cannot be projected/,
  );
});

test("invalid entry dependencies remain editable without weakening strict validation", () => {
  const workflow = bundle();
  workflow.steps = [
    step("upstream", "@beam/wait", 0),
    step("entry", "@beam/wait", 1),
  ];
  workflow.edges = [
    {
      id: "dependency",
      fromStepId: "upstream",
      toStepId: "entry",
      condition: null,
    },
  ];
  workflow.graph.edges = [{ id: "dependency", from: "upstream", to: "entry" }];
  workflow.triggerEdges = [
    {
      id: "trigger-entry",
      workflowTemplateId: "workflow",
      triggerId: "trigger",
      toStepId: "entry",
      condition: null,
    },
  ];
  const graph = presentationGraphFromWorkflowBundle(
    workflow,
    new Map([["@beam/wait", action("@beam/wait")]]),
  );
  const draft = toDraftPayload(graph.nodes, graph.edges);
  assert.equal(draft.triggerEdges[0]?.toStepId, "entry");
  assert.throws(
    () => workflowPayloadFromPresentationGraph(graph.nodes, graph.edges),
    /not a runtime entry step/,
  );
});
