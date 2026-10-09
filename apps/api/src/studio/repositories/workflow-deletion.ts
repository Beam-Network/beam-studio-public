import type { PgClient } from "@beam-studio/db";
import { fixtureCampaignsUsingWorkflowPg } from "@beam-studio/db";
import type { OrganizationScope } from "./organization-scope.js";

function conflict(message: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), {
    code: "workflow_delete_conflict",
    statusCode: 409,
    expose: true,
    details,
  });
}

export type WorkflowCaller = {
  id: string;
  name: string;
  /** Every call step is a removed step retained for the caller's run history. */
  historyOnly: boolean;
};

export type WorkflowReferences = {
  callers: WorkflowCaller[];
  fixtureCampaignIds: string[];
};

export async function readWorkflowReferences(
  client: Pick<PgClient, "query">,
  scope: OrganizationScope,
  workflowId: string,
): Promise<WorkflowReferences & { foreignCallers: number }> {
  const callers = await client.query<{
    id: string;
    name: string;
    same_organization: boolean;
    history_only: boolean;
  }>(
    `SELECT t.id, t.name, t.organization_id = $2 AS same_organization,
       bool_and(s.retired_at IS NOT NULL) AS history_only
     FROM workflow.steps s JOIN workflow.templates t ON t.id = s.workflow_template_id
     WHERE s.called_workflow_id = $1 AND s.workflow_template_id <> $1
     GROUP BY t.id, t.name, t.organization_id
     ORDER BY t.name, t.id`,
    [workflowId, scope.organizationId],
  );
  // Campaigns own managed fixture objects; only an operator can retire one.
  const fixtureCampaignIds = await fixtureCampaignsUsingWorkflowPg(
    client,
    workflowId,
  );
  return {
    callers: callers.rows
      .filter((row) => row.same_organization)
      .map((row) => ({
        id: row.id,
        name: row.name,
        historyOnly: row.history_only,
      })),
    foreignCallers: callers.rows.filter((row) => !row.same_organization)
      .length,
    fixtureCampaignIds,
  };
}

