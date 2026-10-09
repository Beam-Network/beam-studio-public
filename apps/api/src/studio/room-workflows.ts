import { createHash } from "node:crypto";
import { requireRoomTransferAction } from "./room-transfer-action-state.js";
import {
  roomTransferActionVersion,
  roomWorkflowConfigSchema,
  resolveActionRoomContext,
  workflowRoomContext,
} from "@beam-studio/shared";
import {
  createWorkflowTemplate,
  getWorkflowRun,
  getWorkflowTemplate,
  updateWorkflowGraph,
  deleteWorkflowTemplate,
  retryWorkflowRun,
  startWorkflowRun,
} from "./store.js";
import { StudioValidationError } from "./validation-error.js";

export async function createRoomWorkflow(input: {
  organizationId: string;
  projectId?: string | null;
  name: string;
  apiKeyId: string;
  requestId: string;
  config: unknown;
}) {
  const config = roomWorkflowConfigSchema.parse(input.config);
  await requireRoomTransferAction();
  if (!input.requestId || input.requestId.length > 160)
    throw new StudioValidationError(
      "request_id_required",
      "A stable requestId is required.",
      { field: "requestId" },
    );
  const suffix = createHash("sha256")
    .update(`${input.organizationId}:${input.requestId}`)
    .digest("hex")
    .slice(0, 32);
  const id = `wft_room_${suffix}`,
    stepId = `wfs_room_${suffix}`,
    triggerId = `wftg_room_${suffix}`;
  const existing = await getWorkflowTemplate(id, input.organizationId);
  if (existing) {
    if (
      JSON.stringify(
        roomWorkflowConfigSchema.parse(existing.steps[0]?.config),
      ) !== JSON.stringify(config)
    )
      throw new Error(
        "Room workflow requestId conflicts with another configuration.",
      );
    return { id };
  }
  await createWorkflowTemplate({
    id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    name: input.name,
    apiKeyId: input.apiKeyId,
  });
  try {
    await updateWorkflowGraph({
      workflowTemplateId: id,
      organizationId: input.organizationId,
      steps: [
        {
          id: stepId,
          actionPackageName: "@beam/room-transfer",
          actionVersionRange: roomTransferActionVersion,
          enabled: true,
          config,
          inputBindings: {},
          position: 0,
          placement: "local-workers",
          required: true,
          executionLocationId: null,
          canvasX: 300,
          canvasY: 0,
          timeoutSeconds: null,
        },
      ],
      edges: [],
      triggers: [
        {
          id: triggerId,
          type: "manual",
          name: "Manual",
          enabled: true,
          config: {},
          canvasX: 0,
          canvasY: 0,
        },
      ],
      triggerEdges: [
        {
          id: `wfte_room_${suffix}`,
          triggerId,
          toStepId: stepId,
          condition: null,
        },
      ],
    });
  } catch (error) {
    await deleteWorkflowTemplate(id, input.organizationId);
    throw error;
  }
  return { id };
}

export async function retryBilledWorkflow(
  runId: string,
  organizationId: string,
) {
  const run = await getWorkflowRun(runId, organizationId);
  if (!run) throw new Error("Workflow run not found.");
  if (!run.template) throw new Error("Frozen workflow definition not found.");
  assertRoomWorkflowServicesAvailable({
    template: { room: run.run.room },
    steps: run.steps,
  });
  return { runId: await retryWorkflowRun(runId, organizationId) };
}

export async function runBilledWorkflow(
  id: string,
  organizationId: string,
  input: Record<string, unknown> = {},
  principal: {
    initiatingPrincipalId?: string | null;
    mcpTokenId?: string | null;
  } = {},
) {
  const workflow = await getWorkflowTemplate(id, organizationId);
  if (!workflow) throw new Error("Workflow not found.");
  assertRoomWorkflowServicesAvailable(workflow);
  return {
    runId: await startWorkflowRun(id, organizationId, {
      ...principal,
      runtimeInput: input,
    }),
  };
}

/** Room steps must resolve to a complete room binding before a run starts.
 * Coordinator access itself is authorized per request with the user's session. */
export function assertRoomWorkflowServicesAvailable(workflow: {
  template?: { room?: unknown };
  steps?: unknown[];
}) {
  const room = workflowRoomContext(workflow.template?.room);
  for (const candidate of workflow.steps ?? []) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      continue;
    const step = candidate as Record<string, unknown>;
    const actionPackage =
      step.actionPackageName ??
      step.action_package_name ??
      step.actionPackage ??
      step.action_package;
    if (actionPackage !== "@beam/room-transfer") continue;
    roomWorkflowConfigSchema.parse(
      resolveActionRoomContext({
        workflowRoom: room,
        actionPackage,
        config: step.config as Record<string, unknown>,
      }).config,
    );
  }
}

export async function assertRoomWorkflowRunServicesAvailable(
  runId: string,
  organizationId: string | null,
) {
  const run = await getWorkflowRun(runId, organizationId);
  if (!run) throw new Error("Workflow run not found.");
  assertRoomWorkflowServicesAvailable({
    template: { room: run.run.room },
    steps: run.steps,
  });
}
