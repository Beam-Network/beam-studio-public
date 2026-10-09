import assert from "node:assert/strict";
import test from "node:test";
import {
  beamTransferFolderSources,
  beamTransferSourceEndpointIds,
  getCompositeEntryStepIds,
  getWorkflowEntryStepIds,
  normalizeWorkflowEdges,
  planWorkflowConnection,
  triggerTargetsForPresentationEdge,
  validateTriggerTargets,
  workflowNodeDefinition,
  type WorkflowSemanticEdge,
  type WorkflowSemanticGraph,
  type WorkflowSemanticNode,
} from "./graph-semantics.js";

const bindingExpression = (id: string) => `\${steps.${id}.outputs.endpoint}`;

function node(
  id: string,
  kind: "trigger" | "action" | "resource" | "composite" = "action",
  inputBindings: Record<string, unknown> = {},
): WorkflowSemanticNode {
  const actionPackageName =
    kind === "resource"
      ? "@beam/object-storage-endpoint"
      : kind === "composite"
        ? "@beam/transfer"
        : "@beam/test";
  return {
    id,
    enabled: true,
    actionPackageName,
    inputBindings,
    definition: workflowNodeDefinition({ kind, actionPackageName }),
  };
}

function connect(
  graph: WorkflowSemanticGraph,
  source: string,
  target: string,
  sourcePort?: string,
  targetPort?: string,
) {
  const plan = planWorkflowConnection({
    connection: { source, target, sourcePort, targetPort },
    nodes: graph.nodes,
    edges: graph.edges,
    createId: (prefix) => `${prefix}_${graph.edges.length + 1}`,
  });
  if (plan.accepted) {
    graph.edges.push(...plan.visualEdges);
    for (const binding of plan.bindingPatches) {
      const targetNode = graph.nodes.find(
        (candidate) => candidate.id === binding.targetNodeId,
      );
      if (!targetNode) continue;
      const expression = `\${steps.${binding.sourceNodeId}.outputs.${binding.sourceOutput}}`;
      const current = targetNode.inputBindings?.[binding.targetInput];
      targetNode.inputBindings = {
        ...targetNode.inputBindings,
        [binding.targetInput]:
          binding.mode === "append"
            ? [
                ...(Array.isArray(current)
                  ? current
                  : current
                    ? [current]
                    : []),
                expression,
              ]
            : expression,
      };
    }
  }
  return plan;
}

function compositeGraph(sourceCount = 0, destinationCount = 0) {
  const nodes = [node("trigger", "trigger"), node("transfer", "composite")];
  const graph: WorkflowSemanticGraph = { nodes, edges: [] };
  for (let index = 0; index < sourceCount; index += 1) {
    const resource = node(`source_${index}`, "resource");
    graph.nodes.push(resource);
    assert.equal(
      connect(
        graph,
        resource.id,
        "transfer",
        "resource-out",
        "source-endpoints",
      ).accepted,
      true,
    );
  }
  for (let index = 0; index < destinationCount; index += 1) {
    const resource = node(`destination_${index}`, "resource");
    graph.nodes.push(resource);
    assert.equal(
      connect(
        graph,
        "transfer",
        resource.id,
        "destination-endpoints",
        "resource-in",
      ).accepted,
      true,
    );
  }
  return graph;
}

test("trigger connects to a simple action", () => {
  const graph = {
    nodes: [node("trigger", "trigger"), node("action")],
    edges: [],
  };
  const plan = connect(graph, "trigger", "action");
  assert.equal(plan.accepted, true);
  assert.equal(plan.visualEdges[0]?.kind, "trigger");
  assert.deepEqual(
    plan.visualEdges[0]?.runtimeEdges.map((edge) => edge.target),
    ["action"],
  );
});

test("trigger connects to transfer without endpoints", () => {
  const graph = compositeGraph();
  const plan = connect(graph, "trigger", "transfer");
  assert.equal(plan.accepted, true);
  assert.deepEqual(
    plan.runtimeEdges[0]?.runtimeEdges.map((edge) => edge.target),
    ["transfer"],
  );
});

