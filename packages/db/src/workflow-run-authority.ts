import { pgOne, type PgClient, type PgPool } from "./postgres.js";

export type WorkflowRunAuthority = {
  generation: number;
  takenOver: boolean;
};

/** Keep leases for all runs owned by this process alive even when a busy batch
 * does not select every run for graph advancement. Expired ownership is never
 * resurrected; a later acquisition must advance its generation. */
export async function renewWorkflowRunAuthoritiesPg(
  pool: PgPool,
  ownerId: string,
  leaseSeconds = 60,
) {
  await pool.query(
    `UPDATE execution.workflow_run_authority a
     SET lease_expires_at=clock_timestamp()+($2*interval '1 second'),updated_at=now()
     FROM execution.workflow_runs r
     WHERE a.workflow_run_id=r.id AND a.owner_id=$1
       AND a.lease_expires_at>clock_timestamp()
       AND r.status IN ('running','cancel_requested')`,
    [ownerId, leaseSeconds],
  );
}

/** Called while holding the workflow run row lock. The lease prevents a second
 * orchestrator from advancing the graph; the generation fences its results. */
export async function acquireWorkflowRunAuthorityPg(
  client: PgClient,
  workflowRunId: string,
  ownerId: string,
  leaseSeconds = 60,
): Promise<WorkflowRunAuthority | null> {
  if (!ownerId || !Number.isInteger(leaseSeconds) || leaseSeconds < 5)
    throw new Error("Invalid workflow authority lease.");
  await client.query(
    `INSERT INTO execution.workflow_run_authority
      (workflow_run_id,generation,owner_id,lease_expires_at)
     VALUES($1,1,$2,clock_timestamp()+($3*interval '1 second'))
     ON CONFLICT(workflow_run_id) DO NOTHING`,
    [workflowRunId, ownerId, leaseSeconds],
  );
  const authority = await pgOne<{
    generation: string;
    owner_id: string;
    expired: boolean;
  }>(
    client,
    `SELECT generation,owner_id,lease_expires_at<=clock_timestamp() AS expired
     FROM execution.workflow_run_authority WHERE workflow_run_id=$1 FOR UPDATE`,
    [workflowRunId],
  );
  if (!authority) throw new Error("Workflow authority was not persisted.");
  if (authority.owner_id !== ownerId && !authority.expired) return null;
  const takenOver = authority.owner_id !== ownerId || authority.expired;
  const row = await pgOne<{ generation: string }>(
    client,
    `UPDATE execution.workflow_run_authority
     SET generation=generation+$3,owner_id=$2,
         lease_expires_at=clock_timestamp()+($4*interval '1 second'),updated_at=now()
     WHERE workflow_run_id=$1 RETURNING generation`,
    [workflowRunId, ownerId, takenOver ? 1 : 0, leaseSeconds],
  );
  if (!row) throw new Error("Workflow authority renewal failed.");
  if (takenOver) {
    await client.query(
      `UPDATE execution.executor_assignments
       SET state='reconciliation_required',cancel_requested_at=COALESCE(cancel_requested_at,now()),
           error_json=COALESCE(error_json,'{"code":"executor_authority_superseded","message":"The orchestration authority changed; reconcile execution before retry.","retryable":true}'::jsonb),updated_at=now()
       WHERE workflow_run_id=$1 AND authority_generation<$2
         AND cleanup_confirmed_at IS NULL`,
      [workflowRunId, row.generation],
    );
  }
  return { generation: Number(row.generation), takenOver };
}

/** A claim reads this under its run row lock, so takeover cannot race creation. */
export async function workflowRunAuthorityGenerationPg(
  client: PgClient,
  workflowRunId: string,
) {
  const row = await pgOne<{ generation: string }>(
    client,
    `SELECT generation FROM execution.workflow_run_authority
     WHERE workflow_run_id=$1 AND lease_expires_at>clock_timestamp()`,
    [workflowRunId],
  );
  return row ? Number(row.generation) : null;
}
