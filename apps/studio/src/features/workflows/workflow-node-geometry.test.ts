import assert from "node:assert/strict";
import test from "node:test";
import { getSmoothStepPath, Position } from "@xyflow/react";
import {
  DECISION_TRUE_PORT,
  DECISION_FALSE_PORT,
  SWITCH_DEFAULT_PORT,
  switchCasePort,
} from "@beam-studio/core/workflows/graph-semantics";
import { WORKFLOW_GRID_SIZE } from "./workflow-graph-constants";
import {
  WORKFLOW_NODE_HANDLE_Y,
  workflowDecisionOutputY,
} from "./workflow-node-geometry";

test("every decision and switch output can face a snapped action without a bend", () => {
  const shapes = [
    {
      data: { kind: "if" as const, cases: [] },
      ports: [DECISION_TRUE_PORT, DECISION_FALSE_PORT],
    },
    {
      data: {
        kind: "switch" as const,
        cases: [{ id: "one" }, { id: "two" }, { id: "three" }],
      },
      ports: [
        switchCasePort("one"),
        switchCasePort("two"),
        switchCasePort("three"),
        SWITCH_DEFAULT_PORT,
      ],
    },
  ];
  for (const { data, ports } of shapes) {
    for (const port of ports) {
      const sourceY = 120 + workflowDecisionOutputY(data, port);
      const targetTop =
        Math.round((sourceY - WORKFLOW_NODE_HANDLE_Y) / WORKFLOW_GRID_SIZE) *
        WORKFLOW_GRID_SIZE;
      const targetY = targetTop + WORKFLOW_NODE_HANDLE_Y;
      assert.equal(sourceY, targetY);
      const [path] = getSmoothStepPath({
        sourceX: 330,
        sourceY,
        targetX: 600,
        targetY,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      });
      // Smoothstep must collapse to horizontal line segments, with no curve.
      assert.doesNotMatch(path, /[CQAS]/i);
      const points = [...path.matchAll(/[ML]\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)];
      assert.ok(points.length >= 2);
      assert.ok(points.every((point) => Number(point[2]) === sourceY));
    }
  }
});

test("reordering switch cases moves their stable ports to the matching row", () => {
  const data = { kind: "switch" as const, cases: [{ id: "a" }, { id: "b" }] };
  const firstY = workflowDecisionOutputY(data, switchCasePort("a"));
  const reordered = { ...data, cases: [...data.cases].reverse() };
  assert.equal(
    workflowDecisionOutputY(reordered, switchCasePort("a")),
    firstY + WORKFLOW_GRID_SIZE,
  );
});
