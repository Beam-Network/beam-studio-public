import {
  pgOne,
  WorkflowAuthorizationError,
  WorkflowAuthorityUnavailableError,
  type PgClient,
  type PgPool,
} from "@beam-studio/db";
import type { DistributedMember } from "@beam-studio/core";
import type { FrozenAggregationArtifactInput } from "./frozenAggregationPlan.js";

async function runCapability(pool: PgClient | PgPool, runId: string) {
  const capability = await pgOne<{ authorization_token: string }>(
    pool,
    "SELECT authorization_token FROM execution.workflow_run_capabilities WHERE workflow_run_id=$1",
    [runId],
  );
  const base = process.env.BEAM_STUDIO_API_URL?.trim();
  if (!base || !capability?.authorization_token)
    throw new WorkflowAuthorityUnavailableError(
      "v3_controller_unavailable",
      "V3 room execution requires the private Studio controller boundary.",
    );
  return { base, token: capability.authorization_token };
}

async function privateV3Request(
  pool: PgClient | PgPool,
  runId: string,
  suffix: string,
  body?: Record<string, unknown>,
) {
  const { base, token } = await runCapability(pool, runId);
  let response: Response;
  try {
    response = await fetch(
      new URL(
        `/internal/workflow-runs/${encodeURIComponent(runId)}/${suffix}`,
        base,
      ),
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new WorkflowAuthorityUnavailableError("v3_controller_unavailable");
  }
  if (response.status >= 500)
    throw new WorkflowAuthorityUnavailableError("v3_controller_unavailable");
  if (!response.ok)
    throw new WorkflowAuthorizationError(
      "v3_controller_denied",
      `Private V3 room authorization failed (${response.status}).`,
    );
  return response.json() as Promise<unknown>;
}

/** The API authenticates the run capability, room controller and grants. */
export async function resolveFrozenV3RoomPg(
  pool: PgClient | PgPool,
  runId: string,
) {
  const value = (await privateV3Request(pool, runId, "v3-room-resolution")) as {
    membersByPartition?: Record<string, DistributedMember[]>;
  };
  if (
    !value?.membersByPartition ||
    typeof value.membersByPartition !== "object" ||
    Array.isArray(value.membersByPartition)
  )
    throw new Error("Private V3 room resolution is invalid.");
  return { membersByPartition: value.membersByPartition };
}

/** Rechecks current read authority just before a routed input is admitted. */
export async function authorizeV3ArtifactReadPg(
  pool: PgClient | PgPool,
  runId: string,
  consumerMemberId: string,
  artifact: FrozenAggregationArtifactInput,
) {
  await privateV3Request(pool, runId, "v3-artifact-read", {
    consumerMemberId,
    artifact,
  });
}

/** Dispatch signals carry no task input or database credential; the API reads the frozen run. */
export async function dispatchRoomMemberTaskPg(pool: PgPool, taskId: string) {
  const task = await pgOne<Record<string, unknown>>(
    pool,
    `SELECT s.resolved_placement,c.authorization_token FROM execution.workflow_tasks t
    JOIN execution.workflow_step_runs s ON s.id=t.workflow_step_run_id
    LEFT JOIN execution.workflow_run_capabilities c ON c.workflow_run_id=t.workflow_run_id WHERE t.id=$1`,
    [taskId],
  );
  if (task?.resolved_placement !== "room-members") return false;
  const base = process.env.BEAM_STUDIO_API_URL?.trim();
  if (!base || !task.authorization_token)
    throw new Error(
      "Room-member execution requires the Studio API and a scoped run capability.",
    );
  const response = await fetch(
    new URL(
      `/internal/workflow-tasks/${encodeURIComponent(taskId)}/room-member/dispatch`,
      base,
    ),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${task.authorization_token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    const value = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    throw new Error(
      String(
        value.error ??
          value.code ??
          `Room-member dispatch failed (${response.status}).`,
      ),
    );
  }
  return true;
}