test("trigger drops on a composite satellite port normalize to workflow-in", () => {
  const graph = compositeGraph(1, 0);
  const plan = connect(
    graph,
    "trigger",
    "transfer",
    "trigger-out",
    "source-endpoints",
  );
  assert.equal(plan.accepted, true);
  assert.equal(plan.visualEdges[0]?.targetPort, "workflow-in");
});

for (const [label, sources, destinations] of [
  ["one source", 1, 0],
  ["one destination", 0, 1],
  ["many sources and destinations", 2, 3],
] as const) {
  test(`trigger connects to transfer with ${label}`, () => {
    const graph = compositeGraph(sources, destinations);
    const entries = getCompositeEntryStepIds("transfer", graph).sort();
    const plan = connect(graph, "trigger", "transfer");
    assert.equal(plan.accepted, true);
    assert.deepEqual(
      plan.runtimeEdges[0]?.runtimeEdges.map((edge) => edge.target).sort(),
      entries,
    );
    assert.equal(entries.includes("transfer"), false);
  });
}

test("a trigger connected before endpoints is reprojected when endpoints are added", () => {
  const graph = compositeGraph();
  const triggerEdge = connect(graph, "trigger", "transfer").visualEdges[0];
  assert.ok(triggerEdge);
  const source = node("source", "resource");
  graph.nodes.push(source);
  connect(graph, "source", "transfer", "resource-out", "source-endpoints");
  assert.deepEqual(triggerTargetsForPresentationEdge(triggerEdge, graph), [
    "source",
  ]);
});

test("a trigger connected after endpoints targets their runtime entries", () => {
  const graph = compositeGraph(1, 1);
  const triggerEdge = connect(graph, "trigger", "transfer").visualEdges[0];
  assert.ok(triggerEdge);
  assert.deepEqual(
    triggerTargetsForPresentationEdge(triggerEdge, graph).sort(),
    ["destination_0", "source_0"],
  );
});

test("removing an endpoint does not remove the trigger connection", () => {
  const graph = compositeGraph(2, 0);
  const triggerEdge = connect(graph, "trigger", "transfer").visualEdges[0];
  graph.nodes = graph.nodes.filter((candidate) => candidate.id !== "source_0");
  graph.edges = graph.edges.filter(
    (edge) => edge.membership?.memberNodeId !== "source_0",
  );
  assert.ok(graph.edges.some((edge) => edge.id === triggerEdge?.id));
  assert.deepEqual(triggerTargetsForPresentationEdge(triggerEdge!, graph), [
    "source_1",
  ]);
});

test("save then rehydrate reconstructs one visual composite trigger edge", () => {
  const graph = compositeGraph(2, 2);
  const triggerEdge = connect(graph, "trigger", "transfer").visualEdges[0]!;
  const targets = triggerTargetsForPresentationEdge(triggerEdge, graph);
  const persistedEdges = graph.edges
    .filter((edge) => edge.kind !== "trigger")
    .flatMap((edge) =>
      edge.runtimeEdges.map((runtime) => ({
        id: runtime.id,
        fromStepId: runtime.source,
        toStepId: runtime.target,
      })),
    );
  const rehydrated = normalizeWorkflowEdges({
    nodes: graph.nodes,
    edges: persistedEdges,
    triggerEdges: targets.map((target, index) => ({
      id: index ? `${triggerEdge.id}__${target}` : triggerEdge.id,
      triggerId: "trigger",
      toStepId: target,
    })),
  });
  const triggers = rehydrated.filter((edge) => edge.kind === "trigger");
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]?.visualTarget, "transfer");
  assert.equal(triggers[0]?.runtimeEdges.length, 4);
});

test("runtime trigger projection targets real entry steps", () => {
  const graph = compositeGraph(1, 1);
  const triggerEdge = connect(graph, "trigger", "transfer").visualEdges[0]!;
  const entries = new Set(getWorkflowEntryStepIds(graph));
  for (const target of triggerTargetsForPresentationEdge(triggerEdge, graph)) {
    assert.equal(entries.has(target), true);
  }
});

