import type { WorkflowBundle } from "./workflow-graph-types";

export function workflowDefinitionFromBundle(workflow: WorkflowBundle) {
  return {
    schemaVersion: "workflow-definition/v1",
    template: {
      name: workflow.template.name,
      description: workflow.template.description,
      enabled: workflow.template.enabled,
    },
    triggers: workflow.triggers.map((trigger) => ({
      id: trigger.id,
      type: trigger.type,
      name: trigger.name,
      enabled: trigger.enabled,
      config: trigger.config,
      state: trigger.state,
      canvasX: trigger.canvasX,
      canvasY: trigger.canvasY,
    })),
    triggerEdges: workflow.triggerEdges.map((edge) => ({
      id: edge.id,
      triggerId: edge.triggerId,
      toStepId: edge.toStepId,
      condition: edge.condition,
    })),
    steps: workflow.steps.map((step) => ({
      id: step.id,
      actionPackageName: step.actionPackageName,
      actionVersionRange: step.actionVersionRange,
      position: step.position,
      enabled: step.enabled,
      config: step.config,
      inputBindings: step.inputBindings,
      placement: step.placement,
      executionTarget: step.executionTarget,
      executionLocationId: step.executionLocationId,
      canvasX: step.canvasX,
      canvasY: step.canvasY,
      timeoutSeconds: step.timeoutSeconds,
      required: step.required,
    })),
    edges: workflow.edges.map((edge) => ({
      id: edge.id,
      fromStepId: edge.fromStepId,
      toStepId: edge.toStepId,
      condition: edge.condition,
    })),
    ...(workflow.graph.version === "workflow-graph/v3"
      ? {
          graphVersion: workflow.graph.version,
          controls: workflow.graph.controls,
          distribution: workflow.graph.distribution,
        }
      : {}),
  };
}
