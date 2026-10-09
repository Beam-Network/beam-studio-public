import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { latestActionPackagesByName } from "@beam-studio/core/workflows/action-versions";
import {
  workflowNodeDefinition,
  workflowSwitchNodeDefinition,
} from "@beam-studio/core/workflows/graph-semantics";
import {
  createNode,
  decorateEdge,
  decorateTriggerEdge,
  edgeKindOf,
  isControlNode,
  isDecisionNode,
  isStepNode,
  isTriggerEdge,
  isTriggerNode,
  shortId,
} from "./workflow-graph-model";
import type {
  ActionPackage,
  WorkflowCanvasNodeData,
  WorkflowDecisionNodeData,
  WorkflowNodeData,
} from "./workflow-graph-types";
import { WORKFLOW_GRID_SIZE } from "./workflow-graph-constants";
import {
  WORKFLOW_NODE_HEADER_HEIGHT,
  WORKFLOW_NODE_HANDLE_Y,
  WORKFLOW_BRANCH_ROW_HEIGHT,
  workflowDecisionOutputY,
} from "./workflow-node-geometry";

const MIN_COLUMN_GAP = 112;
const PREFERRED_COLUMN_GAP = 136;
const MAX_COLUMN_GAP = 176;
const MIN_ROW_GAP = 80;
const PREFERRED_ROW_GAP = 104;
const MAX_ROW_GAP = 136;
const TRIGGER_WIDTH = 248;
const TRIGGER_HEIGHT = WORKFLOW_NODE_HEADER_HEIGHT;
const RESOURCE_NODE_WIDTH = 248;
const RESOURCE_NODE_HEIGHT = WORKFLOW_NODE_HEADER_HEIGHT;
const CONTROL_NODE_WIDTH = 280;
const CONTROL_NODE_HEIGHT = 78;
const STEP_NODE_WIDTH = 292;
const STEP_NODE_HEIGHT = 126;
const BEAM_TRANSFER_NODE_HEIGHT = 162;
const START_X = 120;
const START_Y = 120;
const COLUMN_GAP = clamp(PREFERRED_COLUMN_GAP, MIN_COLUMN_GAP, MAX_COLUMN_GAP);
const ROW_GAP = clamp(PREFERRED_ROW_GAP, MIN_ROW_GAP, MAX_ROW_GAP);
const SATELLITE_HORIZONTAL_GAP = 72;
const SATELLITE_TOP_GAP = 96;
const SATELLITE_ROW_GAP = 48;

type CompositeMembership = {
  compositeNodeId: string;
  memberNodeId: string;
  role: "source" | "destination";
};

export function duplicateStepNode(
  source: Node<WorkflowCanvasNodeData>,
  order: number,
): Node<WorkflowNodeData> | null {
  if (!isStepNode(source)) {
    return null;
  }

  const id = `wfs_${shortId()}`;
  const position = {
    x: source.position.x + 48,
    y: source.position.y + 48,
  };
  const config = cloneJson(source.data.config);
  const name = typeof config.name === "string" ? config.name.trim() : "";
  if (name) {
    config.name = `${name} copy`;
  }

  return {
    ...source,
    id,
    selected: false,
    position,
    data: {
      ...source.data,
      id,
      config,
      inputBindings: cloneJson(source.data.inputBindings),
      position: order,
      canvasX: position.x,
      canvasY: position.y,
      issues: [],
      nodeKind: "step",
    },
  };
}

export function duplicateDecisionNode(
  source: Node<WorkflowDecisionNodeData>,
): Node<WorkflowDecisionNodeData> {
  const id = `dec_${shortId()}`;
  const cases = cloneJson(source.data.cases);
  return {
    ...source,
    id,
    selected: false,
    position: { x: source.position.x + 48, y: source.position.y + 48 },
    data: {
      ...source.data,
      decisionId: id,
      name: `${source.data.name} copy`,
      predicate:
        source.data.predicate == null ? null : cloneJson(source.data.predicate),
      cases,
      definition:
        source.data.kind === "switch"
          ? workflowSwitchNodeDefinition(cases)
          : source.data.definition,
      issues: [],
    },
  };
}

