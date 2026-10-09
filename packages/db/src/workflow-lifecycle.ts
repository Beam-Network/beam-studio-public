import { pgOne, type PgClient } from "./postgres.js";
import { randomUUID } from "node:crypto";
import { roomTransferRetryUnavailableReason } from "@beam-studio/shared";
import { nextWorkflowBillingOperationKeyPg } from "./workflow-billing.js";
import { referenceFixtureGenerationsPg } from "./fixture-campaigns.js";
import {
  authorizeWorkflowExecutionPg,
  type WorkflowExecutionAuthorizer,
} from "./workflow-authorization.js";

type Row = Record<string, unknown>;

export async function requestWorkflowCancellationPg(
  client: PgClient,
  runId: string,
  organizationId: string,
  reason = "cancellation requested",
) {
  const run = await pgOne<Row>(
    client,
    "SELECT id FROM execution.workflow_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE",
    [runId, organizationId],
  );
  if (!run) throw new Error("Workflow run not found.");
  await client.query(
    `WITH RECURSIVE tree(id) AS (
    SELECT id FROM execution.workflow_runs WHERE id=$1 AND organization_id=$2
    UNION ALL SELECT r.id FROM execution.workflow_runs r JOIN tree t ON r.parent_run_id=t.id
  ) UPDATE execution.workflow_runs SET status='cancel_requested',error=COALESCE(error,$3),updated_at=now()
    WHERE id IN (SELECT id FROM tree) AND status IN ('queued','running')`,
    [runId, organizationId, reason],
  );
}

/**
 * A retry the caller cannot have right now: the API answers it with this
 * status and code (404 or 409) instead of a 500.
 */
function retryRefusal(message: string, code: string, statusCode = 409) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    retryable: false,
  });
}

