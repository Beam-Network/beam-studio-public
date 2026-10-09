import assert from "node:assert/strict";
import test from "node:test";
import {
  DECISION_FALSE_PORT,
  DECISION_TRUE_PORT,
} from "@beam-studio/core/workflows/graph-semantics";
import {
  createDecisionNode,
  createNode,
  isDecisionNode,
  isStepNode,
  toSavePayload,
} from "./workflow-graph-model";
import {
  autoLayoutGraph,
  duplicateDecisionNode,
} from "./workflow-graph-operations";
import {
  createWorkflowGraphClipboardPayload,
  materializeWorkflowGraphClipboardPayload,
  parseWorkflowGraphClipboardPayload,
} from "./workflow-graph-clipboard";
import type { ActionPackage } from "./workflow-graph-types";
import type { Edge } from "@xyflow/react";

const action: ActionPackage = {
  id: "wait",
  name: "@beam/wait",
  version: "1.0.0",
  checksum: "",
  manifest: { inputs: {}, outputs: {} },
};

function graph() {
  const source = createNode(action, 0, "action");
  const decision = createDecisionNode(0, { x: 9999, y: 9999 });
  const yes = createNode(action, 1, "action");
  const no = createNode(action, 2, "action");
  const next = createDecisionNode(1);
  decision.data.predicate = {
    left: { step: source.id, field: "status" },
    op: "eq",
    right: "completed",
  };
  next.data.predicate = {
    left: `\${decisions.${decision.id}.branch}`,
    op: "eq",
    right: "false",
  };
  no.data.inputBindings = {
    message: `\${steps.${source.id}.status}: \${decisions.${decision.id}.branch}`,
  };
  const nodes = [source, decision, yes, no, next];
  const edges: Edge[] = [
    { id: "input", source: source.id, target: decision.id },
    {
      id: "true",
      source: decision.id,
      target: yes.id,
      sourceHandle: DECISION_TRUE_PORT,
    },
    {
      id: "false",
      source: decision.id,
      target: no.id,
      sourceHandle: DECISION_FALSE_PORT,
    },
    {
      id: "chain",
      source: decision.id,
      target: next.id,
      sourceHandle: DECISION_FALSE_PORT,
    },
  ].map((edge) => ({
    ...edge,
    targetHandle: "workflow-in",
    data: { edgeKind: "flow" },
  }));
  return { source, decision, yes, no, next, nodes, edges };
}

test("copying a decision produces a pasteable payload", () => {
  const { decision } = graph();
  const payload = createWorkflowGraphClipboardPayload({
    nodes: [decision],
    edges: [],
    selectedNodeIds: new Set([decision.id]),
    workflowId: "original",
  });
  assert.ok(parseWorkflowGraphClipboardPayload(JSON.stringify(payload)));
  const pasted = materializeWorkflowGraphClipboardPayload({
    payload,
    actionsByName: new Map(),
    existingNodeCount: 0,
    offset: 48,
    targetWorkflowId: "original",
  });
  assert.equal(pasted.nodes.length, 1);
  assert.ok(isDecisionNode(pasted.nodes[0]!));
  assert.notEqual(pasted.nodes[0]!.id, decision.id);
  assert.deepEqual(pasted.nodes[0]!.data.predicate, decision.data.predicate);
});

test("copying a decision flow preserves ports and remaps predicates and metadata bindings", () => {
  const original = graph();
  const payload = createWorkflowGraphClipboardPayload({
    ...original,
    selectedNodeIds: new Set(original.nodes.map((node) => node.id)),
    workflowId: "original",
  });
  const parsed = parseWorkflowGraphClipboardPayload(JSON.stringify(payload));
  assert.ok(parsed);
  const pasted = materializeWorkflowGraphClipboardPayload({
    payload: parsed,
    actionsByName: new Map([[action.name, action]]),
    existingNodeCount: 0,
    offset: 48,
    targetWorkflowId: "other",
  });
  const [source, decision, yes, no, next] = pasted.nodes;
  assert.ok(source && decision && yes && no && next);
  assert.ok(isDecisionNode(decision) && isDecisionNode(next) && isStepNode(no));
  assert.deepEqual(decision.data.predicate, {
    left: { step: source.id, field: "status" },
    op: "eq",
    right: "completed",
  });
  assert.deepEqual(next.data.predicate, {
    left: `\${decisions.${decision.id}.branch}`,
    op: "eq",
    right: "false",
  });
  assert.equal(
    no.data.inputBindings.message,
    `\${steps.${source.id}.status}: \${decisions.${decision.id}.branch}`,
  );
  const saved = toSavePayload(pasted.nodes, pasted.edges);
  assert.equal(saved.decisions.length, 2);
  assert.equal(saved.decisionEdges.length, 4);
  assert.equal(
    saved.decisionEdges.find((edge) => edge.toStepId === yes.id)?.branch,
    "true",
  );
  assert.equal(
    saved.decisionEdges.find((edge) => edge.toStepId === no.id)?.branch,
    "false",
  );
  assert.equal(
    saved.decisionEdges.find((edge) => edge.toDecisionId === next.id)?.branch,
    "false",
  );
});

test("duplicating a decision creates independent settings and a fresh identity", () => {
  const { decision } = graph();
  decision.data.handleFailure = true;
  decision.data.joinMode = "any_settled";
  const copy = duplicateDecisionNode(decision);
  assert.notEqual(copy.id, decision.id);
  assert.equal(copy.data.decisionId, copy.id);
  assert.equal(copy.data.handleFailure, true);
  assert.equal(copy.data.joinMode, "any_settled");
  assert.deepEqual(copy.data.predicate, decision.data.predicate);
  assert.notEqual(copy.data.predicate, decision.data.predicate);
});

test("auto layout places decisions between their upstream and downstream nodes", () => {
  const original = graph();
  const arranged = autoLayoutGraph(original.nodes, original.edges);
  const position = (id: string) =>
    arranged.find((node) => node.id === id)!.position;
  assert.ok(position(original.source.id).x < position(original.decision.id).x);
  for (const node of [original.yes, original.no, original.next]) {
    assert.ok(position(original.decision.id).x < position(node.id).x);
  }
  assert.notEqual(position(original.yes.id).y, position(original.no.id).y);
  assert.deepEqual(
    autoLayoutGraph(arranged, original.edges).map((node) => node.position),
    arranged.map((node) => node.position),
  );
});
