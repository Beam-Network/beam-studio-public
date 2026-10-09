import crypto from "node:crypto";
import { pgOne, type PgClient, type PgPool } from "./postgres.js";

/**
 * SQL predicate: the workflow template aliased `template` has a billing key
 * to launch with. It mirrors `resolveWorkflowBillingKey` for the trigger scans
 * that must not queue a run the launch would refuse: a key selected in
 * Workflow Settings, or exactly one Beam credential across its enabled Beam
 * Transfer steps.
 */
export function workflowHasBillingKeySql(template: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(template))
    throw new Error("Invalid SQL alias for the workflow template.");
  return `(NULLIF(btrim(${template}.api_key_id), '') IS NOT NULL OR (
    SELECT COUNT(DISTINCT btrim(billing_step.config_json->>'credentialId'))
    FROM workflow.steps billing_step
    WHERE billing_step.workflow_template_id = ${template}.id
      AND billing_step.retired_at IS NULL
      AND billing_step.enabled
      AND billing_step.action_package_name = '@beam/transfer'
      AND NULLIF(btrim(billing_step.config_json->>'credentialId'), '') IS NOT NULL
  ) = 1)`;
}

export function workflowBillingOperationKey(runId: string, attempt: number) {
  return `workflow.run:${crypto.createHash("sha256").update(`${runId}:${attempt}`).digest("hex")}`;
}

export async function nextWorkflowBillingOperationKeyPg(
  client: PgClient,
  runId: string,
) {
  // The retry transaction already holds the workflow run lock.
  const row = await pgOne<{ attempt: number }>(
    client,
    "SELECT COALESCE(MAX(attempt),0)+1 AS attempt FROM execution.workflow_billing_attempts WHERE workflow_run_id=$1",
    [runId],
  );
  return workflowBillingOperationKey(runId, Number(row!.attempt));
}

export type WorkflowBillingAttempt = {
  operation_key: string;
  workflow_run_id: string;
  organization_id: string;
  credential_id: string | null;
  authority_key_id: string | null;
  reservation_state: "pending" | "reserved" | "denied";
  reserve_started_at: Date | null;
  outcome: "completed" | "failed" | "cancelled" | null;
  settled_at: Date | null;
  error_code: string | null;
  error: string | null;
};

/** A called child uses the nearest billable ancestor; explicit child retries own a new attempt. */
export async function workflowBillingAttemptPg(
  pool: PgClient | PgPool,
  runId: string,
) {
  return pgOne<WorkflowBillingAttempt>(
    pool,
    `WITH RECURSIVE ancestors AS (
    SELECT id,parent_run_id,credit_operation_key,0 AS depth FROM execution.workflow_runs WHERE id=$1
    UNION ALL SELECT r.id,r.parent_run_id,r.credit_operation_key,a.depth+1 FROM execution.workflow_runs r JOIN ancestors a ON r.id=a.parent_run_id
    WHERE a.credit_operation_key IS NULL AND a.depth<16
  ) SELECT b.* FROM ancestors a JOIN execution.workflow_billing_attempts b ON b.operation_key=a.credit_operation_key
  ORDER BY a.depth LIMIT 1`,
    [runId],
  );
}
