import {
  previewWorkflowActionLockChanges,
  updateWorkflowGraph,
  workflowActionLockConfirmationError,
  type WorkflowGraphStepInput,
  type WorkflowGraphEdgeInput,
  type WorkflowGraphTriggerInput,
  type WorkflowGraphTriggerEdgeInput,
  type WorkflowGraphDecisionInput,
  type WorkflowGraphDecisionEdgeInput,
} from "./store.js";

type GraphWrite = Parameters<typeof updateWorkflowGraph>[0];

function array<T>(value: unknown, label: string, optional = false): T[] {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value)) {
    const error = new Error(`${label} must be an array.`) as Error & {
      code: string;
      statusCode: number;
    };
    error.code = "workflow_graph_invalid";
    error.statusCode = 400;
    throw error;
  }
  return value as T[];
}

/** Both the Studio route and MCP replace the full graph through this boundary. */
export async function saveWorkflowGraph(input: {
  organizationId: string | null;
  workflowTemplateId: string;
  body: Record<string, unknown>;
}) {
  const { organizationId, workflowTemplateId, body } = input;
  const steps = array<WorkflowGraphStepInput>(body.steps, "steps", true);
  const edges = array<WorkflowGraphEdgeInput>(body.edges, "edges", true);
  const controls = array<unknown>(body.controls, "controls", true);
  const triggers = array<WorkflowGraphTriggerInput>(
    body.triggers,
    "triggers",
    true,
  );
  const triggerEdges = array<WorkflowGraphTriggerEdgeInput>(
    body.triggerEdges,
    "triggerEdges",
    true,
  );
  const decisions = array<WorkflowGraphDecisionInput>(
    body.decisions,
    "decisions",
    true,
  );
  const decisionEdges = array<WorkflowGraphDecisionEdgeInput>(
    body.decisionEdges,
    "decisionEdges",
    true,
  );
  if (
    ![true, "true", "on", "1"].some(
      (value) => value === body.confirmActionLockChanges,
    )
  ) {
    const changes = await previewWorkflowActionLockChanges({
      organizationId,
      workflowTemplateId,
      steps,
    });
    if (changes.length) throw workflowActionLockConfirmationError(changes);
  }
  return updateWorkflowGraph({
    organizationId,
    workflowTemplateId,
    room: body.room as GraphWrite["room"],
    inputSchema: body.inputSchema as GraphWrite["inputSchema"],
    failurePolicy: body.failurePolicy as GraphWrite["failurePolicy"],
    output: body.output as GraphWrite["output"],
    agentBindings: body.agentBindings as GraphWrite["agentBindings"],
    resourceBindings: body.resourceBindings as GraphWrite["resourceBindings"],
    graphVersion: body.graphVersion,
    distribution: body.distribution,
    controls,
    triggers,
    triggerEdges,
    decisions,
    decisionEdges,
    steps,
    edges,
  });
}
