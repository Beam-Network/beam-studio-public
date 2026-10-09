import {
  captureWorkflowTreePg,
  enqueueFrozenWorkflowRunPg,
  pgOne,
  withPostgresTransaction,
  type PgPool,
} from "@beam-studio/db";
import {
  formatTraceparent,
  type TraceContext,
} from "@beam-studio/telemetry";
import { assertWorkflowStudioRunnersAvailablePg } from "./workflow-runner-availability.js";
import { configuredV3LaunchGate } from "../agent-control/v3-room-resolution.js";

export async function startWorkflowRunPg(
  pool: PgPool,
  workflowTemplateId: string,
  runtimeInput: Record<string, unknown> = {},
  observability: {
    organizationId?: string;
    initiatingPrincipalId?: string | null;
    traceContext?: TraceContext | null;
  } = {},
) {
  const v3Launch = configuredV3LaunchGate();
  return withPostgresTransaction(pool, async (client) => {
    const owner = await pgOne<{ organization_id: string }>(
      client,
      "SELECT organization_id FROM workflow.templates WHERE id=$1 AND ($2::text IS NULL OR organization_id=$2)",
      [workflowTemplateId, observability.organizationId ?? null],
    );
    if (!owner) throw new Error("Workflow template not found.");
    const tree = await captureWorkflowTreePg(client, {
      admission: true,
      organizationId: owner.organization_id,
      workflowTemplateId,
      v3Launch,
    });
    await assertWorkflowStudioRunnersAvailablePg(client, tree);
    return enqueueFrozenWorkflowRunPg(client, {
      definition: tree.root,
      definitions: tree.definitions,
      runtimeInput,
      trigger: "api",
      executionContext: {
        organizationId: owner.organization_id,
        projectId: tree.root.projectId,
        trigger: "api",
        initiatingPrincipalId: observability.initiatingPrincipalId ?? null,
      },
      metadata: {
        observability: observability.traceContext
          ? { traceparent: formatTraceparent(observability.traceContext) }
          : {},
      },
      v3Launch,
    });
  });
}
