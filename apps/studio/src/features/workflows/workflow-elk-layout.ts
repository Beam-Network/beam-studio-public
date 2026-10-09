import { Position, type Edge, type Node } from "@xyflow/react";
import type { ElkNode, ElkPort } from "elkjs/lib/elk-api";
import { edgeKindOf, isDecisionNode, isStepNode } from "./workflow-graph-model";
import {
  WORKFLOW_NODE_HANDLE_Y,
  WORKFLOW_NODE_HEADER_HEIGHT,
  WORKFLOW_BRANCH_ROW_HEIGHT,
  workflowDecisionOutputY,
} from "./workflow-node-geometry";
import type { WorkflowCanvasNodeData } from "./workflow-graph-types";
import type {
  LayoutHandle,
  LayoutPoint,
  WorkflowLayoutHandles,
  WorkflowLayoutResult,
} from "./workflow-layout-routing";

type CanvasNode = Node<WorkflowCanvasNodeData>;
type Size = { width: number; height: number };
type Block = Size & {
  id: string;
  offsets: Map<string, LayoutPoint>;
  ports: ElkPort[];
};
const GAP = 48;
const ORIGIN = 120;

export function workflowLayoutNodeSize(node: CanvasNode): Size {
  const presentation = node.data.definition.presentation;
  const decisionRows = isDecisionNode(node)
    ? node.data.kind === "switch"
      ? node.data.cases.length + 1
      : 2
    : 0;
  const width = isDecisionNode(node)
    ? 330
    : presentation === "pill" || presentation === "resource"
      ? 248
      : presentation === "control"
        ? 280
        : 292;
  const height = decisionRows
    ? WORKFLOW_NODE_HEADER_HEIGHT +
      decisionRows * WORKFLOW_BRANCH_ROW_HEIGHT +
      40
    : presentation === "composite"
      ? 162
      : presentation === "pill" || presentation === "resource"
        ? WORKFLOW_NODE_HEADER_HEIGHT
        : 126;
  return {
    width: node.measured?.width || node.width || width,
    height: node.measured?.height || node.height || height,
  };
}

function handle(
  node: CanvasNode,
  type: "source" | "target",
  id: string | null | undefined,
  handles: WorkflowLayoutHandles,
): LayoutHandle {
  const measured = handles[node.id]?.find(
    (port) => port.type === type && (id == null || port.id === id),
  );
  if (measured) return measured;
  const size = workflowLayoutNodeSize(node);
  if (
    node.data.definition.presentation === "composite" &&
    (id === "source-endpoints" || id === "destination-endpoints")
  ) {
    return {
      id,
      type,
      position: Position.Bottom,
      x: size.width / 2 + (id === "source-endpoints" ? -64 : 64),
      y: size.height - 20,
    };
  }
  return {
    id: id ?? null,
    type,
    position: type === "source" ? Position.Right : Position.Left,
    x: type === "source" ? size.width : 0,
    y:
      isDecisionNode(node) && type === "source"
        ? workflowDecisionOutputY(node.data, id)
        : WORKFLOW_NODE_HANDLE_Y,
  };
}