export function autoLayoutGraph(
  nodes: Node<WorkflowCanvasNodeData>[],
  edges: Edge[],
) {
  const memberships = compositeMemberships(nodes, edges);
  const attachedResourceIds = new Set(
    memberships.map((membership) => membership.memberNodeId),
  );
  const layoutNodes = nodes.filter(
    (node) =>
      (isStepNode(node) ||
        isTriggerNode(node) ||
        isControlNode(node) ||
        isDecisionNode(node)) &&
      !attachedResourceIds.has(node.id),
  );
  const nodeIds = new Set(layoutNodes.map((node) => node.id));
  const incomingByNode = new Map<string, Set<string>>();
  const outgoingByNode = new Map<string, Set<string>>();
  const incomingEdgesByNode = new Map<string, Edge[]>();
  const nodesById = new Map(layoutNodes.map((node) => [node.id, node]));

  for (const edge of edges) {
    const edgeKind = edgeKindOf(edge);
    if (
      !isBackboneEdgeKind(edgeKind) ||
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target) ||
      edge.source === edge.target
    ) {
      continue;
    }
    setAdd(outgoingByNode, edge.source, edge.target);
    setAdd(incomingByNode, edge.target, edge.source);
    const incomingEdges = incomingEdgesByNode.get(edge.target) ?? [];
    incomingEdges.push(edge);
    incomingEdgesByNode.set(edge.target, incomingEdges);
  }

  const depthByNode = new Map<string, number>();
  const visit = (nodeId: string, visiting = new Set<string>()): number => {
    const cached = depthByNode.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(nodeId)) {
      depthByNode.set(nodeId, 0);
      return 0;
    }
    visiting.add(nodeId);
    const incoming = Array.from(incomingByNode.get(nodeId) ?? []);
    const depth = incoming.length
      ? Math.max(...incoming.map((source) => visit(source, visiting))) + 1
      : 0;
    visiting.delete(nodeId);
    depthByNode.set(nodeId, depth);
    return depth;
  };

  for (const node of layoutNodes) {
    visit(node.id);
  }

  const columnsByDepth = new Map<number, Node<WorkflowCanvasNodeData>[]>();
  for (const node of [...layoutNodes].sort((left, right) => {
    const leftOrder = nodeOrder(left);
    const rightOrder = nodeOrder(right);
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  })) {
    const depth = depthByNode.get(node.id) ?? 0;
    const column = columnsByDepth.get(depth) ?? [];
    column.push(node);
    columnsByDepth.set(depth, column);
  }

  orderColumns(columnsByDepth, incomingByNode, outgoingByNode);

  const depths = [...columnsByDepth.keys()].sort((left, right) => left - right);
  const positionById = new Map<string, { x: number; y: number }>();
  const widthByDepth = new Map(
    depths.map((depth) => {
      const widths = (columnsByDepth.get(depth) ?? [])
        .map(nodeSize)
        .map((size) => size.width);
      return [depth, widths.length ? Math.max(...widths) : STEP_NODE_WIDTH];
    }),
  );
  let columnX = START_X;
  for (const depth of depths) {
    const column = columnsByDepth.get(depth) ?? [];
    const columnSizes = column.map(nodeSize);
    const desiredTops = column.map((node, index) => {
      const incomingAnchors = (incomingEdgesByNode.get(node.id) ?? [])
        .map((edge) => {
          const source = nodesById.get(edge.source);
          const position = positionById.get(edge.source);
          if (!source || !position) return undefined;
          return (
            position.y +
            (isDecisionNode(source)
              ? workflowDecisionOutputY(source.data, edge.sourceHandle)
              : WORKFLOW_NODE_HANDLE_Y)
          );
        })
        .filter((value): value is number => value !== undefined);
      if (incomingAnchors.length) {
        return average(incomingAnchors) - WORKFLOW_NODE_HANDLE_Y;
      }
      const precedingHeight = columnSizes
        .slice(0, index)
        .reduce((sum, size) => sum + size.height, 0);
      return START_Y + precedingHeight + index * ROW_GAP;
    });
    const tops = separateColumnNodes(desiredTops, columnSizes);

    column.forEach((node, index) => {
      const position = {
        x: snapToGrid(columnX),
        // Rounding each top independently would bend otherwise aligned edges.
        y: tops[index]!,
      };
      positionById.set(node.id, position);
    });

    columnX += (widthByDepth.get(depth) ?? STEP_NODE_WIDTH) + COLUMN_GAP;
  }

  positionCompositeSatellites(nodes, memberships, positionById);
  normalizeVerticalPositions(positionById, START_Y);
  normalizeHorizontalPositions(positionById, START_X);

  return nodes.map((node) => {
    const next = positionById.get(node.id);
    if (!next) {
      return node;
    }
    return {
      ...node,
      position: next,
      data: {
        ...node.data,
        canvasX: next.x,
        canvasY: next.y,
      },
    } as Node<WorkflowCanvasNodeData>;
  });
}