test("an incompatible connection is rejected with an explicit reason", () => {
  const graph = {
    nodes: [node("trigger", "trigger"), node("resource", "resource")],
    edges: [],
  };
  const plan = connect(graph, "trigger", "resource");
  assert.equal(plan.accepted, false);
  assert.match(plan.reason ?? "", /cannot|port|accept/i);
});

test("a single-cardinality resource input rejects a second connection", () => {
  const graph = compositeGraph(0, 0);
  graph.nodes.push(
    node("transfer_2", "composite"),
    node("destination", "resource"),
  );
  assert.equal(
    connect(
      graph,
      "transfer",
      "destination",
      "destination-endpoints",
      "resource-in",
    ).accepted,
    true,
  );
  const second = connect(
    graph,
    "transfer_2",
    "destination",
    "destination-endpoints",
    "resource-in",
  );
  assert.equal(second.accepted, false);
  assert.match(second.reason ?? "", /one connection/i);
});

test("endpoint ports accept multiple resources", () => {
  const graph = compositeGraph(3, 3);
  assert.equal(getCompositeEntryStepIds("transfer", graph).length, 6);
});

test("resource connections produce automatic binding patches", () => {
  const graph = compositeGraph();
  graph.nodes.push(node("source", "resource"));
  const plan = connect(
    graph,
    "source",
    "transfer",
    "resource-out",
    "source-endpoints",
  );
  assert.deepEqual(plan.bindingPatches, [
    {
      sourceNodeId: "source",
      sourceOutput: "endpoint",
      targetNodeId: "transfer",
      targetInput: "sourceEndpoints",
      mode: "append",
    },
  ]);
});

test("duplicate edges are rejected", () => {
  const graph = compositeGraph(1, 0);
  const duplicate = planWorkflowConnection({
    connection: {
      source: "source_0",
      target: "transfer",
      sourcePort: "resource-out",
      targetPort: "source-endpoints",
    },
    nodes: graph.nodes,
    edges: graph.edges,
  });
  assert.equal(duplicate.accepted, false);
  assert.match(duplicate.reason ?? "", /already exists/i);
});

test("root calculation and trigger validation use identical shared semantics", () => {
  const graph = compositeGraph(1, 1);
  const roots = getWorkflowEntryStepIds(graph).sort();
  const errors = validateTriggerTargets({
    graph,
    triggerEdges: roots.map((toStepId) => ({ triggerId: "trigger", toStepId })),
  });
  assert.deepEqual(errors, []);
  assert.equal(
    validateTriggerTargets({
      graph,
      triggerEdges: [{ triggerId: "trigger", toStepId: "transfer" }],
    }).length,
    1,
  );
});

test("existing runtime workflows normalize without presentation metadata", () => {
  const nodes = [node("first"), node("second")];
  const edges = normalizeWorkflowEdges({
    nodes,
    edges: [{ id: "legacy", fromStepId: "first", toStepId: "second" }],
  });
  assert.equal(edges[0]?.kind, "flow");
  assert.equal(edges[0]?.runtimeEdges[0]?.dependency, true);
  assert.deepEqual(getWorkflowEntryStepIds({ nodes, edges }), ["first"]);
});

test("two persistence round trips keep a stable composite projection", () => {
  const graph = compositeGraph(2, 1);
  const trigger = connect(graph, "trigger", "transfer").visualEdges[0]!;
  const persist = (current: WorkflowSemanticGraph) => ({
    edges: current.edges
      .filter((edge) => edge.kind !== "trigger")
      .flatMap((edge) =>
        edge.runtimeEdges.map((runtime) => ({
          id: runtime.id,
          fromStepId: runtime.source,
          toStepId: runtime.target,
        })),
      ),
    triggerEdges: triggerTargetsForPresentationEdge(
      current.edges.find((edge) => edge.kind === "trigger")!,
      current,
    ).map((toStepId, index) => ({
      id: index ? `${trigger.id}__${toStepId}` : trigger.id,
      triggerId: "trigger",
      toStepId,
    })),
  });
  const firstPayload = persist(graph);
  const firstGraph = {
    nodes: graph.nodes,
    edges: normalizeWorkflowEdges({ nodes: graph.nodes, ...firstPayload }),
  };
  const secondPayload = persist(firstGraph);
  assert.deepEqual(secondPayload, firstPayload);
});

