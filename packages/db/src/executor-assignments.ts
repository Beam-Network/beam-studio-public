import {
  pgOne,
  withPostgresTransaction,
  type PgClient,
  type PgPool,
} from "./postgres.js";
import { randomUUID, createHash } from "node:crypto";
import {
  parseRetryPolicy,
  retryDelayMs,
  type ActionResult,
} from "@beam-studio/core";
import { actionResultSchema } from "@beam-studio/shared";
import {
  authorizeWorkflowExecutionPg,
  type WorkflowExecutionAuthorizer,
} from "./workflow-authorization.js";
import {
  ArtifactAcceptanceError,
  assessRoomArtifactResult,
  persistArtifactAssessmentPg,
  type CoreArtifactTransferEvidence,
  type ProviderArtifactEvidence,
} from "./room-artifact-acceptance.js";

export type ExecutorBackendKind =
  | "studio"
  | "room-member"
  | "remote-transport"
  | "external-worker";
export type ExecutorClaim = {
  taskId: string;
  attempt: number;
  claimToken: string;
};

/** All backends fence state/result writes against the same durable invocation. */
export async function lockExecutorClaimPg(
  client: PgClient,
  claim: ExecutorClaim,
  cleanup = false,
) {
  const task = await pgOne<Record<string, any>>(
    client,
    `SELECT t.*, clock_timestamp() AS database_now, r.status AS run_status, r.resolved_steps_json,
    s.status AS step_status, s.state_json AS step_state, s.resource_execution_json AS resource_execution, to_jsonb(a) AS assignment,
    authority.generation AS current_authority_generation,
    authority.lease_expires_at>clock_timestamp() AS authority_lease_valid,
    (a.backend<>'studio' OR EXISTS(SELECT 1 FROM runtime.worker_runtime_state runner
      WHERE runner.worker_id=a.executor_id AND runner.status IN ('active','draining')
      AND runner.heartbeat_at>=clock_timestamp()-interval '30 seconds'
      AND (runner.organization_id IS NULL OR runner.organization_id=r.organization_id)
      AND (runner.project_id IS NULL OR runner.project_id=r.project_id))) AS executor_scope_authorized
    FROM execution.workflow_tasks t JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
    JOIN execution.workflow_step_runs s ON s.id=t.workflow_step_run_id
    JOIN execution.executor_assignments a ON a.task_id=t.id AND a.attempt=t.attempt_count
    LEFT JOIN execution.workflow_run_authority authority ON authority.workflow_run_id=r.id
    WHERE t.id=$1 AND t.attempt_count=$2 AND t.claim_token=$3
      AND a.cleanup_confirmed_at IS NULL
      AND ($4 OR (t.status='running' AND t.lease_expires_at>clock_timestamp() AND a.lease_expires_at>clock_timestamp()
        AND a.authority_generation=authority.generation AND authority.lease_expires_at>clock_timestamp()
        AND a.cancel_requested_at IS NULL AND r.status IN ('queued','running') AND s.status IN ('queued','running')))
    FOR UPDATE OF t,r,s,a`,
    [claim.taskId, claim.attempt, claim.claimToken, cleanup],
  );
  return !cleanup && task && !task.executor_scope_authorized ? undefined : task;
}

export type ExecutorOutcome = {
  status: "completed" | "failed" | "cancelled";
  result?: ActionResult;
  error?: { code?: string; message: string; retryable?: boolean };
  executorStopped: boolean;
  coreArtifactEvidence?: readonly CoreArtifactTransferEvidence[];
  providerArtifactEvidence?: readonly ProviderArtifactEvidence[];
};
export type ExecutorCancellation = {
  code?: string;
  message: string;
  retryable?: boolean;
};

const staleClaimWriteError =
  "Workflow state write rejected: execution claim expired or cancelled.";

/** An uncertain external effect is never replayed without a proven stable
 * idempotency key. Existing v1 actions keep their historical retry policy. */
