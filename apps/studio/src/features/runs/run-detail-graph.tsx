import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import {
  normalizeWorkflowEdges,
  workflowNodeDefinition,
} from "@beam-studio/core/workflows/graph-semantics";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OBJECT_STORAGE_ENDPOINT_ACTION } from "../workflows/workflow-graph-constants";
import {
  displayStepName,
  graphTone,
  jsonRecord,
  numberValue,
  objectStorageObjectKey,
  stringValue,
  type StepRunRecord,
  type WorkflowEdgeRecord,
  type WorkflowStepRecord,
  type WorkflowTriggerEdgeRecord,
  type WorkflowTriggerRecord,
} from "./run-detail-data";
import {
  Fact,
  JsonPanel,
  StatusBadge,
  StatusIcon,
} from "./run-detail-primitives";

export function WorkflowExecutionGraph({
  edges,
  stepRuns,
  steps,
  triggerEdges,
  triggers,
}: {
  edges: WorkflowEdgeRecord[];
  stepRuns: StepRunRecord[];
  steps: WorkflowStepRecord[];
  triggerEdges: WorkflowTriggerEdgeRecord[];
  triggers: WorkflowTriggerRecord[];
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const flow = useMemo(
    () => workflowFlowElements(steps, edges, triggers, triggerEdges, stepRuns),
    [edges, stepRuns, steps, triggerEdges, triggers],
  );
  const selectedNode = selectedNodeId
    ? graphNodeDetails(selectedNodeId, steps, triggers, stepRuns)
    : null;

  return (
    <div className="overflow-hidden rounded-surface border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">
            Workflow graph
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Colored by run status. Select a node to inspect its config.
          </p>
        </div>
      </div>
      <div className="h-[380px] bg-background">
        <ReactFlow
          defaultMarkerColor={null}
          className="workflow-graph"
          edges={flow.edges}
          fitView
          maxZoom={1.3}
          minZoom={0.25}
          nodes={flow.nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          panOnScroll
          proOptions={{ hideAttribution: true }}
          zoomOnDoubleClick={false}
          zoomOnScroll={false}
          onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
        >
          <Background color="hsl(0 0% 11%)" gap={26} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <NodeConfigDialog
        node={selectedNode}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedNodeId(null);
          }
        }}
      />
    </div>
  );
}

type GraphNodeDetails =
  | {
      kind: "step";
      id: string;
      title: string;
      subtitle: string;
      step: WorkflowStepRecord;
      run?: StepRunRecord;
    }
  | {
      kind: "trigger";
      id: string;
      title: string;
      subtitle: string;
      trigger: WorkflowTriggerRecord;
    };

