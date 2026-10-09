import {
  reconcileConfirmedRoomCancellationErrorPg,
  withPostgresTransaction,
  type PgPool,
} from "@beam-studio/db";
import { createHash } from "node:crypto";
import type { AgentControlRepository } from "./repository.js";
import type { AgentGateway } from "./gateway.js";
import type { RoomStorageTransferManager } from "./room-storage-transfer-manager.js";
import { fullRoomDeliveryVerified } from "./room-delivery-evidence.js";

type RoomIdleLeaseScope = {
  taskId: string;
  claimToken: string;
  attempt: number;
  stepRunId: string;
  publicationId: string;
  roomId: string;
  channelId: string;
  sourceMemberId: string;
};

/** Only a Coordinator-read status for this exact workflow publication can extend execution. */
export function verifiedRoomIdleDeadline(
  status: unknown,
  scope: RoomIdleLeaseScope,
  now = Date.now(),
): string | null {
  if (!status || typeof status !== "object") return null;
  const publisher = (status as Record<string, any>).publisher;
  const preflight = publisher?.preflight;
  const transfer = publisher?.room_transfer;
  const deadline = transfer?.idle_expires_at;
  const deadlineMs = typeof deadline === "string" ? Date.parse(deadline) : NaN;
  const keyDigest = createHash("sha256")
    .update(`workflow-step:${scope.stepRunId}`)
    .digest("hex");
  if (
    preflight?.publication_id !== scope.publicationId ||
    preflight?.publication_key_sha256 !== keyDigest ||
    preflight?.room_id !== scope.roomId ||
    preflight?.channel_id !== scope.channelId ||
    preflight?.publisher_member_id !== scope.sourceMemberId ||
    transfer?.transfer_id !== scope.publicationId ||
    !["pending", "in_progress"].includes(transfer?.status) ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= now ||
    deadlineMs > now + 310_000
  )
    return null;
  return new Date(deadlineMs).toISOString();
}