function makeBlocks(
  nodes: CanvasNode[],
  edges: Edge[],
  handles: WorkflowLayoutHandles,
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const owners = new Map<string, { id: string; role: string }>();
  for (const node of nodes) {
    if (node.data.definition.presentation !== "resource") continue;
    const incident = edges.filter(
      (edge) => edge.source === node.id || edge.target === node.id,
    );
    const first = incident[0]?.data;
    const owner =
      typeof first?.compositeNodeId === "string"
        ? byId.get(first.compositeNodeId)
        : undefined;
    // A shared resource remains a real layout node. Hiding it inside one
    // transfer would route the other transfer's edges through that block.
    if (
      owner?.data.definition.presentation === "composite" &&
      incident.every(
        (edge) =>
          edge.data?.compositeNodeId === owner.id &&
          edge.data?.memberNodeId === node.id &&
          edge.data?.membershipRole === first?.membershipRole,
      ) &&
      (first?.membershipRole === "sourceEndpoints" ||
        first?.membershipRole === "destinationEndpoints")
    ) {
      owners.set(node.id, { id: owner.id, role: first.membershipRole });
    }
  }
  const blocks = new Map<string, Block>();
  for (const node of nodes) {
    if (owners.has(node.id)) continue;
    const size = workflowLayoutNodeSize(node);
    const offsets = new Map<string, LayoutPoint>([[node.id, { x: 0, y: 0 }]]);
    const resources = nodes.filter(
      (member) => owners.get(member.id)?.id === node.id,
    );
    if (!resources.length) {
      blocks.set(node.id, { id: node.id, ...size, offsets, ports: [] });
      continue;
    }
    const sources = resources.filter(
      (member) => owners.get(member.id)?.role === "sourceEndpoints",
    );
    const destinations = resources.filter(
      (member) => owners.get(member.id)?.role === "destinationEndpoints",
    );
    const leftWidth = Math.max(
      0,
      ...sources.map((member) => workflowLayoutNodeSize(member).width),
    );
    const rightWidth = Math.max(
      0,
      ...destinations.map((member) => workflowLayoutNodeSize(member).width),
    );
    const input = handle(node, "target", "source-endpoints", handles);
    const output = handle(node, "source", "destination-endpoints", handles);
    const left = Math.max(leftWidth + GAP - input.x, 0);
    const width = Math.max(
      left + size.width,
      left + output.x + GAP + rightWidth,
    );
    offsets.set(node.id, { x: left, y: 0 });
    let height = size.height;
    for (const [members, source] of [
      [sources, true],
      [destinations, false],
    ] as const) {
      let y = size.height + GAP;
      for (const member of members) {
        const memberSize = workflowLayoutNodeSize(member);
        offsets.set(member.id, {
          x: source ? leftWidth - memberSize.width : width - rightWidth,
          y,
        });
        y += memberSize.height + GAP;
      }
      if (members.length) height = Math.max(height, y - GAP);
    }
    blocks.set(node.id, { id: node.id, width, height, offsets, ports: [] });
  }
  return { blocks, owners };
}

