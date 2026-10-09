import { shortId } from "./workflow-graph-model";
import type { WorkflowBundle } from "./workflow-graph-types";

export type WorkflowTemplateId = "blank" | "simple-transfer";

export const workflowTemplates: Array<{
  description: string;
  id: WorkflowTemplateId;
  title: string;
}> = [
  {
    description: "Start with a minimal workflow and build the graph yourself.",
    id: "blank",
    title: "Blank canvas",
  },
  {
    description:
      "Create a source endpoint, a destination endpoint, and a Beam Transfer step.",
    id: "simple-transfer",
    title: "Simple transfer",
  },
];

export function isWorkflowTemplateId(
  value: string | null | undefined,
): value is WorkflowTemplateId {
  return workflowTemplates.some((template) => template.id === value);
}

/**
 * The editor draft a new workflow starts from, or null when the template adds
 * nothing to the workflow Studio created.
 *
 * A template is a draft, not a saved graph: its endpoints have no bucket or
 * credential yet, which the API refuses to save, so the customer completes the
 * steps in the editor and saves them. The draft reuses the manual trigger
 * Studio adds to every new workflow and connects it to the steps that start
 * the run. Step and edge ids are unique across the Studio database, so every
 * draft mints fresh ones.
 */
export function workflowTemplateDraft(
  workflow: WorkflowBundle,
  templateId: WorkflowTemplateId,
): WorkflowBundle | null {
  if (templateId !== "simple-transfer") {
    return null;
  }

  const workflowTemplateId = workflow.template.id;
  const trigger = workflow.triggers[0] ?? {
    id: `wftg_${shortId()}`,
    workflowTemplateId,
    type: "manual",
    name: "Trigger manually",
    enabled: true,
    config: {},
    state: {},
    canvasX: -260,
    canvasY: 250,
  };
  const sourceId = `wfs_${shortId()}`;
  const destinationId = `wfs_${shortId()}`;
  const transferId = `wfs_${shortId()}`;
  const endpointStep = (
    id: string,
    name: string,
    position: number,
    canvasY: number,
  ) => ({
    id,
    actionPackageName: "@beam/object-storage-endpoint",
    actionVersionRange: "^1.0.0",
    canvasX: 80,
    canvasY,
    config: {
      name,
      provider: "s3",
      bucket: "",
      objectKey: "",
      sourceType: "file",
      credentialId: "",
    },
    enabled: true,
    executionLocationId: null,
    inputBindings: {},
    manifest: null,
    placement: "local-workers",
    position,
    required: false,
    timeoutSeconds: null,
  });

  return {
    ...workflow,
    triggers: [trigger],
    triggerEdges: [sourceId, destinationId].map((toStepId) => ({
      id: `wfte_${trigger.id}_${toStepId}_${shortId()}`,
      workflowTemplateId,
      triggerId: trigger.id,
      toStepId,
      condition: null,
    })),
    steps: [
      // Named as the editor names the endpoints it adds to a transfer. The
      // transfer, like any action the editor adds, has no name of its own, so
      // the canvas and its Name field show the action's: Beam Transfer.
      endpointStep(sourceId, "Source endpoint", 0, 140),
      endpointStep(destinationId, "Destination endpoint", 1, 360),
      {
        id: transferId,
        actionPackageName: "@beam/transfer",
        actionVersionRange: "^1.0.0",
        canvasX: 460,
        canvasY: 250,
        config: {
          credentialId: "",
        },
        enabled: true,
        executionLocationId: null,
        inputBindings: {
          destinationEndpoints: [`\${steps.${destinationId}.outputs.endpoint}`],
          sourceEndpoints: [`\${steps.${sourceId}.outputs.endpoint}`],
        },
        manifest: null,
        placement: "local-workers",
        position: 2,
        required: true,
        timeoutSeconds: null,
      },
    ],
    edges: [sourceId, destinationId].map((fromStepId) => ({
      id: `wfe_${fromStepId}_${transferId}_${shortId()}`,
      condition: null,
      fromStepId,
      toStepId: transferId,
    })),
  };
}