function quotedList(names: string[]) {
  const shown = names.slice(0, 5).map((name) => `“${name}”`);
  const more = names.length - shown.length;
  if (more) return `${shown.join(", ")} and ${more} more`;
  if (shown.length < 3) return shown.join(" and ");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

function referencesConflict(references: WorkflowReferences) {
  const current = references.callers.filter((c) => !c.historyOnly);
  const history = references.callers.filter((c) => c.historyOnly);
  const parts: string[] = [];
  if (current.length)
    parts.push(
      `${quotedList(current.map((c) => c.name))} ${current.length === 1 ? "calls" : "call"} this workflow. Remove ${current.length === 1 ? "that workflow step" : "those workflow steps"} before deleting it.`,
    );
  if (history.length)
    parts.push(
      `${quotedList(history.map((c) => c.name))} ${history.length === 1 ? "keeps" : "keep"} a removed call to this workflow for run history. Delete ${history.length === 1 ? "that workflow" : "those workflows"} first.`,
    );
  const campaigns = references.fixtureCampaignIds;
  if (campaigns.length)
    parts.push(
      `Fixture ${campaigns.length === 1 ? "campaign" : "campaigns"} ${quotedList(campaigns)} ${campaigns.length === 1 ? "uses" : "use"} this workflow. An operator must retire ${campaigns.length === 1 ? "the campaign" : "them"} before it can be deleted.`,
    );
  return parts.length
    ? conflict(parts.join(" "), {
        callers: references.callers,
        fixtureCampaignIds: references.fixtureCampaignIds,
      })
    : null;
}

/** Prepare the existing hard-delete operation without discarding live work. */
export async function prepareWorkflowDeletion(
  client: PgClient,
  scope: OrganizationScope,
  workflowId: string,
) {
  const template = await client.query(
    "SELECT id FROM workflow.templates WHERE id=$1 AND organization_id=$2 FOR UPDATE",
    [workflowId, scope.organizationId],
  );
  if (!template.rowCount) {
    throw Object.assign(new Error("Workflow template not found."), {
      code: "workflow_not_found",
      statusCode: 404,
      expose: true,
    });
  }
  const foreignHistory = await client.query(
    `SELECT id FROM execution.workflow_runs WHERE workflow_template_id=$1
     AND organization_id IS DISTINCT FROM $2 LIMIT 1`,
    [workflowId, scope.organizationId],
  );
  if (foreignHistory.rowCount)
    throw conflict(
      "Administrative reconciliation is required for historical organization references.",
    );
  const references = await readWorkflowReferences(client, scope, workflowId);
  const referenced = referencesConflict(references);
  if (referenced) throw referenced;
  if (references.foreignCallers)
    throw conflict(
      "Administrative reconciliation is required for historical organization references.",
    );

  const runs = await client.query<{
    id: string;
    status: string;
    parent_run_id: string | null;
  }>(
    `WITH RECURSIVE selected(id) AS (
       SELECT id FROM execution.workflow_runs WHERE workflow_template_id=$1 AND organization_id=$2
       UNION
       SELECT child.id FROM execution.workflow_runs child JOIN selected parent
         ON child.parent_run_id=parent.id OR child.root_run_id=parent.id
       WHERE child.organization_id=$2
     ) SELECT r.id,r.status,r.parent_run_id FROM execution.workflow_runs r JOIN selected s ON s.id=r.id FOR UPDATE OF r`,
    [workflowId, scope.organizationId],
  );
  const runIds = runs.rows.map((r) => r.id);
  if (
    runs.rows.some(
      (r) => !["completed", "failed", "cancelled"].includes(r.status),
    )
  ) {
    throw conflict(
      "Wait for all workflow runs to finish before deleting this workflow.",
    );
  }
  if (!runIds.length) return runIds;
  const selectedIds = new Set(runIds);
  if (
    runs.rows.some((r) => r.parent_run_id && !selectedIds.has(r.parent_run_id))
  )
    throw conflict(
      "Remove the owning parent workflow history before deleting this workflow.",
    );
  const outsideCalls = await client.query(
    `SELECT id FROM execution.workflow_step_runs WHERE child_run_id=ANY($1::text[])
     AND NOT workflow_run_id=ANY($1::text[]) LIMIT 1`,
    [runIds],
  );
  if (outsideCalls.rowCount)
    throw conflict(
      "Remove the owning parent workflow history before deleting this workflow.",
    );
  const outsideInvocations = await client.query(
    `SELECT id FROM execution.workflow_runs WHERE NOT id=ANY($1::text[])
     AND (parent_run_id=ANY($1::text[]) OR root_run_id=ANY($1::text[])
       OR invoking_step_run_id IN (SELECT id FROM execution.workflow_step_runs WHERE workflow_run_id=ANY($1::text[])))
     LIMIT 1`,
    [runIds],
  );
  if (outsideInvocations.rowCount)
    throw conflict(
      "Administrative reconciliation is required for historical organization references.",
    );
  const cleanup = await client.query(
    `SELECT id FROM execution.executor_assignments WHERE workflow_run_id=ANY($1::text[])
     AND (state NOT IN ('completed','failed','cancelled') OR cleanup_confirmed_at IS NULL) LIMIT 1`,
    [runIds],
  );
  if (cleanup.rowCount)
    throw conflict(
      "Executor cleanup must be confirmed before deleting this workflow.",
    );
  const billing = await client.query(
    `SELECT operation_key FROM execution.workflow_billing_attempts WHERE workflow_run_id=ANY($1::text[])
     AND reservation_state<>'denied' AND settled_at IS NULL
     AND (reserve_started_at IS NOT NULL OR reservation_state='reserved' OR outcome IS NOT NULL) LIMIT 1`,
    [runIds],
  );
  if (billing.rowCount)
    throw conflict(
      "Billing settlement must finish before deleting this workflow.",
    );

  // Invocation links belong to frozen history. Remove the owned execution tree
  // as a unit; never rewrite identities to satisfy its restrictive foreign keys.
  await client.query(
    "DELETE FROM execution.executor_assignments WHERE workflow_run_id=ANY($1::text[])",
    [runIds],
  );
  await client.query(
    "DELETE FROM execution.workflow_billing_attempts WHERE workflow_run_id=ANY($1::text[])",
    [runIds],
  );
  // RESTRICT checks on a child's reverse step-result link can precede the
  // parent's cascade under an index scan. Break only links within this purged
  // tree; frozen run identities and all surviving history remain untouched.
  await client.query(
    `UPDATE execution.workflow_step_runs SET child_run_id=NULL
     WHERE workflow_run_id=ANY($1::text[]) AND child_run_id=ANY($1::text[])`,
    [runIds],
  );
  // Run-owned cascades remove dynamic instances and step runs together, after
  // every selected invocation row is deleted by the single run DELETE command.
  return runIds;
}