export function createLinearTemplateGraph(
  actions: ActionPackage[],
  actionNames: string[],
) {
  const actionsByName = latestActionPackagesByName(actions);
  const nodes: Node<WorkflowCanvasNodeData>[] = [];
  const triggerId = `wftg_${shortId()}`;
  nodes.push({
    id: triggerId,
    type: "workflowTrigger",
    position: { x: START_X, y: START_Y },
    data: {
      id: triggerId,
      workflowTemplateId: "",
      type: "manual",
      name: "Trigger manually",
      enabled: true,
      config: {},
      state: {},
      canvasX: START_X,
      canvasY: START_Y,
      nodeKind: "trigger",
      workflowNodeKind: "trigger",
      definition: workflowNodeDefinition({ kind: "trigger" }),
      issues: [],
    },
  });

  for (const actionName of actionNames) {
    const action = actionsByName.get(actionName);
    if (!action) {
      continue;
    }
    nodes.push(createNode(action, nodes.length - 1, "action"));
  }

  const stepNodes = nodes.filter(isStepNode);
  const edges: Edge[] = [];
  const firstStep = stepNodes[0];
  if (firstStep) {
    edges.push(
      decorateTriggerEdge({
        id: `wfte_${triggerId}_${firstStep.id}_${shortId()}`,
        source: triggerId,
        target: firstStep.id,
        type: "smoothstep",
        data: {
          edgeKind: "trigger",
          condition: null,
          runtimeSource: triggerId,
          runtimeTarget: firstStep.id,
          runtimeSourceKind: "trigger",
          runtimeTargetKind: "step",
        },
        markerEnd: { type: MarkerType.ArrowClosed },
      }),
    );
  }

  for (let index = 1; index < stepNodes.length; index += 1) {
    const source = stepNodes[index - 1];
    const target = stepNodes[index];
    if (!source || !target) {
      continue;
    }
    edges.push(
      decorateEdge({
        id: `wfe_${source.id}_${target.id}_${shortId()}`,
        source: source.id,
        target: target.id,
        type: "smoothstep",
        data: {
          edgeKind: "flow",
          condition: null,
          runtimeSource: source.id,
          runtimeTarget: target.id,
          runtimeSourceKind: "step",
          runtimeTargetKind: "step",
        },
        markerEnd: { type: MarkerType.ArrowClosed },
      }),
    );
  }

  return {
    nodes: autoLayoutGraph(nodes, edges),
    edges: edges.map((edge) =>
      isTriggerEdge(edge) ? decorateTriggerEdge(edge) : decorateEdge(edge),
    ),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {})) as T;
}