test("destination bindings are normalized as reversed visual edges with runtime dependency", () => {
  const resource = node("destination", "resource");
  const transfer = node("transfer", "composite", {
    destinationEndpoints: [bindingExpression("destination")],
  });
  const edges = normalizeWorkflowEdges({
    nodes: [resource, transfer],
    edges: [{ id: "edge", fromStepId: "destination", toStepId: "transfer" }],
  });
  assert.equal(edges[0]?.visualSource, "transfer");
  assert.equal(edges[0]?.visualTarget, "destination");
  assert.equal(edges[0]?.runtimeEdges[0]?.source, "destination");
  assert.equal(edges[0]?.runtimeEdges[0]?.target, "transfer");
});

test("upload destination direction also comes from the shared port definition", () => {
  const resource = node("destination", "resource");
  const upload: WorkflowSemanticNode = {
    ...node("upload"),
    actionPackageName: "@beam/upload",
    inputBindings: { endpoint: bindingExpression("destination") },
    definition: workflowNodeDefinition({ actionPackageName: "@beam/upload" }),
  };
  const edge = normalizeWorkflowEdges({
    nodes: [resource, upload],
    edges: [
      { id: "upload-edge", fromStepId: "destination", toStepId: "upload" },
    ],
  })[0];
  assert.equal(edge?.visualSource, "upload");
  assert.equal(edge?.visualTarget, "destination");
  assert.equal(edge?.runtimeEdges[0]?.source, "destination");
  assert.equal(edge?.runtimeEdges[0]?.target, "upload");
});

function endpointStep(id: string, objectKey: string, sourceType = "file") {
  return {
    id,
    actionPackageName: "@beam/object-storage-endpoint",
    config: { bucket: "bucket", objectKey, sourceType },
    inputBindings: {},
  };
}

function transferStep(sources: unknown, destinations: unknown) {
  return {
    id: "transfer",
    actionPackageName: "@beam/transfer",
    config: {},
    inputBindings: {
      sourceEndpoints: sources,
      destinationEndpoints: destinations,
    },
  };
}

test("beam transfer sources are read from the transfer's source bindings", () => {
  const steps = [
    endpointStep("source", "model.bin"),
    endpointStep("destination", "out/", "directory"),
    transferStep(
      [bindingExpression("source")],
      [bindingExpression("destination")],
    ),
  ];
  assert.deepEqual([...beamTransferSourceEndpointIds(steps)], ["source"]);
  assert.deepEqual(
    [...beamTransferSourceEndpointIds([transferStep(bindingExpression("source"), [])])],
    ["source"],
  );
});

test("a folder bound as a beam transfer source is reported", () => {
  const byType = endpointStep("by_type", "shards/", "directory");
  const byKey = endpointStep("by_key", "shards/");
  const steps = [
    byType,
    byKey,
    endpointStep("file", "model.bin"),
    transferStep(
      [
        bindingExpression("by_type"),
        bindingExpression("by_key"),
        bindingExpression("file"),
      ],
      [],
    ),
  ];
  assert.deepEqual(beamTransferFolderSources(steps), [byType, byKey]);
});

test("a folder destination is not a beam transfer source issue", () => {
  const steps = [
    endpointStep("source", "model.bin"),
    endpointStep("destination", "out/", "directory"),
    transferStep(
      [bindingExpression("source")],
      [bindingExpression("destination")],
    ),
  ];
  assert.deepEqual(beamTransferFolderSources(steps), []);
});