/** Retry failed work in the same frozen run; completed calls and their outputs remain committed. */
export async function retryFrozenWorkflowRunPg(
  client: PgClient,
  input: {
    workflowRunId: string;
    organizationId: string;
    requestedBy?: string | null;
    authorizeExecution?: WorkflowExecutionAuthorizer;
  },
) {
  const run = await pgOne<Row>(
    client,
    "SELECT * FROM execution.workflow_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE",
    [input.workflowRunId, input.organizationId],
  );
  if (!run)
    throw retryRefusal(
      "Workflow run not found.",
      "workflow_run_not_found",
      404,
    );
  if (run.historical || !run.workflow_plan_version_id)
    throw retryRefusal(
      "Historical workflow runs cannot be retried; run the current definition instead.",
      "historical_run_not_retryable",
    );
  if (!["failed", "cancelled", "dead_letter"].includes(String(run.status)))
    throw retryRefusal(
      "Only failed or cancelled workflow runs can be retried.",
      "workflow_run_not_retryable",
    );
  await referenceFixtureGenerationsPg(client, input.workflowRunId, {
    snapshot: run.template_snapshot_json,
    input: run.input_json,
    steps: run.resolved_steps_json,
  });
  await (input.authorizeExecution ?? authorizeWorkflowExecutionPg)(client, {
    workflowRunId: input.workflowRunId,
    phase: "retry",
  });
  const active = await pgOne<Row>(
    client,
    `WITH RECURSIVE descendants AS (
    SELECT id,status FROM execution.workflow_runs WHERE parent_run_id=$1
    UNION ALL SELECT r.id,r.status FROM execution.workflow_runs r JOIN descendants d ON r.parent_run_id=d.id
  ) SELECT id FROM descendants WHERE status IN ('queued','running','cancel_requested') LIMIT 1`,
    [input.workflowRunId],
  );
  if (active)
    throw retryRefusal(
      "Wait for descendant cancellation and cleanup before retrying.",
      "descendant_cleanup_pending",
    );
  const unsettled = await pgOne(
    client,
    `SELECT id FROM execution.executor_assignments WHERE workflow_run_id=$1 AND cleanup_confirmed_at IS NULL LIMIT 1`,
    [input.workflowRunId],
  );
  if (unsettled)
    throw retryRefusal(
      "Wait for executor cancellation and resource cleanup before retrying.",
      "executor_cleanup_pending",
    );
  // Project lifecycle fields, never the potentially large execution evidence.
  // Reject before changing tasks, attempt identities or billing ownership.
  const roomSteps = await client.query(
    `SELECT action_package_name AS "actionPackageName",status,
      jsonb_build_object('publicationId',state_json->'publicationId',
        'publishRequested',state_json->'publishRequested','beamStatus',state_json->'beamStatus',
        'cancellationStatus',state_json->'cancellationStatus','expiresAt',state_json->'expiresAt') AS state
      FROM execution.workflow_step_runs WHERE workflow_run_id=$1
      AND action_package_name='@beam/room-transfer' AND status IN ('failed','cancelled')`,
    [input.workflowRunId],
  );
  const retryUnavailable = roomTransferRetryUnavailableReason(roomSteps.rows);
  if (retryUnavailable) {
    throw Object.assign(new Error(retryUnavailable), {
      code: "room_transfer_retry_unavailable",
      statusCode: 409,
      retryable: false,
    });
  }
  // A failure before dispatch has no committed invocation input to reuse.
  // Re-evaluate its bindings instead of treating its empty error record as input.
  await client.query(
    `DELETE FROM execution.workflow_step_runs s WHERE s.workflow_run_id=$1
    AND s.status IN ('failed','cancelled') AND s.child_run_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM execution.workflow_tasks t WHERE t.workflow_step_run_id=s.id)
    AND NOT EXISTS(SELECT 1 FROM execution.workflow_runs c WHERE c.invoking_step_run_id=s.id)`,
    [input.workflowRunId],
  );
  // Retry identities are persisted before any redispatch. Old child runs retain their invocation attempt.
  await client.query(
    `UPDATE execution.workflow_step_runs SET status='queued',attempt=attempt+1,child_run_id=NULL,
    output_json='null',error=NULL,started_at=NULL,completed_at=NULL,updated_at=now(),
    metadata_json=(metadata_json-'invocation'-'callTimedOut') || jsonb_build_object('retryRequestedBy',$2::text)
    WHERE workflow_run_id=$1 AND status IN ('failed','cancelled')`,
    [input.workflowRunId, input.requestedBy ?? null],
  );
  await client.query(
    `UPDATE execution.workflow_tasks t SET status='retry_scheduled',scheduled_at=now(),
    max_attempts=GREATEST(t.max_attempts,t.attempts+1),error=NULL,completed_at=NULL,
    leased_by=NULL,locked_by=NULL,lease_expires_at=NULL,lock_expires_at=NULL,claim_token=NULL,updated_at=now()
    FROM execution.workflow_step_runs s WHERE t.workflow_step_run_id=s.id AND s.workflow_run_id=$1
      AND s.status='queued' AND t.status IN ('failed','cancelled','dead_letter')`,
    [input.workflowRunId],
  );
  await client.query(
    `DELETE FROM execution.workflow_step_runs s WHERE s.workflow_run_id=$1
    AND s.status='not_reached' AND s.child_run_id IS NULL`,
    [input.workflowRunId],
  );
  await client.query(
    `UPDATE execution.workflow_dynamic_instances i SET status=CASE WHEN EXISTS (
      SELECT 1 FROM execution.workflow_step_runs s WHERE s.dynamic_instance_id=i.id) THEN 'queued' ELSE 'pending' END,
    current_attempt=current_attempt+1,error=NULL,output_json='null',completed_at=NULL,updated_at=now()
    WHERE workflow_run_id=$1 AND status IN ('failed','cancelled','not_reached')`,
    [input.workflowRunId],
  );
  await client.query(
    `UPDATE execution.workflow_dynamic_regions SET status='running',failed_count=0,cancelled_count=0,
    retry_requested_at=now(),cancellation_requested_at=NULL,error=NULL,completed_at=NULL,updated_at=now()
    WHERE workflow_run_id=$1 AND status IN ('failed','cancelled')`,
    [input.workflowRunId],
  );
  // Decisions are evaluations over outcomes; recompute them as failed inputs recover.
  await client.query(
    "DELETE FROM execution.workflow_decision_evaluations WHERE workflow_run_id=$1",
    [input.workflowRunId],
  );
  // Preserve the previous attempt's timing before giving this retry its own
  // duration budget. Creation time and frozen execution intent never change.
  await client.query(
    `INSERT INTO execution.workflow_events
      (id,organization_id,project_id,event_type,subject_type,subject_id,workflow_template_id,workflow_run_id,payload_json,created_by)
      VALUES ($1,$2,$3,'WorkflowRunRetried','workflow_run',$4,$5,$4,$6::jsonb,$7)`,
    [
      randomUUID(),
      input.organizationId,
      run.project_id ?? null,
      input.workflowRunId,
      run.workflow_template_id,
      JSON.stringify({
        previousStatus: run.status,
        previousQueuedAt: run.queued_at,
        previousStartedAt: run.started_at,
        previousCompletedAt: run.completed_at,
        previousBillingOperationKey: run.credit_operation_key,
      }),
      input.requestedBy ?? null,
    ],
  );
  await client.query(
    `UPDATE execution.workflow_runs SET status='running',error=NULL,queued_at=now(),started_at=now(),completed_at=NULL,output_json='null',
    output_validation='unvalidated',credit_operation_key=$2,credit_settled_at=NULL,updated_at=now()
    WHERE id=$1`,
    [
      input.workflowRunId,
      await nextWorkflowBillingOperationKeyPg(client, input.workflowRunId),
    ],
  );
  return input.workflowRunId;
}
