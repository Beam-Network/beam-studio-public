import assert from "node:assert/strict";
import test from "node:test";
import { Position, type Edge, type Node } from "@xyflow/react";
import {
  switchCasePort,
  workflowSwitchNodeDefinition,
} from "@beam-studio/core/workflows/graph-semantics";
import { createNode, createSwitchNode } from "./workflow-graph-model";
import {
  layoutWorkflowWithElk,
  workflowLayoutNodeSize,
} from "./workflow-elk-layout";
import {
  workflowLayoutSignature,
  workflowRoutePath,
  type WorkflowLayoutResult,
} from "./workflow-layout-routing";
import type {
  ActionPackage,
  WorkflowCanvasNodeData,
} from "./workflow-graph-types";

function node(id: string, name = "@beam/wait", order = 0) {
  const action: ActionPackage = {
    id: name,
    name,
    version: "1.0.0",
    checksum: "",
    manifest: { inputs: {}, outputs: {} },
  };
  return {
    ...createNode(
      action,
      order,
      name.includes("endpoint") ? "endpoint" : "action",
    ),
    id,
  };
}
function flow(source: string, target: string): Edge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle: "workflow-out",
    targetHandle: "workflow-in",
    data: { edgeKind: "flow" },
  };
}

function complexGraph() {
  const choice = { ...createSwitchNode(0), id: "choice" };
  choice.data.cases = ["1", "5", "10"].map((id) => ({
    id,
    name: `${id} GiB`,
    predicate: false,
  }));
  choice.data.definition = workflowSwitchNodeDefinition(choice.data.cases);
  const nodes: Node<WorkflowCanvasNodeData>[] = [node("read"), choice];
  const edges = [flow("read", "choice")];
  for (const [index, id] of ["1", "5", "10"].entries()) {
    const transfer = node(`transfer-${id}`, "@beam/transfer", index);
    transfer.measured = { width: 292, height: 140 };
    const cleanup = node(`cleanup-${id}`, "@beam/wait", index);
    nodes.push(transfer, cleanup);
    edges.push(
      { ...flow("choice", transfer.id), sourceHandle: switchCasePort(id) },
      flow(transfer.id, cleanup.id),
    );
    for (const role of ["source", "destination"]) {
      const endpoint = node(`${role}-${id}`, "@beam/object-storage-endpoint");
      nodes.push(endpoint);
      edges.push({
        id: `${role}-binding-${id}`,
        source: role === "source" ? endpoint.id : transfer.id,
        target: role === "source" ? transfer.id : endpoint.id,
        sourceHandle:
          role === "source" ? "resource-out" : "destination-endpoints",
        targetHandle: role === "source" ? "source-endpoints" : "resource-in",
        data: {
          edgeKind: "binding",
          compositeNodeId: transfer.id,
          memberNodeId: endpoint.id,
          membershipRole: `${role}Endpoints`,
        },
      });
    }
  }
  return { nodes, edges };
}

function assertNoOverlaps(result: WorkflowLayoutResult) {
  for (const [index, a] of result.nodes.entries()) {
    for (const b of result.nodes.slice(index + 1)) {
      const sa = workflowLayoutNodeSize(a),
        sb = workflowLayoutNodeSize(b);
      const overlaps =
        a.position.x < b.position.x + sb.width &&
        b.position.x < a.position.x + sa.width &&
        a.position.y < b.position.y + sb.height &&
        b.position.y < a.position.y + sa.height;
      assert.ok(!overlaps, `${a.id} overlaps ${b.id}`);
    }
  }
}

function assertRoutesAvoidNodes(result: WorkflowLayoutResult) {
  for (const edge of result.edges) {
    const route = result.routes[edge.id];
    assert.ok(route, `Missing route for ${edge.id}`);
    for (let index = 1; index < route.length; index++) {
      const a = route[index - 1]!,
        b = route[index]!;
      assert.ok(a.x === b.x || a.y === b.y, `Diagonal route on ${edge.id}`);
      for (const node of result.nodes) {
        if (node.id === edge.source || node.id === edge.target) continue;
        const size = workflowLayoutNodeSize(node);
        const left = node.position.x,
          right = left + size.width,
          top = node.position.y,
          bottom = top + size.height;
        const crosses =
          a.x === b.x
            ? a.x > left &&
              a.x < right &&
              Math.max(a.y, b.y) > top &&
              Math.min(a.y, b.y) < bottom
            : a.y > top &&
              a.y < bottom &&
              Math.max(a.x, b.x) > left &&
              Math.min(a.x, b.x) < right;
        assert.ok(
          !crosses,
          `${edge.id} crosses ${node.id}: ${JSON.stringify({ a, b, left, right, top, bottom, route })}`,
        );
      }
    }
  }
}

test("ELK reserves resources and preserves Switch branch order in a complex workflow", async () => {
  const graph = complexGraph();
  const original = structuredClone(graph);
  const result = await layoutWorkflowWithElk(graph.nodes, graph.edges);
  assertNoOverlaps(result);
  assertRoutesAvoidNodes(result);
  assert.deepEqual(graph, original, "Layout must not mutate the current graph");
  const get = (id: string) => result.nodes.find((item) => item.id === id)!;
  assert.ok(get("transfer-1").position.y < get("transfer-5").position.y);
  assert.ok(get("transfer-5").position.y < get("transfer-10").position.y);
  for (const id of ["1", "5", "10"]) {
    assert.equal(
      get(`transfer-${id}`).position.y,
      get(`cleanup-${id}`).position.y,
    );
    assert.ok(
      get(`source-${id}`).position.y > get(`transfer-${id}`).position.y + 140,
    );
  }
  const repeated = await layoutWorkflowWithElk(result.nodes, result.edges);
  assert.deepEqual(
    repeated.nodes.map((item) => item.position),
    result.nodes.map((item) => item.position),
  );
  assert.deepEqual(repeated.routes, result.routes);
});