export function actionAllowsAutomaticRetry(
  step: Record<string, any> | null | undefined,
) {
  const manifest = step?.manifestSnapshot;
  if (manifest?.apiVersion !== "workflow-actions/v2") return true;
  return (
    manifest.contracts?.recovery?.retry === "idempotent" &&
    manifest.contracts?.recovery?.externalEffects !== "non-idempotent"
  );
}

/** A provisional room-cleanup warning is superseded only by independent terminal evidence. */
export function executorErrorAfterResourceCleanup(
  error: ExecutorCancellation | null | undefined,
  resource: { kind?: string; state?: string } | null | undefined,
) {
  return error?.code === "executor_cleanup_required" &&
    resource?.kind === "room-publication" &&
    ["completed", "partial", "failed", "cancelled", "expired"].includes(
      resource.state ?? "",
    )
    ? undefined
    : error;
}

/** A confirmed room cancellation must not surface a worker's stale claim error. */
export function confirmedRoomCancellationError(
  runStatus: string,
  resource: { kind?: string; state?: string } | null | undefined,
  assignmentError: ExecutorCancellation | null | undefined,
): ExecutorCancellation | null | undefined {
  if (
    !["cancel_requested", "cancelled"].includes(runStatus) ||
    resource?.kind !== "room-publication" ||
    resource.state !== "cancelled"
  )
    return undefined;
  const error = executorErrorAfterResourceCleanup(assignmentError, resource);
  return error?.code === "executor_cancelled" ||
    error?.message === staleClaimWriteError
    ? null
    : (error ?? null);
}

/** Resource confirmation may arrive after the worker has already settled. */
export async function reconcileConfirmedRoomCancellationErrorPg(
  client: PgClient,
  stepRunId: string,
) {
  await client.query(
    `WITH verified AS MATERIALIZED (
      SELECT a.id AS assignment_id,t.id AS task_id,t.attempt_count,s.id AS step_id
      FROM execution.executor_assignments a
      JOIN execution.workflow_tasks t ON t.id=a.task_id AND t.attempt_count=a.attempt
      JOIN execution.workflow_step_runs s ON s.id=t.workflow_step_run_id
      JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
      WHERE s.id=$1 AND r.status IN ('cancel_requested','cancelled') AND s.status='cancelled'
        AND t.status='cancelled' AND a.state='cancelled'
        AND a.executor_stopped_at IS NOT NULL AND a.cleanup_confirmed_at IS NOT NULL
        AND s.resource_execution_json->>'kind'='room-publication'
        AND s.resource_execution_json->>'state'='cancelled'
    ), assignment_errors AS (
      UPDATE execution.executor_assignments a SET error_json=NULL,updated_at=now()
      FROM verified v WHERE a.id=v.assignment_id AND a.error_json->>'message'=$2
    ), task_errors AS (
      UPDATE execution.workflow_tasks t SET error=NULL,updated_at=now()
      FROM verified v WHERE t.id=v.task_id AND t.error=$2
    ), attempt_errors AS (
      UPDATE execution.workflow_task_attempts t SET error=NULL
      FROM verified v WHERE t.workflow_task_id=v.task_id
        AND t.attempt_number=v.attempt_count AND t.error=$2
    )
    UPDATE execution.workflow_step_runs s SET error=NULL,updated_at=now()
    FROM verified v WHERE s.id=v.step_id AND s.error=$2`,
    [stepRunId, staleClaimWriteError],
  );
}

