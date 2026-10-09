import path from "node:path";
import {
  pgOne,
  withPostgresTransaction,
  type PgPool,
} from "@beam-studio/db";
import {
  prepareProcessOwnership,
  registerProcessController,
  recordSandboxStopped,
  reconcileProcessOwnership,
  getProcessOwnershipHostEvidence,
  getProcessOwnershipScope,
} from "@beam-studio/action-runtime";
import type { ClaimedWorkflowTask, TaskWorkerOptions } from "./taskTypes.js";

export async function prepareWorkerProcessOwnership(
  pool: PgPool,
  task: ClaimedWorkflowTask,
  options: TaskWorkerOptions,
) {
  const ownership = await prepareProcessOwnership(
    options.processOwnershipDir ??
      path.resolve(
        options.actionCacheDir ?? "/tmp/beam-action-cache",
        "..",
        "beam-action-ownership",
      ),
    `${task.id}/${task.attempt}`,
  );
  try {
    await registerProcessController(ownership);
    const evidence = await getProcessOwnershipHostEvidence();
    const committed = await pool.query(
      `UPDATE execution.executor_process_ownership p
      SET state='ready',record_path=$4,record_nonce=$5,owner_scope=$6,
        owner_host_identity=$7,owner_boot_id=$8,owner_native_scope=$9,updated_at=now()
      FROM execution.executor_assignments a,execution.workflow_tasks t
      WHERE p.assignment_id=a.id AND a.task_id=t.id AND t.id=$1 AND t.attempt_count=$2 AND t.claim_token=$3
        AND a.attempt=$2 AND a.cancel_requested_at IS NULL AND a.cleanup_confirmed_at IS NULL
        AND a.lease_expires_at>clock_timestamp() AND t.status='running' AND p.state='preparing'`,
      [
        task.id,
        task.attempt,
        task.claimToken,
        ownership.path,
        ownership.nonce,
        evidence.ownerScope,
        evidence.hostIdentity,
        evidence.bootId,
        evidence.nativeScope,
      ],
    );
    if (committed.rowCount !== 1)
      throw new Error("Process ownership was fenced before execution");
    return ownership;
  } catch (error) {
    await recordSandboxStopped(ownership).catch(() => undefined);
    throw error;
  }
}

/** Recovery produces process evidence; the Dispatcher still owns outcome and resource cleanup. */
export async function reconcileWorkerProcesses(pool: PgPool) {
  const candidates = await pool.query<{
    assignment_id: string;
    state: string;
    record_path: string | null;
    record_nonce: string | null;
  }>(
    `SELECT p.* FROM execution.executor_process_ownership p JOIN execution.executor_assignments a ON a.id=p.assignment_id
      WHERE a.backend='studio' AND (p.state='preparing' OR p.owner_scope=$1) AND a.executor_stopped_at IS NULL AND a.cleanup_confirmed_at IS NULL
        AND (a.lease_expires_at<=clock_timestamp() OR a.cancel_requested_at IS NOT NULL)
      ORDER BY p.updated_at LIMIT 100`,
    [await getProcessOwnershipScope()],
  );
  let stopped = 0;
  for (const row of candidates.rows) {
    try {
      // Rotate unresolved live owners as well as errors so a bounded batch
      // cannot indefinitely hide later assignments that can be recovered.
      await pool.query(
        "UPDATE execution.executor_process_ownership SET updated_at=clock_timestamp() WHERE assignment_id=$1",
        [row.assignment_id],
      );
      if (row.state === "ready") {
        const receipt = await reconcileProcessOwnership({
          path: row.record_path!,
          nonce: row.record_nonce!,
        });
        if (!receipt.cleanupConfirmed) continue;
      }
      stopped += await withPostgresTransaction(pool, async (client) => {
        const current = await pgOne<{ state: string }>(
          client,
          "SELECT state FROM execution.executor_process_ownership WHERE assignment_id=$1 FOR UPDATE",
          [row.assignment_id],
        );
        // Preparing is fenced atomically against the original executor's CAS.
        if (!current || current.state !== row.state) return 0;
        await client.query(
          "UPDATE execution.executor_process_ownership SET state='stopped',updated_at=now() WHERE assignment_id=$1",
          [row.assignment_id],
        );
        await client.query(
          "UPDATE execution.executor_assignments SET executor_stopped_at=COALESCE(executor_stopped_at,now()),updated_at=now() WHERE id=$1",
          [row.assignment_id],
        );
        return 1;
      });
    } catch (error) {
      await pool.query(
        `UPDATE execution.executor_assignments SET progress_json=jsonb_set(progress_json,'{reconciliation}',$2::jsonb),updated_at=now() WHERE id=$1 AND cleanup_confirmed_at IS NULL`,
        [
          row.assignment_id,
          JSON.stringify({
            code: "process_evidence_unavailable",
            message:
              error instanceof Error
                ? error.message
                : "Process termination remains unconfirmed",
          }),
        ],
      );
    }
  }
  return { stopped };
}