test("multiple resources with different sizes stay inside their transfer's reserved space", async () => {
  const graph = complexGraph();
  for (let index = 0; index < 4; index++) {
    const extra = node(`extra-${index}`, "@beam/object-storage-endpoint");
    extra.measured = { width: 260 + index * 30, height: 90 + index * 30 };
    graph.nodes.push(extra);
    graph.edges.push({
      id: `extra-edge-${index}`,
      source: extra.id,
      target: "transfer-5",
      sourceHandle: "resource-out",
      targetHandle: "source-endpoints",
      data: {
        edgeKind: "binding",
        compositeNodeId: "transfer-5",
        memberNodeId: extra.id,
        membershipRole: "sourceEndpoints",
      },
    });
  }
  const result = await layoutWorkflowWithElk(graph.nodes, graph.edges);
  assertNoOverlaps(result);
  assertRoutesAvoidNodes(result);
});

test("Switch lanes follow port order even when action order and IDs disagree", async () => {
  const graph = complexGraph();
  const choice = graph.nodes.find((item) => item.id === "choice")!;
  assert.equal(choice.data.nodeKind, "decision");
  if (choice.data.nodeKind !== "decision") return;
  choice.data.cases.reverse();
  const result = await layoutWorkflowWithElk(
    [...graph.nodes].reverse(),
    [...graph.edges].reverse(),
  );
  const y = (id: string) =>
    result.nodes.find((item) => item.id === `transfer-${id}`)!.position.y;
  assert.ok(y("10") < y("5") && y("5") < y("1"));
  assertNoOverlaps(result);
  assertRoutesAvoidNodes(result);
});

test("shared resources are not hidden inside either transfer", async () => {
  const graph = complexGraph();
  graph.edges.push({
    ...graph.edges.find((edge) => edge.id === "source-binding-1")!,
    id: "shared-source",
    target: "transfer-5",
    data: {
      edgeKind: "binding",
      compositeNodeId: "transfer-5",
      memberNodeId: "source-1",
      membershipRole: "sourceEndpoints",
    },
  });
  const result = await layoutWorkflowWithElk(graph.nodes, graph.edges);
  assertNoOverlaps(result);
  assertRoutesAvoidNodes(result);
});

test("measured ports remain the exact endpoints of orthogonal routes", async () => {
  const nodes = [node("a"), node("b")];
  const edges = [flow("a", "b")];
  const result = await layoutWorkflowWithElk(nodes, edges, {
    a: [
      {
        id: "workflow-out",
        type: "source",
        x: 298,
        y: 36,
        position: Position.Right,
      },
    ],
    b: [
      {
        id: "workflow-in",
        type: "target",
        x: -6,
        y: 36,
        position: Position.Left,
      },
    ],
  });
  const source = {
    x: result.nodes[0]!.position.x + 298,
    y: result.nodes[0]!.position.y + 36,
  };
  const target = {
    x: result.nodes[1]!.position.x - 6,
    y: result.nodes[1]!.position.y + 36,
  };
  assert.ok(workflowRoutePath(result.routes["a-b"]!, source, target));
  assert.equal(
    workflowRoutePath(result.routes["a-b"]!, source, {
      ...target,
      y: target.y + 24,
    }),
    null,
  );
});

test("empty, cyclic, disconnected graphs and missing references remain safe", async () => {
  assert.deepEqual(await layoutWorkflowWithElk([], []), {
    nodes: [],
    edges: [],
    routes: {},
  });
  const nodes = [node("a"), node("b"), node("detached")];
  const edges = [flow("a", "b"), flow("b", "a"), flow("a", "a")];
  const result = await layoutWorkflowWithElk(nodes, [
    ...edges,
    flow("a", "missing"),
  ]);
  assertNoOverlaps(result);
  assert.ok(
    result.nodes.every(
      (item) =>
        Number.isFinite(item.position.x) && Number.isFinite(item.position.y),
    ),
  );
  assert.equal(result.edges.length, 4);
  assert.ok(result.routes["a-a"]);
});

test("route signatures invalidate moves and connections but preserve selections", () => {
  const graph = complexGraph();
  const signature = workflowLayoutSignature(graph.nodes, graph.edges);
  assert.equal(
    workflowLayoutSignature(
      graph.nodes.map((item) => ({ ...item, selected: true })),
      graph.edges,
    ),
    signature,
  );
  const moved = graph.nodes.map((item) => ({
    ...item,
    position: { x: item.position.x + 24, y: item.position.y },
  }));
  assert.notEqual(workflowLayoutSignature(moved, graph.edges), signature);
  assert.notEqual(
    workflowLayoutSignature(graph.nodes, graph.edges.slice(1)),
    signature,
  );
  assert.notEqual(
    workflowLayoutSignature(
      graph.nodes.map((item) => ({
        ...item,
        measured: { width: 500, height: 500 },
      })),
      graph.edges,
    ),
    signature,
  );
});