function setAdd(map: Map<string, Set<string>>, key: string, value: string) {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

function orderColumns(
  columnsByDepth: Map<number, Node<WorkflowCanvasNodeData>[]>,
  incomingByStep: Map<string, Set<string>>,
  outgoingByStep: Map<string, Set<string>>,
) {
  const depths = [...columnsByDepth.keys()].sort((left, right) => left - right);
  const orderIndex = new Map<string, number>();
  const refreshOrderIndex = () => {
    orderIndex.clear();
    for (const depth of depths) {
      columnsByDepth.get(depth)?.forEach((node, index) => {
        orderIndex.set(node.id, index);
      });
    }
  };

  refreshOrderIndex();
  for (let pass = 0; pass < 4; pass += 1) {
    for (const depth of depths.slice(1)) {
      sortColumnByBarycenter(
        columnsByDepth.get(depth) ?? [],
        incomingByStep,
        orderIndex,
      );
      refreshOrderIndex();
    }
    for (const depth of depths.slice(0, -1).reverse()) {
      sortColumnByBarycenter(
        columnsByDepth.get(depth) ?? [],
        outgoingByStep,
        orderIndex,
      );
      refreshOrderIndex();
    }
  }
}

function sortColumnByBarycenter(
  column: Node<WorkflowCanvasNodeData>[],
  relatedByStep: Map<string, Set<string>>,
  orderIndex: Map<string, number>,
) {
  column.sort((left, right) => {
    const leftScore = barycenter(relatedByStep.get(left.id), orderIndex);
    const rightScore = barycenter(relatedByStep.get(right.id), orderIndex);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    const leftOrder = nodeOrder(left);
    const rightOrder = nodeOrder(right);
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });
}

function barycenter(
  ids: Set<string> | undefined,
  orderIndex: Map<string, number>,
) {
  const values = [...(ids ?? [])]
    .map((id) => orderIndex.get(id))
    .filter((value): value is number => value !== undefined);
  return values.length ? average(values) : Number.POSITIVE_INFINITY;
}

function normalizeVerticalPositions(
  positionById: Map<string, { x: number; y: number }>,
  minY: number,
) {
  const values = [...positionById.values()];
  if (!values.length) {
    return;
  }
  const currentMinY = Math.min(...values.map((position) => position.y));
  if (currentMinY >= minY) {
    return;
  }
  const offset =
    Math.ceil((minY - currentMinY) / WORKFLOW_GRID_SIZE) * WORKFLOW_GRID_SIZE;
  for (const position of values) {
    position.y += offset;
  }
}

function normalizeHorizontalPositions(
  positionById: Map<string, { x: number; y: number }>,
  minX: number,
) {
  const values = [...positionById.values()];
  if (!values.length) {
    return;
  }
  const currentMinX = Math.min(...values.map((position) => position.x));
  if (currentMinX >= minX) {
    return;
  }
  const offset =
    Math.ceil((minX - currentMinX) / WORKFLOW_GRID_SIZE) * WORKFLOW_GRID_SIZE;
  for (const position of values) {
    position.x += offset;
  }
}

function nodeSize(node: Node<WorkflowCanvasNodeData>) {
  const fallback = fallbackNodeSize(node);
  return {
    width: node.measured?.width ?? node.width ?? fallback.width,
    height: node.measured?.height ?? node.height ?? fallback.height,
  };
}

// Pack only colliding groups. Independent lanes retain their own upstream
// alignment, and branches sharing a parent spread around that parent's line.
function separateColumnNodes(
  desiredTops: number[],
  sizes: { height: number }[],
) {
  const offsets: number[] = [];
  const blocks: { start: number; count: number; total: number }[] = [];
  let offset = 0;
  desiredTops.forEach((top, index) => {
    offsets.push(offset);
    blocks.push({ start: index, count: 1, total: top - offset });
    offset += sizes[index]!.height + ROW_GAP;
    while (blocks.length > 1) {
      const right = blocks[blocks.length - 1]!;
      const left = blocks[blocks.length - 2]!;
      if (left.total / left.count <= right.total / right.count) break;
      left.count += right.count;
      left.total += right.total;
      blocks.pop();
    }
  });
  const tops: number[] = [];
  for (const block of blocks) {
    for (let index = block.start; index < block.start + block.count; index++) {
      tops[index] = block.total / block.count + offsets[index]!;
    }
  }
  return tops;
}

function fallbackNodeSize(node: Node<WorkflowCanvasNodeData>) {
  if (isDecisionNode(node)) {
    const branches =
      node.data.kind === "switch" ? node.data.cases.length + 1 : 2;
    return {
      width: 330,
      height:
        WORKFLOW_NODE_HEADER_HEIGHT +
        1 +
        branches * WORKFLOW_BRANCH_ROW_HEIGHT +
        (node.data.handleFailure ? 32 : 0),
    };
  }
  switch (node.data.definition.presentation) {
    case "pill":
      return { width: TRIGGER_WIDTH, height: TRIGGER_HEIGHT };
    case "resource":
      return { width: RESOURCE_NODE_WIDTH, height: RESOURCE_NODE_HEIGHT };
    case "control":
      return { width: CONTROL_NODE_WIDTH, height: CONTROL_NODE_HEIGHT };
    case "composite":
      return { width: STEP_NODE_WIDTH, height: BEAM_TRANSFER_NODE_HEIGHT };
    case "card":
      return { width: STEP_NODE_WIDTH, height: STEP_NODE_HEIGHT };
  }
}

function compositeMemberships(
  nodes: Node<WorkflowCanvasNodeData>[],
  edges: Edge[],
): CompositeMembership[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const membershipByMember = new Map<string, CompositeMembership>();

  for (const edge of edges) {
    const compositeNodeId = edge.data?.compositeNodeId;
    const memberNodeId = edge.data?.memberNodeId;
    const membershipRole = edge.data?.membershipRole;
    if (
      typeof compositeNodeId !== "string" ||
      typeof memberNodeId !== "string" ||
      (membershipRole !== "sourceEndpoints" &&
        membershipRole !== "destinationEndpoints")
    ) {
      continue;
    }
    const composite = nodesById.get(compositeNodeId);
    const member = nodesById.get(memberNodeId);
    if (
      composite?.data.definition.presentation !== "composite" ||
      member?.data.definition.presentation !== "resource"
    ) {
      continue;
    }
    membershipByMember.set(memberNodeId, {
      compositeNodeId,
      memberNodeId,
      role: membershipRole === "sourceEndpoints" ? "source" : "destination",
    });
  }

  return [...membershipByMember.values()].sort((left, right) => {
    return (
      left.compositeNodeId.localeCompare(right.compositeNodeId) ||
      left.role.localeCompare(right.role) ||
      left.memberNodeId.localeCompare(right.memberNodeId)
    );
  });
}

function positionCompositeSatellites(
  nodes: Node<WorkflowCanvasNodeData>[],
  memberships: CompositeMembership[],
  positionById: Map<string, { x: number; y: number }>,
) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const membershipsByComposite = new Map<string, CompositeMembership[]>();
  for (const membership of memberships) {
    const current =
      membershipsByComposite.get(membership.compositeNodeId) ?? [];
    current.push(membership);
    membershipsByComposite.set(membership.compositeNodeId, current);
  }

  for (const [
    compositeNodeId,
    compositeMemberships,
  ] of membershipsByComposite) {
    const composite = nodesById.get(compositeNodeId);
    const compositePosition = positionById.get(compositeNodeId);
    if (!composite || !compositePosition) {
      continue;
    }
    const compositeSize = nodeSize(composite);
    const baseY = snapToGrid(
      compositePosition.y + compositeSize.height + SATELLITE_TOP_GAP,
    );
    const byRole = {
      source: compositeMemberships.filter(({ role }) => role === "source"),
      destination: compositeMemberships.filter(
        ({ role }) => role === "destination",
      ),
    };

    for (const role of ["source", "destination"] as const) {
      byRole[role].forEach((membership, index) => {
        const member = nodesById.get(membership.memberNodeId);
        if (!member) {
          return;
        }
        const memberSize = nodeSize(member);
        const x =
          role === "source"
            ? compositePosition.x - memberSize.width - SATELLITE_HORIZONTAL_GAP
            : compositePosition.x +
              compositeSize.width +
              SATELLITE_HORIZONTAL_GAP;
        positionById.set(membership.memberNodeId, {
          x: snapToGrid(x),
          y: snapToGrid(
            baseY + index * (memberSize.height + SATELLITE_ROW_GAP),
          ),
        });
      });
    }
  }
}

function isBackboneEdgeKind(kind: string) {
  return kind === "flow" || kind === "trigger" || kind === "event";
}

function nodeOrder(node: Node<WorkflowCanvasNodeData>) {
  return isStepNode(node) ? Number(node.data.position ?? 0) : 0;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function snapToGrid(value: number) {
  return Math.round(value / WORKFLOW_GRID_SIZE) * WORKFLOW_GRID_SIZE;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