export async function layoutWorkflowWithElk(
  nodes: CanvasNode[],
  edges: Edge[],
  handles: WorkflowLayoutHandles = {},
): Promise<WorkflowLayoutResult> {
  if (!nodes.length) return { nodes, edges, routes: {} };
  // Model order, never the current canvas coordinates, breaks layout ties.
  const ordered = [...nodes].sort(
    (a, b) =>
      (isStepNode(a) ? a.data.position : 0) -
        (isStepNode(b) ? b.data.position : 0) || a.id.localeCompare(b.id),
  );
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const { blocks, owners } = makeBlocks(ordered, edges, handles);
  const blockId = (id: string) => owners.get(id)?.id ?? id;
  const validEdges = edges
    .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
    .sort((a, b) => a.id.localeCompare(b.id));
  const externalEdges = validEdges.filter(
    (edge) =>
      blockId(edge.source) !== blockId(edge.target) ||
      edge.source === edge.target,
  );
  const endpoint = (edge: Edge, type: "source" | "target") => {
    const node = byId.get(type === "source" ? edge.source : edge.target)!;
    const port = handle(
      node,
      type,
      type === "source" ? edge.sourceHandle : edge.targetHandle,
      handles,
    );
    const block = blocks.get(blockId(node.id))!;
    const offset = block.offsets.get(node.id)!;
    const id = JSON.stringify([block.id, node.id, type, port.id]);
    if (!block.ports.some((existing) => existing.id === id)) {
      // External resource links leave through a corridor below the transfer.
      // Project bottom handles to a side port: long south-facing edges in a
      // left-to-right layer can otherwise run through sibling transfer blocks.
      const position =
        port.position === Position.Bottom
          ? type === "source"
            ? Position.Right
            : Position.Left
          : port.position;
      const x =
        position === Position.Left
          ? 0
          : position === Position.Right
            ? block.width
            : offset.x + port.x;
      const y =
        position === Position.Top
          ? 0
          : port.position === Position.Bottom
            ? offset.y + workflowLayoutNodeSize(node).height + GAP / 2
            : offset.y + port.y;
      block.height = Math.max(block.height, y + GAP / 2);
      block.ports.push({
        id,
        x,
        y,
        width: 0,
        height: 0,
        layoutOptions: {
          "elk.port.side": {
            left: "WEST",
            right: "EAST",
            top: "NORTH",
            bottom: "SOUTH",
          }[position],
        },
      });
    }
    return id;
  };
  const elkEdges = externalEdges.map((edge) => ({
    id: edge.id,
    sources: [endpoint(edge, "source")],
    targets: [endpoint(edge, "target")],
  }));
  // Seed ELK's model order by following execution ports, so renaming nodes or
  // reordering the input array cannot swap the Switch's visual branch lanes.
  const executionEdges = externalEdges.filter((edge) =>
    ["flow", "trigger", "event", "error"].includes(edgeKindOf(edge)),
  );
  const incoming = new Set(executionEdges.map((edge) => blockId(edge.target)));
  const orderedBlocks: Block[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    orderedBlocks.push(blocks.get(id)!);
    const outgoing = executionEdges
      .filter((edge) => blockId(edge.source) === id)
      .sort((a, b) => {
        const source = byId.get(a.source)!;
        return (
          (isDecisionNode(source)
            ? workflowDecisionOutputY(source.data, a.sourceHandle) -
              workflowDecisionOutputY(source.data, b.sourceHandle)
            : 0) || a.target.localeCompare(b.target)
        );
      });
    for (const edge of outgoing) visit(blockId(edge.target));
  };
  for (const id of blocks.keys()) if (!incoming.has(id)) visit(id);
  for (const id of blocks.keys()) visit(id);
  const graph: ElkNode = {
    id: "workflow-layout",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.randomSeed": "1",
      "elk.spacing.nodeNode": "96",
      "elk.layered.spacing.nodeNodeBetweenLayers": "144",
      "elk.spacing.edgeNode": "24",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.spacing.componentComponent": "144",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.padding": `[top=${ORIGIN},left=${ORIGIN},bottom=${ORIGIN},right=${ORIGIN}]`,
    },
    children: orderedBlocks.map((block) => ({
      id: block.id,
      width: block.width,
      height: block.height,
      ports: block.ports.sort(
        (a, b) => (a.y ?? 0) - (b.y ?? 0) || a.id.localeCompare(b.id),
      ),
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    })),
    edges: elkEdges,
  };
  const { elk, dispose } = await createLayoutEngine();
  let arranged: ElkNode;
  try {
    arranged = await elk.layout(graph);
  } finally {
    dispose();
  }
  const positions = new Map<string, LayoutPoint>();
  for (const child of arranged.children ?? []) {
    if (!Number.isFinite(child.x) || !Number.isFinite(child.y))
      throw new Error("Layout returned an invalid node position.");
    for (const [id, offset] of blocks.get(child.id)!.offsets) {
      positions.set(id, { x: child.x! + offset.x, y: child.y! + offset.y });
    }
  }
  const absoluteHandle = (edge: Edge, type: "source" | "target") => {
    const id = type === "source" ? edge.source : edge.target;
    const port = handle(
      byId.get(id)!,
      type,
      type === "source" ? edge.sourceHandle : edge.targetHandle,
      handles,
    );
    const position = positions.get(id)!;
    return { x: position.x + port.x, y: position.y + port.y };
  };
  const routes: Record<string, LayoutPoint[]> = {};
  for (const edge of arranged.edges ?? []) {
    const original = validEdges.find((candidate) => candidate.id === edge.id)!;
    const section = edge.sections?.[0];
    if (!section || edge.sections?.length !== 1) continue;
    const source = absoluteHandle(original, "source");
    const target = absoluteHandle(original, "target");
    routes[edge.id] = [
      source,
      { x: source.x, y: section.startPoint.y },
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
      { x: target.x, y: section.endPoint.y },
      target,
    ];
  }
  for (const edge of validEdges) {
    if (
      blockId(edge.source) !== blockId(edge.target) ||
      edge.source === edge.target
    )
      continue;
    const source = absoluteHandle(edge, "source");
    const target = absoluteHandle(edge, "target");
    const memberIsSource = owners.has(edge.source);
    routes[edge.id] = [
      source,
      {
        x: memberIsSource ? target.x : source.x,
        y: memberIsSource ? source.y : target.y,
      },
      target,
    ];
  }
  return {
    nodes: nodes.map(
      (node) =>
        ({
          ...node,
          position: positions.get(node.id)!,
          data: {
            ...node.data,
            canvasX: positions.get(node.id)!.x,
            canvasY: positions.get(node.id)!.y,
          },
        }) as CanvasNode,
    ),
    edges,
    routes,
  };
}

async function createLayoutEngine() {
  if (typeof Worker !== "undefined") {
    const [{ default: ELK }, { default: LayoutWorker }] = await Promise.all([
      import("elkjs/lib/elk-api.js"),
      import("elkjs/lib/elk-worker.min.js?worker"),
    ]);
    const worker = new LayoutWorker();
    return {
      elk: new ELK({ workerFactory: () => worker }),
      dispose: () => worker.terminate(),
    };
  }
  // Node tests use ELK's in-process worker, which has no terminate method.
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  return { elk: new ELK(), dispose: () => undefined };
}