/** Call after authenticating the backend result and checking current authorization. */
export async function settleExecutorResultPg(
  client: PgClient,
  claim: ExecutorClaim,
  outcome: ExecutorOutcome,
) {
  const task = await lockExecutorClaimPg(client, claim, true);
  if (!task) return "stale" as const;
  const assignment = task.assignment;
  const authorityCurrent =
    String(assignment.authority_generation) ===
      String(task.current_authority_generation) &&
    task.authority_lease_valid === true;
  if (!outcome.executorStopped) return "deferred" as const;
  await recordExecutorStoppedPg(client, claim);
  if (task.resource_execution?.state === "active") {
    const deferredError = outcome.error ?? {
      code: "executor_cleanup_required",
      message: "Room publication cleanup remains unconfirmed.",
    };
    await client.query(
      `UPDATE execution.executor_assignments SET state='cancel_requested',cancel_requested_at=COALESCE(cancel_requested_at,now()),
      error_json=COALESCE(error_json,$2::jsonb),updated_at=now() WHERE id=$1`,
      [assignment.id, JSON.stringify(deferredError)],
    );
    return "deferred" as const;
  }
  const step = (task.resolved_steps_json as Record<string, any>[]).find(
    (value) => value.id === task.workflow_step_id,
  );
  const cancelled =
    (outcome.status === "cancelled" && !assignment.cancel_requested_at) ||
    !["queued", "running"].includes(task.run_status) ||
    !["queued", "running"].includes(task.step_status) ||
    assignment.error_json?.code === "executor_cancelled";
  const databaseNow = new Date(task.database_now).getTime();
  const leaseValid =
    new Date(task.lease_expires_at).getTime() > databaseNow &&
    new Date(assignment.lease_expires_at).getTime() > databaseNow;
  let success =
    outcome.status === "completed" &&
    task.executor_scope_authorized === true &&
    !cancelled &&
    !assignment.cancel_requested_at &&
    authorityCurrent &&
    leaseValid &&
    ["queued", "running"].includes(task.step_status);
  const result = success
    ? (actionResultSchema.parse(outcome.result ?? {}) as ActionResult)
    : null;
  let artifactError: ArtifactAcceptanceError | null = null;
  const resultMetadata = result?.metadata;
  if (
    success &&
    resultMetadata &&
    ["artifactInputs", "artifactPublications"].some((key) =>
      Object.hasOwn(resultMetadata, key),
    )
  ) {
    artifactError = new ArtifactAcceptanceError(
      "Result metadata cannot replace a frozen artifact plan.",
    );
    success = false;
  }
  if (
    success &&
    result &&
    (assignment.backend === "room-member" || result.artifactManifest)
  ) {
    let assessment: ReturnType<typeof assessRoomArtifactResult> = null;
    try {
      assessment = assessRoomArtifactResult(
        result,
        task.metadata_json?.artifactPublications,
        {
          workflowRunId: task.workflow_run_id,
          stepRunId: task.workflow_step_run_id,
          taskId: task.id,
          assignmentId: assignment.id,
          attempt: task.attempt_count,
        },
        new Date(task.database_now),
        outcome.coreArtifactEvidence,
        outcome.providerArtifactEvidence,
      );
    } catch (error) {
      artifactError =
        error instanceof ArtifactAcceptanceError
          ? error
          : new ArtifactAcceptanceError(
              error instanceof Error
                ? error.message
                : "Invalid artifact manifest.",
            );
      success = false;
    }
    if (assessment && !artifactError) {
      const saved = await persistArtifactAssessmentPg(client, {
        workflowRunId: task.workflow_run_id,
        stepRunId: task.workflow_step_run_id,
        taskId: task.id,
        assignmentId: assignment.id,
        attempt: task.attempt_count,
        result,
        assessment,
      });
      if (saved.status === "pending") {
        await client.query(
          `UPDATE execution.executor_assignments SET progress_json=progress_json||$2::jsonb,
           updated_at=now() WHERE id=$1`,
          [
            assignment.id,
            JSON.stringify({
              artifactPublication: "pending",
              reason: assessment.pendingReason,
            }),
          ],
        );
        return "deferred" as const;
      }
    }
  }
  let error: { code?: string; message: string; retryable?: boolean } | null =
    success
      ? null
      : artifactError
        ? {
            code: artifactError.code,
            message: artifactError.message,
            retryable: false,
          }
        : ((outcome.error?.retryable === false ? outcome.error : undefined) ??
          executorErrorAfterResourceCleanup(
            assignment.error_json,
            task.resource_execution,
          ) ??
          (!authorityCurrent
            ? {
                code: "executor_authority_superseded",
                message:
                  "Result came from an expired or superseded orchestration authority.",
                retryable: true,
              }
            : null) ??
          (!task.executor_scope_authorized
            ? {
                code: "execution_target_revoked",
                message:
                  "The assigned Studio Action Runner is no longer available in the permitted organization/project scope.",
                retryable: false,
              }
            : outcome.error) ?? {
            code: cancelled ? "executor_cancelled" : "executor_lease_expired",
            message: cancelled
              ? "Execution cancelled."
              : "Result rejected after the execution lease expired.",
            retryable: !cancelled,
          });
  if (!success && !artifactError) {
    const confirmedCancellationError = confirmedRoomCancellationError(
      task.run_status,
      task.resource_execution,
      assignment.error_json,
    );
    if (confirmedCancellationError !== undefined)
      error = confirmedCancellationError;
  }
  if (!success && error?.retryable && !actionAllowsAutomaticRetry(step))
    error = {
      code: "action_retry_policy_disallows_replay",
      message:
        "The frozen action recovery policy forbids replay without a proven idempotency key.",
      retryable: false,
    };
  const retry =
    !success &&
    !cancelled &&
    step?.required !== false &&
    actionAllowsAutomaticRetry(step) &&
    error?.retryable === true &&
    task.attempt_count < task.max_attempts;
  const state = success ? "completed" : cancelled ? "cancelled" : "failed";
  const taskState = retry
    ? "retry_scheduled"
    : success
      ? "completed"
      : cancelled
        ? "cancelled"
        : step?.required === false
          ? "failed"
          : "dead_letter";
  const outputs = success ? (result?.outputs ?? {}) : {};
  await finishExecutorAssignmentPg(
    client,
    assignment.id,
    state,
    success ? result : null,
    error?.message ?? null,
  );
  await client.query(
    `UPDATE execution.workflow_tasks SET status=$2,output_json=$3::jsonb,output_checksum=$4,error=$5,metadata_json=metadata_json||$6::jsonb,
    claim_token=NULL,leased_by=NULL,locked_by=NULL,lease_expires_at=NULL,lock_expires_at=NULL,
    scheduled_at=CASE WHEN $7 THEN now()+($8*interval '1 millisecond') ELSE scheduled_at END,completed_at=CASE WHEN $7 THEN NULL ELSE now() END,updated_at=now() WHERE id=$1`,
    [
      task.id,
      taskState,
      JSON.stringify(outputs),
      success
        ? createHash("sha256").update(JSON.stringify(outputs)).digest("hex")
        : null,
      error?.message ?? null,
      JSON.stringify(success ? (result?.metadata ?? {}) : {}),
      retry,
      retryDelayMs(
        parseRetryPolicy(task.retry_policy_json),
        task.attempt_count,
      ),
    ],
  );
  await client.query(
    "UPDATE execution.workflow_task_attempts SET status=$3,error=$4,completed_at=now() WHERE workflow_task_id=$1 AND attempt_number=$2",
    [
      task.id,
      task.attempt_count,
      taskState === "dead_letter" ? "dead_letter" : state,
      error?.message ?? null,
    ],
  );
  const finalTask = ["step", "step-reduce"].includes(task.task_kind);
  if (!success || finalTask)
    await client.query(
      `UPDATE execution.workflow_step_runs SET status=$2,output_json=$3::jsonb,error=$4,metadata_json=metadata_json||$5::jsonb,
    state_json=COALESCE($6::jsonb,state_json) || (state_json - ARRAY(SELECT jsonb_object_keys(state_json) EXCEPT SELECT unnest(ARRAY['cancellationControlCommandId','cancellationControlAttempt','cancellationReconciliationDone']))),
    external_ref=COALESCE($7,external_ref),completed_at=CASE WHEN $8 THEN NULL ELSE now() END,updated_at=now() WHERE id=$1 AND status IN ('queued','running')`,
      [
        task.workflow_step_run_id,
        retry ? "running" : state,
        JSON.stringify(outputs),
        error?.message ?? null,
        JSON.stringify({
          ...(success ? result?.metadata : {}),
          cleanupConfirmed: true,
        }),
        success && result?.state ? JSON.stringify(result.state) : null,
        success ? (result?.externalRef ?? null) : null,
        retry,
      ],
    );
  if (success && finalTask)
    for (const artifact of result?.artifacts ?? [])
      await client.query(
        `INSERT INTO execution.workflow_artifacts(id,workflow_run_id,workflow_step_run_id,type,name,uri,media_type,metadata_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          identifier("artifact"),
          task.workflow_run_id,
          task.workflow_step_run_id,
          artifact.type,
          artifact.name,
          artifact.uri,
          artifact.mediaType ?? null,
          JSON.stringify(artifact.metadata ?? {}),
        ],
      );
  if (taskState === "dead_letter")
    await client.query(
      `INSERT INTO execution.workflow_task_dead_letters(id,workflow_task_id,workflow_run_id,workflow_step_run_id,reason,error,attempts,max_attempts,payload_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(workflow_task_id) DO NOTHING`,
      [
        identifier("deadletter"),
        task.id,
        task.workflow_run_id,
        task.workflow_step_run_id,
        error?.retryable === true ? "max_attempts" : "non_retryable",
        error?.message ?? "Execution failed",
        task.attempt_count,
        task.max_attempts,
        JSON.stringify({ assignmentId: assignment.id }),
      ],
    );
  if (!success && !retry) {
    await client.query(
      `UPDATE execution.executor_assignments SET state='cancel_requested',cancel_requested_at=COALESCE(cancel_requested_at,now()),
      error_json=COALESCE(error_json,'{"code":"executor_cancelled","message":"Another partition of this action failed."}'),updated_at=now()
      WHERE workflow_step_run_id=$1 AND id<>$2 AND cleanup_confirmed_at IS NULL`,
      [task.workflow_step_run_id, assignment.id],
    );
    await client.query(
      "UPDATE execution.workflow_tasks SET status='cancelled',error='Another partition of this action failed.',completed_at=now(),updated_at=now() WHERE workflow_step_run_id=$1 AND id<>$2 AND status IN ('queued','retry_scheduled')",
      [task.workflow_step_run_id, task.id],
    );
  }
  await client.query(
    "UPDATE execution.execution_plan_shards SET status=$2,updated_at=now() WHERE workflow_task_id=$1",
    [task.id, taskState],
  );
  await client.query(
    `INSERT INTO execution.workflow_events(id,organization_id,workflow_run_id,workflow_step_run_id,workflow_task_id,event_type,payload_json,subject_type,subject_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'workflow_task',$5)`,
    [
      identifier("event"),
      task.organization_id,
      task.workflow_run_id,
      task.workflow_step_run_id,
      task.id,
      success
        ? "TaskCompleted"
        : retry
          ? "TaskRetryScheduled"
          : cancelled
            ? "TaskCancelled"
            : taskState === "dead_letter"
              ? "TaskDeadLettered"
              : "TaskFailed",
      JSON.stringify({
        assignmentId: assignment.id,
        backend: assignment.backend,
        executorId: assignment.executor_id,
        cleanupConfirmed: true,
        error,
      }),
    ],
  );
  return taskState as
    | "completed"
    | "cancelled"
    | "failed"
    | "dead_letter"
    | "retry_scheduled";
}

function identifier(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export interface ExecutorBackend {
  readonly kind: ExecutorBackendKind;
  dispatch(taskId: string): Promise<void>;
  renewLease(
    client: PgClient,
    claim: ExecutorClaim,
    expiresAt: string,
  ): Promise<boolean>;
  cancel(
    client: PgClient | PgPool,
    assignmentId: string,
    reason: string | ExecutorCancellation,
  ): Promise<void>;
  reconcile(
    client: PgClient | PgPool,
    assignmentId: string,
  ): Promise<Record<string, any> | null>;
  settle(
    client: PgClient,
    claim: ExecutorClaim,
    outcome: ExecutorOutcome,
  ): ReturnType<typeof settleExecutorResultPg>;
}

/** Backend transport owns delivery; PostgreSQL owns invocation identity and settlement.
 * Studio wakeups, managed-agent commands and the gated remote connector plug in here.
 * External workers have a category but cannot be dispatched by this release.
 */
export function createExecutorBackend(
  pool: PgPool,
  kind: ExecutorBackendKind,
  transport: {
    dispatch(taskId: string): Promise<void>;
    authorize?: WorkflowExecutionAuthorizer;
  },
): ExecutorBackend {
  async function assertClaim(client: PgClient, claim: ExecutorClaim) {
    const row = await pgOne(
      client,
      "SELECT backend FROM execution.executor_assignments WHERE task_id=$1 AND attempt=$2",
      [claim.taskId, claim.attempt],
    );
    if (row?.backend !== kind)
      throw new Error("Executor backend does not own this invocation.");
  }
  return {
    kind,
    async dispatch(taskId) {
      if (kind === "external-worker")
        throw new Error("External worker activation is deferred.");
      const task = await pgOne<Record<string, any>>(
        pool,
        `SELECT t.*,r.resolved_steps_json FROM execution.workflow_tasks t JOIN execution.workflow_runs r ON r.id=t.workflow_run_id WHERE t.id=$1`,
        [taskId],
      );
      const step = task?.resolved_steps_json.find(
        (value: Record<string, any>) => value.id === task.workflow_step_id,
      );
      if (!task || step?.executionTarget?.kind !== kind)
        throw new Error(
          "Dispatch backend conflicts with the action's frozen target.",
        );
      await (transport.authorize ?? authorizeWorkflowExecutionPg)(pool, {
        workflowRunId: task.workflow_run_id,
        stepId: task.workflow_step_id,
        phase: "dispatch",
        inputs: task.input_json,
      });
      await transport.dispatch(taskId);
    },
    async renewLease(client, claim, expiresAt) {
      await assertClaim(client, claim);
      if (kind === "remote-transport")
        throw new Error(
          "Remote transport has no authenticated lease renewal protocol.",
        );
      return renewExecutorLeasePg(client, claim, expiresAt);
    },
    async cancel(client, assignmentId, reason) {
      const row = await pgOne(
        client,
        "SELECT backend FROM execution.executor_assignments WHERE id=$1",
        [assignmentId],
      );
      if (row?.backend !== kind)
        throw new Error("Cancellation backend conflicts with the assignment.");
      await requestExecutorCancellationPg(client, assignmentId, reason);
    },
    async reconcile(client, assignmentId) {
      const row = await pgOne<Record<string, any>>(
        client,
        "SELECT * FROM execution.executor_assignments WHERE id=$1 AND backend=$2",
        [assignmentId, kind],
      );
      if (!row) return null;
      if (
        !row.cleanup_confirmed_at &&
        new Date(row.lease_expires_at).getTime() <= Date.now() &&
        !row.cancel_requested_at
      ) {
        await client.query(
          `UPDATE execution.executor_assignments SET state='reconciliation_required',cancel_requested_at=now(),error_json=COALESCE(error_json,'{"code":"executor_lease_expired","message":"Executor lease expired; termination evidence is required."}'),updated_at=now() WHERE id=$1 AND cleanup_confirmed_at IS NULL AND cancel_requested_at IS NULL`,
          [assignmentId],
        );
        return (
          (await pgOne(
            client,
            "SELECT * FROM execution.executor_assignments WHERE id=$1",
            [assignmentId],
          )) ?? null
        );
      }
      return row;
    },
    async settle(client, claim, outcome) {
      await assertClaim(client, claim);
      return settleExecutorResultPg(client, claim, outcome);
    },
  };
}

export async function renewExecutorLeasePg(
  client: PgClient,
  claim: ExecutorClaim,
  expiresAt: string,
) {
  const task = await lockExecutorClaimPg(client, claim);
  if (!task || Date.parse(expiresAt) <= new Date(task.database_now).getTime())
    return false;
  await client.query(
    "UPDATE execution.executor_assignments SET lease_expires_at=$2,updated_at=now() WHERE id=$1",
    [task.assignment.id, expiresAt],
  );
  await client.query(
    "UPDATE execution.workflow_tasks SET lease_expires_at=$2,lock_expires_at=$2,updated_at=now() WHERE id=$1",
    [claim.taskId, expiresAt],
  );
  return true;
}

export async function requestExecutorCancellationPg(
  client: PgClient | PgPool,
  assignmentId: string,
  reason: string | ExecutorCancellation,
) {
  await client.query(
    `UPDATE execution.executor_assignments SET state='cancel_requested',
    cancel_requested_at=COALESCE(cancel_requested_at,now()),error_json=COALESCE(error_json,$2::jsonb),updated_at=now()
    WHERE id=$1 AND cleanup_confirmed_at IS NULL`,
    [
      assignmentId,
      JSON.stringify(
        typeof reason === "string"
          ? { code: "executor_cancelled", message: reason }
          : reason,
      ),
    ],
  );
}

export async function recordExecutorStoppedPg(
  client: PgClient | PgPool,
  claim: ExecutorClaim,
) {
  await client.query(
    `UPDATE execution.executor_assignments a SET executor_stopped_at=COALESCE(executor_stopped_at,now()),updated_at=now()
    FROM execution.workflow_tasks t WHERE t.id=$1 AND t.claim_token=$3 AND t.attempt_count=$2 AND a.task_id=t.id AND a.attempt=t.attempt_count`,
    [claim.taskId, claim.attempt, claim.claimToken],
  );
}

export async function finishExecutorAssignmentPg(
  client: PgClient,
  assignmentId: string,
  status: "completed" | "failed" | "cancelled",
  result: unknown,
  error: string | null,
) {
  await client.query(
    `UPDATE execution.executor_assignments SET state=$2,executor_stopped_at=COALESCE(executor_stopped_at,now()),cleanup_confirmed_at=now(),
    result_json=$3::jsonb,error_json=CASE WHEN $4::text IS NULL THEN NULL ELSE jsonb_build_object('message',$4::text) END,updated_at=now() WHERE id=$1 AND cleanup_confirmed_at IS NULL`,
    [
      assignmentId,
      status,
      result == null ? null : JSON.stringify(result),
      error,
    ],
  );
  if (status !== "completed")
    await client.query(
      `UPDATE execution.workflow_artifact_manifests SET status='failed',
       error=COALESCE(error,$2),updated_at=now()
       WHERE assignment_id=$1 AND status='pending'`,
      [assignmentId, error ?? "Artifact publication did not finish."],
    );
}

/** A missed heartbeat requests cancellation; it never proves process/resource cleanup. */
export async function reconcileExecutorAssignmentsPg(pool: PgPool) {
  await pool.query(`UPDATE execution.executor_assignments a
    SET state='reconciliation_required',cancel_requested_at=COALESCE(a.cancel_requested_at,now()),
      error_json=COALESCE(a.error_json,'{"code":"executor_authority_superseded","message":"The orchestration authority changed; reconcile execution before retry.","retryable":true}'::jsonb),updated_at=now()
    FROM execution.workflow_run_authority authority
    WHERE a.workflow_run_id=authority.workflow_run_id
      AND a.authority_generation<>authority.generation
      AND a.cleanup_confirmed_at IS NULL`);
  await pool.query(`UPDATE execution.executor_assignments SET state='reconciliation_required',cancel_requested_at=COALESCE(cancel_requested_at,now()),
    error_json=COALESCE(error_json,'{"code":"executor_lease_expired","message":"Runner lease expired; awaiting termination evidence."}'::jsonb),updated_at=now()
    WHERE backend IN ('studio','remote-transport') AND cleanup_confirmed_at IS NULL AND lease_expires_at<=clock_timestamp() AND cancel_requested_at IS NULL`);
  const candidates = await pool.query<{
    task_id: string;
  }>(`SELECT task_id FROM execution.executor_assignments
    WHERE backend='studio' AND cleanup_confirmed_at IS NULL AND executor_stopped_at IS NOT NULL ORDER BY updated_at LIMIT 100`);
  for (const candidate of candidates.rows)
    await withPostgresTransaction(pool, async (client) => {
      const current = await pgOne<Record<string, any>>(
        client,
        `SELECT t.*,r.status AS run_status,r.resolved_steps_json,s.resource_execution_json,
      to_jsonb(a) AS assignment FROM execution.workflow_tasks t JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
      JOIN execution.workflow_step_runs s ON s.id=t.workflow_step_run_id
      JOIN execution.executor_assignments a ON a.task_id=t.id AND a.attempt=t.attempt_count
      WHERE t.id=$1 AND a.cleanup_confirmed_at IS NULL AND a.executor_stopped_at IS NOT NULL FOR UPDATE OF t,r,s,a`,
        [candidate.task_id],
      );
      if (!current || current.resource_execution_json?.state === "active")
        return;
      const cancelled =
        !["queued", "running"].includes(current.run_status) ||
        current.assignment.error_json?.code === "executor_cancelled";
      const policyAllowsRetry = actionAllowsAutomaticRetry(
        (current.resolved_steps_json as Record<string, any>[])?.find(
          (value) => value.id === current.workflow_step_id,
        ),
      );
      const retry =
        !cancelled &&
        ["executor_lease_expired", "executor_authority_superseded"].includes(
          current.assignment.error_json?.code,
        ) &&
        policyAllowsRetry &&
        current.attempt_count < current.max_attempts;
      const status = cancelled ? "cancelled" : "failed";
      const confirmedCancellationError = confirmedRoomCancellationError(
        current.run_status,
        current.resource_execution_json,
        current.assignment.error_json,
      );
      const error =
        confirmedCancellationError !== undefined
          ? (confirmedCancellationError?.message ?? null)
          : !policyAllowsRetry &&
              [
                "executor_lease_expired",
                "executor_authority_superseded",
              ].includes(current.assignment.error_json?.code)
            ? "The frozen action recovery policy forbids replay without a proven idempotency key."
            : (executorErrorAfterResourceCleanup(
                current.assignment.error_json,
                current.resource_execution_json,
              )?.message ??
              (cancelled
                ? "Execution cancelled."
                : "Execution stopped without a valid result."));
      await finishExecutorAssignmentPg(
        client,
        current.assignment.id,
        status,
        null,
        error,
      );
      await client.query(
        `UPDATE execution.workflow_tasks SET status=$2,error=$3,claim_token=NULL,leased_by=NULL,locked_by=NULL,lease_expires_at=NULL,lock_expires_at=NULL,
      scheduled_at=now(),completed_at=CASE WHEN $4 THEN NULL ELSE now() END,updated_at=now() WHERE id=$1`,
        [
          current.id,
          retry ? "retry_scheduled" : cancelled ? "cancelled" : "dead_letter",
          error,
          retry,
        ],
      );
      await client.query(
        "UPDATE execution.workflow_task_attempts SET status=$3,error=$4,completed_at=now() WHERE workflow_task_id=$1 AND attempt_number=$2",
        [current.id, current.attempt_count, status, error],
      );
      await client.query(
        `UPDATE execution.execution_plan_shards SET status=$2,updated_at=now()
         WHERE workflow_task_id=$1`,
        [
          current.id,
          retry ? "retry_scheduled" : cancelled ? "cancelled" : "dead_letter",
        ],
      );
      if (!retry && !cancelled)
        await client.query(
          `INSERT INTO execution.workflow_task_dead_letters
            (id,workflow_task_id,workflow_run_id,workflow_step_run_id,reason,error,attempts,max_attempts,payload_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT(workflow_task_id) DO NOTHING`,
          [
            identifier("deadletter"),
            current.id,
            current.workflow_run_id,
            current.workflow_step_run_id,
            policyAllowsRetry ? "max_attempts" : "non_retryable",
            error,
            current.attempt_count,
            current.max_attempts,
            JSON.stringify({ assignmentId: current.assignment.id }),
          ],
        );
      if (!retry)
        await client.query(
          "UPDATE execution.workflow_step_runs SET status=$2,error=$3,completed_at=now(),updated_at=now() WHERE id=$1 AND status IN ('queued','running')",
          [current.workflow_step_run_id, status, error],
        );
    });
}
