import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  PanOnScrollMode,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnEdgesChange,
  type OnNodesChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Boxes,
  ClipboardPaste,
  Copy,
  GitBranch,
  Info,
  Network,
  Plus,
  Scissors,
  Settings,
  Split,
  Trash2,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ActionCatalogDialog } from "./action-catalog-dialog";
import { GraphActionBar } from "./workflow-graph-toolbar";
import { WorkflowLayoutEdge } from "./workflow-layout-edge";
import {
  workflowLayoutSignature,
  type WorkflowLayoutHandles,
  type WorkflowLayoutResult,
} from "./workflow-layout-routing";
import {
  WORKFLOW_GRID_SIZE,
  WORKFLOW_SNAP_GRID,
} from "./workflow-graph-constants";
import { isStepNode, isTriggerNode } from "./workflow-graph-model";
import { EndpointCreateDialog, NodeInfoDialog } from "./workflow-node-dialogs";
import { WorkflowStepNode } from "./workflow-step-node";
import { WorkflowControlNode } from "./workflow-control-node";
import { WorkflowDecisionNode } from "./workflow-decision-node";
import { WorkflowTriggerNode } from "./workflow-trigger-node";
import { WorkflowTriggerPickerDialog } from "./workflow-trigger-picker-dialog";
import type { BuiltinWorkflowTemplate } from "./workflow-templates";
import type {
  ActionPackage,
  ActionSort,
  BeamTransferEndpointRole,
  CredentialRecord,
  GraphControlMode,
  WorkflowCanvasNodeData,
  WorkflowNodeData,
  WorkflowSourceSummary,
  WorkflowTriggerType,
} from "./workflow-graph-types";

const nodeTypes = {
  workflowControl: WorkflowControlNode,
  workflowDecision: WorkflowDecisionNode,
  workflowStep: WorkflowStepNode,
  workflowTrigger: WorkflowTriggerNode,
};

const workflowFitViewOptions = { maxZoom: 0.9, padding: 0.32 };
const edgeTypes = { workflowLayout: WorkflowLayoutEdge };

type CanvasPosition = { x: number; y: number };