function NodeConfigDialog({
  node,
  onOpenChange,
}: {
  node: GraphNodeDetails | null;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={Boolean(node)} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[min(820px,calc(100vh-48px))] w-[min(860px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>{node?.title ?? "Node config"}</DialogTitle>
          <DialogDescription>{node?.subtitle}</DialogDescription>
        </DialogHeader>
        {node ? (
          <div className="min-h-0 overflow-auto">
            {node.kind === "step" ? (
              <div className="grid gap-4">
                <div className="grid gap-2 rounded-control border p-3 md:grid-cols-2">
                  <Fact label="Step ID" value={<code>{node.step.id}</code>} />
                  <Fact
                    label="Package"
                    value={node.step.actionPackageName ?? "-"}
                  />
                  <Fact label="Position" value={node.step.position ?? "-"} />
                  <Fact label="Placement" value={node.step.placement ?? "-"} />
                  <Fact
                    label="Status"
                    value={
                      <StatusBadge
                        status={stringValue(node.run?.status) || "not_reached"}
                        withIcon
                      />
                    }
                  />
                  <Fact label="Attempt" value={node.run?.attempt ?? "-"} />
                </div>
                {node.step.actionPackageName ===
                OBJECT_STORAGE_ENDPOINT_ACTION ? (
                  <div className="grid gap-2 rounded-control border p-3 md:grid-cols-2">
                    <Fact
                      label="Bucket"
                      value={
                        stringValue(jsonRecord(node.step.config).bucket) || "-"
                      }
                    />
                    <Fact
                      label="Object key"
                      value={
                        stringValue(jsonRecord(node.step.config).objectKey) ||
                        "-"
                      }
                    />
                    <Fact
                      label="Source type"
                      value={
                        stringValue(jsonRecord(node.step.config).sourceType) ||
                        "-"
                      }
                    />
                    <Fact
                      label="Provider"
                      value={
                        stringValue(jsonRecord(node.step.config).provider) ||
                        "-"
                      }
                    />
                  </div>
                ) : null}
                <JsonPanel title="Config" value={node.step.config} />
                <JsonPanel
                  title="Input bindings"
                  value={node.step.inputBindings}
                />
                <JsonPanel title="Manifest" value={node.step.manifest} />
                {node.run ? (
                  <>
                    <JsonPanel title="Run input" value={node.run.input} />
                    <JsonPanel title="Run output" value={node.run.output} />
                    <JsonPanel title="Run metadata" value={node.run.metadata} />
                  </>
                ) : null}
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-2 rounded-control border p-3 md:grid-cols-2">
                  <Fact
                    label="Trigger ID"
                    value={<code>{node.trigger.id}</code>}
                  />
                  <Fact label="Type" value={node.trigger.type ?? "-"} />
                  <Fact
                    label="Enabled"
                    value={node.trigger.enabled === false ? "No" : "Yes"}
                  />
                </div>
                <JsonPanel title="Config" value={node.trigger.config} />
                <JsonPanel title="State" value={node.trigger.state} />
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function workflowFlowElements(
  steps: WorkflowStepRecord[],
  edges: WorkflowEdgeRecord[],
  triggers: WorkflowTriggerRecord[],
  triggerEdges: WorkflowTriggerEdgeRecord[],
  stepRuns: StepRunRecord[],
): { nodes: Node[]; edges: Edge[] } {
  const runsByStepId = new Map(
    stepRuns.map((stepRun) => [stringValue(stepRun.workflowStepId), stepRun]),
  );
  const nodes: Node[] = [];
  const rowGap = 150;
  const columnGap = 330;

  triggers.forEach((trigger, index) => {
    const status = trigger.enabled === false ? "disabled" : "ready";
    nodes.push({
      id: `trigger:${stringValue(trigger.id)}`,
      data: {
        label: (
          <GraphNodeLabel
            detail={stringValue(trigger.type) || "trigger"}
            status={status}
            title={stringValue(trigger.name) || "Trigger"}
          />
        ),
      },
      position: {
        x: numberValue(trigger.canvasX) ?? index * columnGap,
        y: numberValue(trigger.canvasY) ?? 0,
      },
      sourcePosition: Position.Right,
      style: graphNodeStyle(status),
      type: "default",
    });
  });

  steps.forEach((step, index) => {
    const run = runsByStepId.get(stringValue(step.id));
    const status = stringValue(run?.status) || "not_reached";
    const endpointKey = objectStorageObjectKey(step);
    nodes.push({
      id: stringValue(step.id) || `step:${index}`,
      data: {
        label: (
          <GraphNodeLabel
            detail={endpointKey || stringValue(step.actionPackageName)}
            meta={endpointKey ? stringValue(step.actionPackageName) : ""}
            status={status}
            title={displayStepName(step)}
          />
        ),
      },
      position: {
        x: numberValue(step.canvasX) ?? index * columnGap,
        y: numberValue(step.canvasY) ?? (triggers.length ? rowGap : 0),
      },
      sourcePosition: Position.Right,
      style: graphNodeStyle(status),
      targetPosition: Position.Left,
      type: "default",
    });
  });

  const semanticNodes = steps.map((step) => ({
    id: stringValue(step.id),
    enabled: step.enabled !== false,
    actionPackageName: stringValue(step.actionPackageName),
    inputBindings: jsonRecord(step.inputBindings),
    definition: workflowNodeDefinition({
      actionPackageName: stringValue(step.actionPackageName),
    }),
  }));
  const presentationEdges = normalizeWorkflowEdges({
    nodes: semanticNodes,
    edges: edges.map((edge, index) => ({
      id: stringValue(edge.id) || `runtime:${index}`,
      fromStepId: stringValue(edge.fromStepId),
      toStepId: stringValue(edge.toStepId),
    })),
  });

  const flowEdges: Edge[] = [
    ...triggerEdges.map((edge) => ({
      id: stringValue(edge.id) || `${edge.triggerId}:${edge.toStepId}`,
      markerEnd: { type: MarkerType.ArrowClosed },
      source: `trigger:${stringValue(edge.triggerId)}`,
      target: stringValue(edge.toStepId),
      type: "smoothstep",
    })),
    ...presentationEdges.map((edge) => {
      return {
        id: edge.id,
        markerEnd: { type: MarkerType.ArrowClosed },
        source: edge.visualSource,
        target: edge.visualTarget,
        type: "smoothstep",
      };
    }),
  ];

  return { nodes, edges: flowEdges };
}

function graphNodeDetails(
  nodeId: string,
  steps: WorkflowStepRecord[],
  triggers: WorkflowTriggerRecord[],
  stepRuns: StepRunRecord[],
): GraphNodeDetails | null {
  if (nodeId.startsWith("trigger:")) {
    const triggerId = nodeId.slice("trigger:".length);
    const trigger = triggers.find((item) => stringValue(item.id) === triggerId);
    if (!trigger) {
      return null;
    }
    return {
      kind: "trigger",
      id: triggerId,
      title: stringValue(trigger.name) || "Trigger",
      subtitle: stringValue(trigger.type) || "trigger",
      trigger,
    };
  }

  const step = steps.find((item) => stringValue(item.id) === nodeId);
  if (!step) {
    return null;
  }
  const run = stepRuns.find(
    (item) => stringValue(item.workflowStepId) === nodeId,
  );
  return {
    kind: "step",
    id: nodeId,
    title: displayStepName(step),
    subtitle: stringValue(step.actionPackageName) || "step",
    step,
    run,
  };
}

function GraphNodeLabel({
  detail,
  meta,
  status,
  title,
}: {
  detail: string;
  meta?: string;
  status: string;
  title: string;
}) {
  return (
    <div className="grid gap-1 text-left">
      <div className="flex items-center gap-1.5">
        <StatusIcon className="h-3.5 w-3.5" status={status} />
        <span className="truncate text-sm font-semibold">{title}</span>
      </div>
      <div
        className="max-w-[190px] truncate text-xs text-muted-foreground"
        title={detail}
      >
        {detail}
      </div>
      {meta ? (
        <div className="truncate text-[11px] text-muted-foreground">{meta}</div>
      ) : null}
    </div>
  );
}

function graphNodeStyle(status: string): React.CSSProperties {
  const tone = graphTone(status);
  return {
    background: tone.background,
    border: `1px solid ${tone.border}`,
    borderRadius: 8,
    color: "hsl(var(--foreground))",
    minWidth: 220,
    padding: 10,
  };
}
