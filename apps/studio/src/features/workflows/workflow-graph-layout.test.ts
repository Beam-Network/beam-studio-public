import assert from "node:assert/strict";
import test from "node:test";
import type { Edge, Node } from "@xyflow/react";
import { createNode, createDecisionNode } from "./workflow-graph-model";
import {
  DECISION_TRUE_PORT,
  DECISION_FALSE_PORT,
} from "@beam-studio/core/workflows/graph-semantics";
import {
  workflowDecisionOutputY,
  WORKFLOW_NODE_HANDLE_Y,
} from "./workflow-node-geometry";
import {
  autoLayoutGraph,
  createLinearTemplateGraph,
} from "./workflow-graph-operations";
import type {
  ActionPackage,
  WorkflowCanvasNodeData,
} from "./workflow-graph-types";

const action: ActionPackage = {
  id: "wait",
  name: "@beam/wait",
  version: "1.0.0",
  checksum: "",
  manifest: { inputs: {}, outputs: {} },
};

function card(id: string, order: number, height = 100, width = 292) {
  return {
    ...createNode(action, order, "action"),
    id,
    measured: { width, height },
  };
}

function edge(source: string, target: string): Edge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    data: { edgeKind: "flow" },
  };
}

function positions(nodes: Node<WorkflowCanvasNodeData>[]) {
  return Object.fromEntries(nodes.map((node) => [node.id, node.position]));
}

test("layout aligns trigger and card handles despite different measured heights", () => {
  const graph = createLinearTemplateGraph([action], [action.name, action.name]);
  const measured = graph.nodes.map((node, index) => ({
    ...node,
    measured: { width: index === 0 ? 248 : 292, height: [72, 190, 74][index]! },
  }));
  const nodes = autoLayoutGraph(measured, graph.edges);
  assert.equal(nodes[0]!.position.y, nodes[1]!.position.y);
  assert.equal(nodes[1]!.position.y, nodes[2]!.position.y);
  assert.deepEqual(
    positions(autoLayoutGraph(nodes, graph.edges)),
    positions(nodes),
  );
  for (const node of nodes) {
    assert.ok("canvasX" in node.data && "canvasY" in node.data);
    assert.equal(node.data.canvasX, node.position.x);
    assert.equal(node.data.canvasY, node.position.y);
    assert.ok(node.position.y >= 120);
  }
});

for (const sourceHandle of [DECISION_TRUE_PORT, DECISION_FALSE_PORT]) {
  test(`layout follows the actual ${sourceHandle} decision output`, () => {
    const source = card("source", 0);
    const decision = createDecisionNode(1);
    const target = card("target", 2);
    const edges = [
      edge(source.id, decision.id),
      {
        ...edge(decision.id, target.id),
        sourceHandle,
      },
    ];
    const result = positions(
      autoLayoutGraph([source, decision, target], edges),
    );
    assert.equal(result[source.id]!.y, result[decision.id]!.y);
    assert.equal(
      result[decision.id]!.y +
        workflowDecisionOutputY(decision.data, sourceHandle),
      result[target.id]!.y + WORKFLOW_NODE_HANDLE_Y,
    );
  });
}

test("forks spread around their parent and joins return to the same line", () => {
  const nodes = [
    card("start", 0),
    card("upper", 1),
    card("lower", 2),
    card("join", 3),
  ];
  const edges = [
    edge("start", "upper"),
    edge("start", "lower"),
    edge("upper", "join"),
    edge("lower", "join"),
  ];
  const result = positions(autoLayoutGraph(nodes, edges));
  assert.equal(result.start!.y, (result.upper!.y + result.lower!.y) / 2);
  assert.equal(result.join!.y, result.start!.y);
  assert.ok(result.lower!.y >= result.upper!.y + 100 + 80);
  assert.ok(result.start!.x < result.upper!.x);
  assert.ok(result.upper!.x < result.join!.x);
});

test("independent chains keep their lanes when card heights differ", () => {
  const nodes = [
    card("a", 0, 320),
    card("b", 1, 80),
    card("a-next", 2, 80),
    card("b-next", 3, 180),
  ];
  const edges = [edge("a", "a-next"), edge("b", "b-next")];
  const result = positions(autoLayoutGraph(nodes, edges));
  assert.equal(result.a!.y, result["a-next"]!.y);
  assert.equal(result.b!.y, result["b-next"]!.y);
  assert.ok(result.b!.y >= result.a!.y + 320 + 80);
});

test("large measured cards reserve enough space in both directions", () => {
  const nodes = [
    card("root", 0, 100, 600),
    card("tall", 1, 500),
    card("short", 2, 74),
  ];
  const edges = [edge("root", "tall"), edge("root", "short")];
  const result = positions(autoLayoutGraph(nodes, edges));
  assert.ok(result.tall!.x >= result.root!.x + 600 + 112);
  assert.ok(result.short!.y >= result.tall!.y + 500 + 80);
  assert.ok(result.tall!.y >= 120);
});

test("layout tolerates empty graphs and cyclic imported connections", () => {
  assert.deepEqual(autoLayoutGraph([], []), []);
  const nodes = [card("a", 0), card("b", 1)];
  const edges = [edge("a", "b"), edge("b", "a"), edge("a", "missing")];
  const arranged = autoLayoutGraph(nodes, edges);
  assert.equal(arranged.length, 2);
  assert.ok(
    arranged.every(
      (node) =>
        Number.isFinite(node.position.x) && Number.isFinite(node.position.y),
    ),
  );
  assert.deepEqual(
    positions(autoLayoutGraph(arranged, edges)),
    positions(arranged),
  );
});