export function WorkflowEditorCanvas({
  actionCatalogOpen,
  actionSearch,
  actionSort,
  actions,
  allActionsCount,
  canRedo,
  canUndo,
  controlMode,
  credentials,
  edges,
  endpointActionAvailable,
  endpointDraftNode,
  endpointDraftRole,
  infoNode,

  layoutRequestKey,
  nodes,
  revealNodeId,
  onNodeRevealed,
  onActionCatalogOpenChange,
  onActionInstalled,
  onActionSearchChange,
  onActionSelect,
  onActionSortChange,
  onAddEndpoint,
  onAddFanOut,
  onAddDecision,
  onAddSwitch,
  onAddLoop,
  onAddTrigger,
  onAutoLayout,
  onConnect,
  onControlModeChange,
  onCopyNode,
  onCutNode,
  onDeleteNode,
  onDeleteSelection,
  onDuplicateNode,
  onRedo,
  onUndo,
  onEdgesChange,
  onEndpointCancel,
  onEndpointCreate,
  onEndpointNodeChange,
  onEditTrigger,
  onInfoNodeChange,
  onInfoOpenChange,
  onNodeSelect,
  onNodesChange,
  onOpenActions,
  onOpenWorkflows,
  onOpenRoom,
  onOpenDistribution,
  distributed,
  hasRoom,
  onPaste,
  onTemplateCatalogOpenChange,
  onTemplateSelect,
  templateCatalogOpen,
  templates,
  workflowId,
  workflows,
}: {
  actionCatalogOpen: boolean;
  actionSearch: string;
  actionSort: ActionSort;
  actions: ActionPackage[];
  allActionsCount: number;
  canRedo: boolean;
  canUndo: boolean;
  controlMode: GraphControlMode;
  credentials: CredentialRecord[];
  edges: Edge[];
  endpointActionAvailable: boolean;
  endpointDraftNode: Node<WorkflowNodeData> | null;
  endpointDraftRole?: BeamTransferEndpointRole;
  infoNode: Node<WorkflowCanvasNodeData> | null;

  layoutRequestKey: number;
  nodes: Node<WorkflowCanvasNodeData>[];
  onActionCatalogOpenChange(open: boolean): void;
  onActionInstalled(action: ActionPackage): void;
  onActionSearchChange(value: string): void;
  onActionSelect(action: ActionPackage): void;
  onActionSortChange(value: ActionSort): void;
  onAddEndpoint(position?: CanvasPosition): void;
  onAddFanOut(position?: CanvasPosition): void;
  onAddDecision(position?: CanvasPosition): void;
  onAddSwitch(position?: CanvasPosition): void;
  onAddLoop(position?: CanvasPosition): void;
  onAddTrigger(
    type: WorkflowTriggerType,
    config?: Record<string, unknown>,
    options?: { enabled?: boolean; name?: string },
  ): void;
  onAutoLayout(
    handles: WorkflowLayoutHandles,
  ): Promise<WorkflowLayoutResult | null>;
  onConnect(connection: Connection): void;
  onControlModeChange(value: GraphControlMode): void;
  onCopyNode(node: Node<WorkflowCanvasNodeData>): void;
  onCutNode(node: Node<WorkflowCanvasNodeData>): void;
  onDeleteNode(nodeId: string): void;
  onDeleteSelection(): void;
  onDuplicateNode(node: Node<WorkflowCanvasNodeData>): void;
  onRedo(): void;
  onUndo(): void;
  onEdgesChange: OnEdgesChange;
  onEndpointCancel(): void;
  onEndpointCreate(node: Node<WorkflowNodeData>): void;
  onEndpointNodeChange(patch: Partial<WorkflowNodeData>): void;
  onEditTrigger(nodeId: string): void;
  onInfoNodeChange(
    nodeId: string,
    patch: Partial<WorkflowCanvasNodeData>,
  ): void;
  onInfoOpenChange(open: boolean): void;
  onNodeSelect(node: Node<WorkflowCanvasNodeData>): void;
  onNodesChange: OnNodesChange<Node<WorkflowCanvasNodeData>>;
  onOpenActions(position?: CanvasPosition): void;
  onOpenWorkflows(): void;
  onOpenRoom(): void;
  onOpenDistribution(): void;
  distributed: boolean;
  hasRoom: boolean;
  onPaste(position?: CanvasPosition): void;
  /** A node to pan into view once it has rendered, keeping the zoom. */
  revealNodeId: string | null;
  onNodeRevealed(): void;
  onTemplateCatalogOpenChange(open: boolean): void;
  onTemplateSelect(template: BuiltinWorkflowTemplate): void;
  templateCatalogOpen: boolean;
  templates: BuiltinWorkflowTemplate[];
  workflowId: string;
  workflows: WorkflowSourceSummary[];
}) {
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    Node<WorkflowCanvasNodeData>,
    Edge
  > | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    flowPosition: CanvasPosition;
    screenPosition: CanvasPosition;
  } | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<{
    node: Node<WorkflowCanvasNodeData>;
    screenPosition: CanvasPosition;
  } | null>(null);
  const [fitViewAfterLayout, setFitViewAfterLayout] = useState(false);
  const [addTriggerPickerOpen, setAddTriggerPickerOpen] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [layoutPending, setLayoutPending] = useState(false);
  const [layoutError, setLayoutError] = useState("");
  const [layoutRoutes, setLayoutRoutes] = useState<{
    signature: string;
    routes: WorkflowLayoutResult["routes"];
  } | null>(null);
  const layoutPendingRef = useRef(false);
  const layoutGenerationRef = useRef(0);
  useEffect(() => {
    layoutPendingRef.current = false;
    setLayoutPending(false);
    setLayoutError("");
    setLayoutRoutes(null);
    return () => {
      layoutGenerationRef.current += 1;
    };
  }, [workflowId]);
  const routedEdges = useMemo(() => {
    if (
      !layoutRoutes ||
      layoutRoutes.signature !== workflowLayoutSignature(nodes, edges)
    )
      return edges;
    return edges.map((edge) =>
      layoutRoutes.routes[edge.id]
        ? {
            ...edge,
            type: "workflowLayout",
            data: { ...edge.data, layoutRoute: layoutRoutes.routes[edge.id] },
          }
        : edge,
    );
  }, [nodes, edges, layoutRoutes]);
  const handledLayoutRequestRef = useRef(layoutRequestKey);
  const closeContextMenu = () => {
    setContextMenu(null);
    setNodeContextMenu(null);
  };
  const contextAction = (action: (position: CanvasPosition) => void) => {
    if (!contextMenu) {
      return;
    }
    action(contextMenu.flowPosition);
    closeContextMenu();
  };
  const nodeContextAction = (
    action: (node: Node<WorkflowCanvasNodeData>) => void,
  ) => {
    if (!nodeContextMenu) {
      return;
    }
    action(nodeContextMenu.node);
    closeContextMenu();
  };
  const runAutoLayout = useCallback(async () => {
    if (layoutPendingRef.current) return;
    layoutPendingRef.current = true;
    setLayoutPending(true);
    setLayoutError("");
    const generation = layoutGenerationRef.current;
    try {
      const handles: WorkflowLayoutHandles = {};
      for (const node of nodes) {
        const bounds = flowInstance?.getInternalNode(node.id)?.internals
          .handleBounds;
        handles[node.id] = (["source", "target"] as const).flatMap((type) =>
          (bounds?.[type] ?? []).map((port) => ({
            id: port.id ?? null,
            type,
            position: port.position,
            x:
              port.x +
              (port.position === Position.Right
                ? port.width
                : port.position === Position.Left
                  ? 0
                  : port.width / 2),
            y:
              port.y +
              (port.position === Position.Bottom
                ? port.height
                : port.position === Position.Top
                  ? 0
                  : port.height / 2),
          })),
        );
      }
      const result = await onAutoLayout(handles);
      if (generation !== layoutGenerationRef.current) return;
      if (!result) {
        setLayoutError(
          "The workflow changed during layout. Click Layout to try again.",
        );
        return;
      }
      setLayoutRoutes({
        signature: workflowLayoutSignature(result.nodes, result.edges),
        routes: result.routes,
      });
      setFitViewAfterLayout(true);
    } catch (error) {
      if (generation === layoutGenerationRef.current)
        setLayoutError(
          `Could not arrange the workflow: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      if (generation === layoutGenerationRef.current) {
        layoutPendingRef.current = false;
        setLayoutPending(false);
      }
    }
  }, [onAutoLayout, flowInstance, nodes]);

  useEffect(() => {
    if (!revealNodeId || !flowInstance) {
      return undefined;
    }
    const node = nodes.find((candidate) => candidate.id === revealNodeId);
    if (!node) {
      return undefined;
    }
    // Two frames, as for fit-view below: the node needs to be measured first.
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const width = node.measured?.width ?? 248;
        const height = node.measured?.height ?? 56;
        void flowInstance.setCenter(
          node.position.x + width / 2,
          node.position.y + height / 2,
          { zoom: flowInstance.getZoom(), duration: 260 },
        );
        onNodeRevealed();
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [flowInstance, nodes, onNodeRevealed, revealNodeId]);

  useEffect(() => {
    if (!fitViewAfterLayout || !flowInstance) {
      return undefined;
    }

    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        void flowInstance.fitView({ ...workflowFitViewOptions, duration: 260 });
        setFitViewAfterLayout(false);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [fitViewAfterLayout, flowInstance, nodes]);

  useEffect(() => {
    if (layoutRequestKey === handledLayoutRequestRef.current) {
      return;
    }

    handledLayoutRequestRef.current = layoutRequestKey;
    runAutoLayout();
  }, [layoutRequestKey, runAutoLayout]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <ReactFlow
        defaultMarkerColor={null}
        className="workflow-graph"
        connectionRadius={28}
        // A click on a port's "+" that moves a pixel or two must stay a
        // click, not start a connection drag that swallows it.
        connectionDragThreshold={6}
        connectOnClick={controlMode === "connect"}
        edges={routedEdges}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={workflowFitViewOptions}
        minZoom={0.2}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable={controlMode !== "pan"}
        nodesDraggable={controlMode !== "pan"}
        panOnDrag={controlMode === "pan" ? [0, 1] : [1]}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        proOptions={{ hideAttribution: true }}
        selectionOnDrag={controlMode === "select"}
        snapToGrid={snapToGrid}
        snapGrid={WORKFLOW_SNAP_GRID}
        zoomActivationKeyCode={["Meta", "Control"]}
        zoomOnScroll
        onConnect={onConnect}
        onEdgesChange={onEdgesChange}
        onInit={setFlowInstance}
        onNodeDoubleClick={(_event, node) => {
          const selectedNode = node as Node<WorkflowCanvasNodeData>;
          if (isTriggerNode(selectedNode)) {
            onEditTrigger(selectedNode.id);
          } else {
            onNodeSelect(selectedNode);
          }
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu(null);
          setNodeContextMenu({
            node: node as Node<WorkflowCanvasNodeData>,
            screenPosition: {
              x: event.clientX,
              y: event.clientY,
            },
          });
        }}
        onNodesChange={onNodesChange}
        onPaneClick={closeContextMenu}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          if (!flowInstance) {
            return;
          }
          setContextMenu({
            flowPosition: flowInstance.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            }),
            screenPosition: {
              x: event.clientX,
              y: event.clientY,
            },
          });
        }}
      >
        <Background
          color="hsl(var(--muted-foreground) / 0.4)"
          gap={WORKFLOW_GRID_SIZE}
          size={1.5}
        />
        <Panel position="top-center" className="max-w-[calc(100%-2rem)]">
          <GraphActionBar
            canDuplicate={
              nodes.filter((node) => node.selected).length === 1 &&
              !edges.some((edge) => edge.selected)
            }
            canRedo={canRedo}
            canUndo={canUndo}
            controlMode={controlMode}
            endpointAvailable={endpointActionAvailable}
            onAddEndpoint={onAddEndpoint}
            onAddFanOut={onAddFanOut}
            onAddDecision={onAddDecision}
            onAddSwitch={onAddSwitch}
            onAddLoop={onAddLoop}
            onAutoLayout={runAutoLayout}
            layoutPending={layoutPending}
            onControlModeChange={onControlModeChange}
            snapToGrid={snapToGrid}
            onSnapToGridChange={setSnapToGrid}
            onDeleteSelection={onDeleteSelection}
            onDuplicateSelection={() => {
              const selected = nodes.filter((node) => node.selected);
              if (selected.length === 1 && selected[0]) {
                onDuplicateNode(selected[0]);
              }
            }}
            onOpenActions={onOpenActions}
            onOpenWorkflows={onOpenWorkflows}
            onOpenRoom={onOpenRoom}
            onOpenDistribution={onOpenDistribution}
            distributed={distributed}
            hasRoom={hasRoom}
            selectedCount={
              nodes.filter((node) => node.selected).length +
              edges.filter((edge) => edge.selected).length
            }
            onRedo={onRedo}
            onUndo={onUndo}
          />
        </Panel>
        {layoutError ? (
          <Panel position="bottom-center">
            <div
              role="alert"
              className="max-w-lg rounded-control border border-destructive/40 bg-background px-3 py-2 text-sm text-destructive"
            >
              {layoutError}
            </div>
          </Panel>
        ) : null}
        <Controls />
        <MiniMap
          bgColor="hsl(var(--card))"
          maskColor="hsl(var(--background) / 0.08)"
          maskStrokeColor="hsl(var(--muted-foreground))"
          maskStrokeWidth={2}
          nodeColor={(node) => {
            const presentation = (node.data as WorkflowCanvasNodeData)
              .definition.presentation;
            if (presentation === "resource") return "hsl(var(--info))";
            if (presentation === "composite") return "hsl(var(--primary))";
            if (presentation === "control") return "hsl(var(--warning))";
            if (presentation === "pill") return "hsl(var(--primary))";
            return "hsl(var(--muted-foreground))";
          }}
          nodeStrokeColor="hsl(var(--border))"
          pannable
          zoomable
        />
      </ReactFlow>
      {nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <Button
            className="pointer-events-auto h-11 px-6 text-base"
            onClick={() => setAddTriggerPickerOpen(true)}
            type="button"
          >
            <Zap className="h-4 w-4" />
            Start
          </Button>
        </div>
      ) : null}
      {contextMenu ? (
        <div
          className="fixed z-50 grid min-w-44 gap-1 rounded-control border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
          role="menu"
          style={{
            left: contextMenu.screenPosition.x,
            top: contextMenu.screenPosition.y,
          }}
        >
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => contextAction(onPaste)}
            role="menuitem"
            type="button"
          >
            <ClipboardPaste className="h-4 w-4" />
            Paste
            <span className="ml-auto text-xs text-muted-foreground">⌘V</span>
          </button>
          <div className="my-1 h-px bg-border" role="separator" />
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => contextAction(onOpenActions)}
            role="menuitem"
            type="button"
          >
            <Plus className="h-4 w-4" />
            Action
          </button>
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={!endpointActionAvailable}
            onClick={() => contextAction(onAddEndpoint)}
            role="menuitem"
            type="button"
          >
            <Network className="h-4 w-4" />
            Endpoint
          </button>
          <div className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Branch
          </div>
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => contextAction(onAddFanOut)}
            role="menuitem"
            type="button"
          >
            <GitBranch className="h-4 w-4" />
            Fan-out
          </button>
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => contextAction(onAddLoop)}
            role="menuitem"
            type="button"
          >
            <Network className="h-4 w-4" />
            Bounded loop
          </button>
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => contextAction(onAddDecision)}
            role="menuitem"
            type="button"
          >
            <Split className="h-4 w-4" />
            Decision
          </button>
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => contextAction(onAddSwitch)}
            role="menuitem"
            type="button"
          >
            <GitBranch className="h-4 w-4" />
            Switch
          </button>
        </div>
      ) : null}
      {nodeContextMenu ? (
        <div
          className="fixed z-50 grid min-w-40 gap-1 rounded-control border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
          role="menu"
          style={{
            left: nodeContextMenu.screenPosition.x,
            top: nodeContextMenu.screenPosition.y,
          }}
        >
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => nodeContextAction(onCopyNode)}
            role="menuitem"
            type="button"
          >
            <Copy className="h-4 w-4" />
            Copy
            <span className="ml-auto text-xs text-muted-foreground">⌘C</span>
          </button>
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => nodeContextAction(onCutNode)}
            role="menuitem"
            type="button"
          >
            <Scissors className="h-4 w-4" />
            Cut
            <span className="ml-auto text-xs text-muted-foreground">⌘X</span>
          </button>
          <div className="my-1 h-px bg-border" role="separator" />
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => nodeContextAction(onDuplicateNode)}
            role="menuitem"
            type="button"
          >
            <Copy className="h-4 w-4" />
            Duplicate
          </button>
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() =>
              nodeContextAction((node) =>
                isTriggerNode(node)
                  ? onEditTrigger(node.id)
                  : onNodeSelect(node),
              )
            }
            role="menuitem"
            type="button"
          >
            {isTriggerNode(nodeContextMenu.node) ? (
              <Settings className="h-4 w-4" />
            ) : (
              <Info className="h-4 w-4" />
            )}
            {isTriggerNode(nodeContextMenu.node) ? "Edit trigger" : "Info"}
          </button>
          <button
            className="flex h-9 items-center gap-2 rounded-badge px-2 text-left text-destructive outline-none hover:bg-destructive/10 focus-visible:bg-destructive/10"
            onClick={() => nodeContextAction((node) => onDeleteNode(node.id))}
            role="menuitem"
            type="button"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      ) : null}
      <NodeInfoDialog
        credentials={credentials}
        node={infoNode}
        nodes={nodes}
        steps={nodes.filter(isStepNode)}
        onNodeChange={onInfoNodeChange}
        onOpenChange={onInfoOpenChange}
      />
      <WorkflowTriggerPickerDialog
        mode="add"
        open={addTriggerPickerOpen}
        onOpenChange={setAddTriggerPickerOpen}
        onSubmit={(trigger) => {
          onAddTrigger(trigger.type, trigger.config, {
            enabled: trigger.enabled,
            name: trigger.name,
          });
          setAddTriggerPickerOpen(false);
        }}
        workflowId={workflowId}
        workflows={workflows}
      />
      <EndpointCreateDialog
        credentials={credentials}
        node={endpointDraftNode}
        onCancel={onEndpointCancel}
        onCreate={onEndpointCreate}
        onNodeChange={onEndpointNodeChange}
        role={endpointDraftRole}
      />
      <ActionCatalogDialog
        actions={actions}
        open={actionCatalogOpen}
        search={actionSearch}
        sort={actionSort}
        totalCount={allActionsCount}
        onActionInstalled={onActionInstalled}
        onActionSelect={onActionSelect}
        onOpenChange={onActionCatalogOpenChange}
        onSearchChange={onActionSearchChange}
        onSortChange={onActionSortChange}
      />
      <TemplateCatalogDialog
        open={templateCatalogOpen}
        templates={templates}
        onOpenChange={onTemplateCatalogOpenChange}
        onTemplateSelect={onTemplateSelect}
      />
    </div>
  );
}

function TemplateCatalogDialog({
  open,
  templates,
  onOpenChange,
  onTemplateSelect,
}: {
  open: boolean;
  templates: BuiltinWorkflowTemplate[];
  onOpenChange(open: boolean): void;
  onTemplateSelect(template: BuiltinWorkflowTemplate): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(720px,calc(100vw-32px))]">
        <DialogHeader>
          <DialogTitle>Reusable templates</DialogTitle>
          <DialogDescription>
            Replace the current graph with a saved built-in subgraph.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {templates.map((template) => (
            <button
              className="grid gap-3 rounded-control border bg-background p-4 text-left transition-colors hover:bg-secondary hover:text-secondary-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              key={template.id}
              onClick={() => onTemplateSelect(template)}
              type="button"
            >
              <span className="flex items-center gap-2">
                <Boxes className="h-4 w-4 text-muted-foreground" />
                <strong className="text-sm">{template.name}</strong>
              </span>
              <span className="text-sm leading-5 text-muted-foreground">
                {template.description}
              </span>
              <span className="flex flex-wrap gap-2">
                {template.actionNames.map((actionName) => (
                  <Badge key={actionName} variant="outline">
                    {actionName}
                  </Badge>
                ))}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
