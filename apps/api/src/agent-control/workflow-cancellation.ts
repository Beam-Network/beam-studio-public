import type { PgPool } from "@beam-studio/db";
import { roomWorkflowConfigSchema } from "@beam-studio/shared";
import type { AgentControlRepository } from "./repository.js";
import type { AgentGateway } from "./gateway.js";
import type { RoomStorageTransferManager } from "./room-storage-transfer-manager.js";
import {
  cancelWorkflowRoomPublication,
  recordWorkflowResourceState,
  terminalRoomResourceState,
} from "./workflow-resource-cleanup.js";

type Row = Record<string, any>;

export async function reconcileRoomWorkflowCancellations(
  pool: PgPool,
  repository: AgentControlRepository,
  gateway: AgentGateway,
  storageTransfers?: RoomStorageTransferManager,
) {
  const rows =
    await pool.query<Row>(`SELECT s.id,s.workflow_step_id,r.resolved_steps_json,r.organization_id,r.project_id
    FROM execution.workflow_step_runs s JOIN execution.workflow_runs r ON r.id=s.workflow_run_id
    WHERE s.action_package_name='@beam/room-transfer' AND s.resource_execution_json->>'state'='active'
      AND (s.status IN ('cancelled','failed') OR r.status IN ('cancel_requested','cancelled','failed')
        OR EXISTS(SELECT 1 FROM execution.executor_assignments a WHERE a.workflow_step_run_id=s.id AND a.cancel_requested_at IS NOT NULL AND a.cleanup_confirmed_at IS NULL))
    ORDER BY s.updated_at LIMIT 100`);
  const outcomes = await Promise.allSettled(
    rows.rows.map(async (row) => {
      const config = roomWorkflowConfigSchema.parse(
        (row.resolved_steps_json as Row[]).find(
          (step) => step.id === row.workflow_step_id,
        )?.config,
      );
      const prior = (
        await pool.query<Row>(
          `SELECT * FROM agent_control.commands WHERE organization_id=$1 AND operation='room.channel.object.cancel'
      AND payload_json->>'publication_key'=$2 ORDER BY created_at DESC LIMIT 1`,
          [row.organization_id, `workflow-step:${row.id}`],
        )
      ).rows[0];
      const terminal =
        prior?.state === "completed"
          ? terminalRoomResourceState(prior.result_json)
          : null;
      if (terminal) {
        await recordWorkflowResourceState(pool, row.id, terminal);
        return;
      }
      if (
        prior?.state === "failed" &&
        String(prior.error_json?.code ?? "") === "not_found"
      ) {
        await recordWorkflowResourceState(pool, row.id, "failed");
        return;
      }
      if (
        prior &&
        !["completed", "failed", "expired", "cancelled"].includes(
          prior.state,
        ) &&
        Date.parse(prior.expires_at) > Date.now()
      ) {
        await gateway.dispatchAgent(prior.agent_id);
        return;
      }
      await cancelWorkflowRoomPublication(
        pool,
        repository,
        gateway,
        storageTransfers,
        {
          organizationId: row.organization_id,
          projectId: row.project_id,
          stepRunId: row.id,
          roomId: config.roomId,
          channelId: config.channelId,
          // Concurrent reconcilers and uncertain commits reuse the same durable successor.
          requestId: `control-${prior?.id ?? "initial"}`,
        },
      );
    }),
  );
  const errors = outcomes.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(
      errors,
      "Room cancellation reconciliation failures",
    );
}
