import type { Position, Edge, Node } from "@xyflow/react";
import type { WorkflowCanvasNodeData } from "./workflow-graph-types";

export type LayoutPoint = { x: number; y: number };
export type LayoutHandle = LayoutPoint & {
  id: string | null;
  type: "source" | "target";
  position: Position;
};
export type WorkflowLayoutHandles = Record<string, LayoutHandle[]>;
export type WorkflowLayoutResult = {
  nodes: Node<WorkflowCanvasNodeData>[];
  edges: Edge[];
  routes: Record<string, LayoutPoint[]>;
};

// A route is valid only while the graph it was computed for is unchanged.
// Exclude selection and transient node data so selecting never loses routing.
export function workflowLayoutSignature(nodes: Node[], edges: Edge[]) {
  // Saved coordinates use float32 in the database. Ignore subpixel round-off.
  const coordinate = (value: number | undefined) =>
    value === undefined ? null : Math.round(value * 1000) / 1000;
  return JSON.stringify([
    nodes
      .map((node) => [
        node.id,
        coordinate(node.position.x),
        coordinate(node.position.y),
        coordinate(node.measured?.width ?? node.width),
        coordinate(node.measured?.height ?? node.height),
      ])
      .sort(),
    edges
      .map((edge) => [
        edge.id,
        edge.source,
        edge.target,
        edge.sourceHandle ?? null,
        edge.targetHandle ?? null,
      ])
      .sort(),
  ]);
}

export function workflowRoutePath(
  route: LayoutPoint[],
  source: LayoutPoint,
  target: LayoutPoint,
) {
  if (route.length < 2) return null;
  // React Flow may remeasure a handle after editing or saving. Never draw a
  // stale path that appears detached from its real endpoints.
  const close = (a: LayoutPoint, b: LayoutPoint) =>
    Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
  if (!close(route[0]!, source) || !close(route.at(-1)!, target)) return null;
  return route
    .map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`)
    .join(" ");
}