export async function recordVerifiedRoomIdleLease(
  pool: PgPool,
  scope: RoomIdleLeaseScope,
  deadline: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE execution.workflow_step_runs step
     SET resource_execution_json=jsonb_set(COALESCE(step.resource_execution_json,'{}'::jsonb),
       '{trusted_idle_lease}',
       jsonb_build_object('publicationId',$2::text,'idleExpiresAt',$3::text,
         'taskId',$4::text,'attempt',$5::integer),true),updated_at=now()
     WHERE step.id=$1 AND step.state_json->>'publicationId'=$2
       AND step.resource_execution_json->>'state'='active'
       AND (step.resource_execution_json->'trusted_idle_lease' IS NULL
         OR step.resource_execution_json->'trusted_idle_lease'->>'publicationId'=$2)
       AND (step.resource_execution_json->'trusted_idle_lease'->>'idleExpiresAt' IS NULL
         OR (step.resource_execution_json->'trusted_idle_lease'->>'idleExpiresAt')::timestamptz < $3::timestamptz
         OR ((step.resource_execution_json->'trusted_idle_lease'->>'idleExpiresAt')::timestamptz = $3::timestamptz
           AND (step.resource_execution_json->'trusted_idle_lease'->>'taskId' IS DISTINCT FROM $4
             OR (step.resource_execution_json->'trusted_idle_lease'->>'attempt')::integer IS DISTINCT FROM $5)))
       AND EXISTS (SELECT 1 FROM execution.workflow_tasks task
         JOIN execution.workflow_runs run ON run.id=task.workflow_run_id
         WHERE task.id=$4 AND task.workflow_step_run_id=step.id
           AND task.attempt_count=$5 AND task.claim_token=$6
           AND task.status='running' AND task.lease_expires_at>now()
           AND run.status='running')
     RETURNING step.id`,
    [
      scope.stepRunId,
      scope.publicationId,
      deadline,
      scope.taskId,
      scope.attempt,
      scope.claimToken,
    ],
  );
  return Boolean(result.rowCount);
}

export function terminalRoomResourceState(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, any>;
  if (value.storage?.errorCode === "room_storage_cleanup_incomplete")
    return null;
  const publication = value.object;
  if (publication && typeof publication === "object") {
    const state = publication.state;
    if (state === "completed") {
      if (
        (publication.room_transfer ?? publication.publisher?.room_transfer)
          ?.status === "partial"
      )
        return "partial";
      return fullRoomDeliveryVerified(publication) ? "completed" : "unverified";
    }
    if (["failed", "expired", "cancelled"].includes(state)) return state;
  }
  const storage = value.storage;
  if (
    storage &&
    typeof storage === "object" &&
    storage.errorCode !== "room_storage_cleanup_incomplete" &&
    ["completed", "partial", "cancelled"].includes(storage.status)
  ) {
    return storage.status === "completed" ? "unverified" : storage.status;
  }
  return null;
}

export async function recordWorkflowResourceState(
  pool: PgPool,
  stepRunId: string,
  state: string,
) {
  const sql = `UPDATE execution.workflow_step_runs SET resource_execution_json=jsonb_build_object('kind','room-publication','state',$2::text,'observedAt',now()),
    state_json=state_json||jsonb_build_object('cancellationStatus','confirmed','beamStatus',$2::text,'cancellationError',NULL),updated_at=now() WHERE id=$1`;
  if (state !== "cancelled") {
    await pool.query(sql, [stepRunId, state]);
    return;
  }
  await withPostgresTransaction(pool, async (client) => {
    await client.query(sql, [stepRunId, state]);
    await reconcileConfirmedRoomCancellationErrorPg(client, stepRunId);
  });
}

export async function recordWorkflowResourceActive(
  pool: PgPool,
  stepRunId: string,
) {
  await pool.query(
    `UPDATE execution.workflow_step_runs SET resource_execution_json=COALESCE(resource_execution_json,'{}'::jsonb)||jsonb_build_object('kind','room-publication','state','active','observedAt',now()),
    state_json=state_json||jsonb_build_object('beamStatus','active'),updated_at=now() WHERE id=$1`,
    [stepRunId],
  );
}

/** Cleanup uses the previously authorized publication identity, never current membership discovery. */
export async function cancelWorkflowRoomPublication(
  pool: PgPool,
  repository: AgentControlRepository,
  gateway: AgentGateway,
  storageTransfers: RoomStorageTransferManager | undefined,
  input: {
    organizationId: string;
    projectId?: string | null;
    stepRunId: string;
    roomId: string;
    channelId: string;
    requestId: string;
  },
) {
  const storageJob = await storageTransfers?.workflowStatus(input.stepRunId);
  if (storageJob) {
    const result =
      ["completed", "partial", "cancelled"].includes(storageJob.status) &&
      storageJob.errorCode !== "room_storage_cleanup_incomplete"
        ? storageJob
        : await storageTransfers!.cancelAndWait(input.stepRunId);
    if (result.errorCode === "room_storage_cleanup_incomplete")
      throw new Error("Room storage cleanup remains unconfirmed.");
    await recordWorkflowResourceState(
      pool,
      input.stepRunId,
      result.status === "completed" ? "unverified" : result.status,
    );
    return {
      id: result.publicationId || result.id,
      state: "completed",
      result: { object: { state: result.status }, storage: result },
    };
  }
  const publication = (
    await pool.query<Record<string, any>>(
      `SELECT agent_id,payload_json FROM agent_control.commands WHERE organization_id=$1
    AND operation='room.channel.object.publish' AND payload_json->>'publication_key'=$2 AND payload_json->>'room_id'=$3 AND payload_json->>'channel_id'=$4 ORDER BY created_at LIMIT 1`,
      [
        input.organizationId,
        `workflow-step:${input.stepRunId}`,
        input.roomId,
        input.channelId,
      ],
    )
  ).rows[0];
  if (!publication?.agent_id || !publication.payload_json)
    throw new Error(
      "Publication dispatch is not recorded; cleanup remains unconfirmed.",
    );
  const command = await repository.createCommand({
    organizationId: input.organizationId,
    projectId: input.projectId,
    agentId: publication.agent_id,
    operation: "room.channel.object.cancel",
    idempotencyKey: `${input.stepRunId}:cancel:${input.requestId}`,
    ttlSeconds: 60,
    payload: {
      room_id: input.roomId,
      channel_id: input.channelId,
      coordinator_url: publication.payload_json.coordinator_url,
      publication_key: `workflow-step:${input.stepRunId}`,
    },
  });
  await gateway.dispatchAgent(publication.agent_id);
  return command;
}
