import {
  pgOne,
  workflowBillingAttemptPg,
  WorkflowAuthorizationError,
  WorkflowAuthorityUnavailableError,
  type PgClient,
  type PgPool,
  type WorkflowBillingAttempt,
} from "@beam-studio/db";
import { missingBillingKeyMessage } from "@beam-studio/core";
import {
  createCreditClient,
  CreditReservationError,
  type CreditClient,
  type WorkflowBillingReceipt,
} from "./credit-client.js";
import { workflowAccountApiUrl } from "../studio/workflow-account-authority.js";

async function runCreditClient(client: PgClient | PgPool, runId: string) {
  const run = await pgOne<{
    workflow_template_id: string;
    organization_id: string;
    execution_context_json: {
      environment?: string;
      billing?: { apiKeyId?: string };
    };
  }>(
    client,
    "SELECT workflow_template_id,organization_id,execution_context_json FROM execution.workflow_runs WHERE id=$1",
    [runId],
  );
  if (!run) throw new WorkflowAuthorizationError("execution_run_missing");
  return createCreditClient(globalThis.fetch, workflowAccountApiUrl(run));
}

/** Where workflow billing reads the Beam API keys it authenticates with. */
export type WorkflowBillingKeys = {
  /** The run's own key, through the filter execution authorization applies. */
  run: (
    client: PgClient,
    attempt: WorkflowBillingAttempt,
  ) => Promise<string | null>;
  /** The organization's default Beam key. */
  organization: (organizationId: string) => Promise<string | null>;
};

export const storeBillingKeys: WorkflowBillingKeys = {
  async run(client, attempt) {
    if (!attempt.credential_id) return null;
    const run = await pgOne<{ project_id: string | null }>(
      client,
      "SELECT project_id FROM execution.workflow_runs WHERE id=$1",
      [attempt.workflow_run_id],
    );
    const { executionBeamApiKey } = await import("../studio/store.js");
    return executionBeamApiKey(client, {
      credentialId: attempt.credential_id,
      organizationId: attempt.organization_id,
      projectId: run?.project_id ?? null,
    });
  },
  async organization(organizationId) {
    const { organizationBeamApiKey } = await import("../studio/store.js");
    return organizationBeamApiKey(organizationId);
  },
};

/**
 * A key that can reach the attempt's ledger record: the run's own while it is
 * usable, otherwise the organization's default. Beam scopes lookup and
 * settlement to the organization, not to the key that reserved, so a revoked
 * run key never strands a hold.
 */
async function ledgerKey(
  client: PgClient,
  attempt: WorkflowBillingAttempt,
  keys: WorkflowBillingKeys,
) {
  const key =
    (await keys.run(client, attempt)) ??
    (await keys.organization(attempt.organization_id));
  if (!key)
    throw new CreditReservationError(
      "billing_unavailable",
      "No usable Beam API key can reach this workflow's billing record.",
      503,
    );
  return key;
}

async function withBillingLock<T>(
  pool: PgPool,
  operationKey: string,
  operation: (client: PgClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,170))", [
      operationKey,
    ]);
    return await operation(client);
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1,170))",
        [operationKey],
      );
    } finally {
      client.release();
    }
  }
}

function assertReceipt(
  receipt: WorkflowBillingReceipt,
  attempt: WorkflowBillingAttempt,
) {
  if (
    receipt.settlement ||
    (receipt.found && receipt.operation?.status !== "RESERVED")
  )
    throw new WorkflowAuthorizationError(
      "execution_billing_ended",
      "The billing attempt already has a terminal outcome.",
    );
  if (
    receipt.found &&
    (receipt.operation?.idempotencyKey !== attempt.operation_key ||
      receipt.operation.action !== "workflow.run" ||
      receipt.operation.apiKeyId !== attempt.authority_key_id)
  )
    throw new WorkflowAuthorizationError("execution_billing_identity_mismatch");
  return receipt.found;
}

/**
 * Shown on the run when Beam refuses the workflow-run charge. Beam's refusal
 * says only "Insufficient credits"; the customer needs to know where to act.
 */
export const INSUFFICIENT_CREDIT_MESSAGE =
  "Your organization doesn't have enough credits to start this run. Add credits in the Console, then run it again.";

/** Every launch path owns the intent before reaching this recoverable remote call. */
export async function ensureWorkflowBillingReserved(
  pool: PgPool,
  runId: string,
  credit?: CreditClient,
  keys: WorkflowBillingKeys = storeBillingKeys,
) {
  const intent = await workflowBillingAttemptPg(pool, runId);
  if (!intent)
    throw new WorkflowAuthorizationError("execution_billing_intent_missing");
  const billingCredit = credit ?? (await runCreditClient(pool, runId));
  return withBillingLock(pool, intent.operation_key, async (client) => {
    const attempt = (await pgOne<WorkflowBillingAttempt>(
      client,
      "SELECT * FROM execution.workflow_billing_attempts WHERE operation_key=$1",
      [intent.operation_key],
    ))!;
    if (attempt.outcome || attempt.settled_at)
      throw new WorkflowAuthorizationError("execution_billing_ended");
    if (attempt.reservation_state === "reserved") return;
    if (attempt.reservation_state === "denied")
      throw new WorkflowAuthorizationError(
        attempt.error_code ?? "execution_billing_denied",
        attempt.error ?? "The billing reservation was denied.",
      );
    const reserved = () =>
      client.query(
        "UPDATE execution.workflow_billing_attempts SET reservation_state='reserved',error_code=NULL,error=NULL,updated_at=now() WHERE operation_key=$1",
        [attempt.operation_key],
      );
    try {
      if (
        attempt.authority_key_id &&
        assertReceipt(
          await billingCredit.workflowOperation(
            await ledgerKey(client, attempt, keys),
            attempt.operation_key,
          ),
          attempt,
        )
      ) {
        await reserved();
        return;
      }
      if (!attempt.credential_id)
        throw new WorkflowAuthorizationError(
          "execution_credential_missing",
          missingBillingKeyMessage("missing"),
        );
      // The hold is charged to the key it is taken with, so only the run's own
      // key may take it.
      const key = await keys.run(client, attempt);
      if (!key)
        throw new WorkflowAuthorizationError("execution_credential_revoked");
      if (!attempt.authority_key_id) {
        attempt.authority_key_id = await billingCredit.resolveKeyId(key);
        await client.query(
          "UPDATE execution.workflow_billing_attempts SET authority_key_id=$2,updated_at=now() WHERE operation_key=$1",
          [attempt.operation_key, attempt.authority_key_id],
        );
      }
      // Autocommit before network I/O: a crashed API leaves a recoverable identity.
      await client.query(
        "UPDATE execution.workflow_billing_attempts SET reserve_started_at=COALESCE(reserve_started_at,now()),updated_at=now() WHERE operation_key=$1",
        [attempt.operation_key],
      );
      await billingCredit.reserve(key, {
        idempotencyKey: attempt.operation_key,
        action: "workflow.run",
        usage: [{ metric: "invocation", quantity: 1, unit: "count" }],
      });
      if (
        !assertReceipt(
          await billingCredit.workflowOperation(key, attempt.operation_key),
          attempt,
        )
      )
        throw new CreditReservationError(
          "billing_unavailable",
          "Workflow reservation could not be confirmed",
          503,
        );
      await reserved();
    } catch (error) {
      // A lost response or a changed price quote must reconcile the original
      // ledger record before deciding to reject this invocation.
      if (
        attempt.authority_key_id &&
        !(error instanceof WorkflowAuthorizationError)
      ) {
        try {
          if (
            assertReceipt(
              await billingCredit.workflowOperation(
                await ledgerKey(client, attempt, keys),
                attempt.operation_key,
              ),
              attempt,
            )
          ) {
            await reserved();
            return;
          }
        } catch {
          /* Keep the durable intent pending when receipt lookup is unavailable. */
        }
      }
      const permanent =
        error instanceof WorkflowAuthorizationError ||
        (error instanceof CreditReservationError &&
          [400, 401, 402, 403, 404, 409].includes(error.statusCode));
      const code =
        error instanceof WorkflowAuthorizationError
          ? error.code
          : error instanceof CreditReservationError
            ? `execution_${error.code}`
            : "execution_billing_unavailable";
      const message =
        error instanceof CreditReservationError &&
        error.code === "insufficient_credit"
          ? INSUFFICIENT_CREDIT_MESSAGE
          : error instanceof Error
            ? error.message
            : "Workflow billing was not confirmed";
      await client.query(
        "UPDATE execution.workflow_billing_attempts SET reservation_state=$2,error_code=$3,error=$4,updated_at=now() WHERE operation_key=$1",
        [
          attempt.operation_key,
          permanent ? "denied" : "pending",
          code,
          message,
        ],
      );
      if (permanent) throw new WorkflowAuthorizationError(code, message);
      throw new WorkflowAuthorityUnavailableError(
        code,
        "Workflow billing authority is temporarily unavailable.",
      );
    }
  });
}

export async function settleWorkflowBillingAttempt(
  pool: PgPool,
  operationKey: string,
  credit?: CreditClient,
  keys: WorkflowBillingKeys = storeBillingKeys,
) {
  return withBillingLock(pool, operationKey, async (client) => {
    const attempt = await pgOne<WorkflowBillingAttempt>(
      client,
      "SELECT * FROM execution.workflow_billing_attempts WHERE operation_key=$1",
      [operationKey],
    );
    if (!attempt?.outcome || attempt.settled_at) return false;
    try {
      // Reservation records its start before network I/O under this same lock.
      // A cancelled/failed intent with neither marker never reached the ledger.
      // Completed work and possibly started holds still require confirmation.
      const neverStarted =
        attempt.outcome !== "completed" &&
        attempt.reservation_state !== "reserved" &&
        !attempt.authority_key_id &&
        !attempt.reserve_started_at;
      if (!neverStarted) {
        const billingCredit =
          credit ?? (await runCreditClient(client, attempt.workflow_run_id));
        await billingCredit.settleWorkflowOperation(
          await ledgerKey(client, attempt, keys),
          operationKey,
          attempt.outcome,
        );
      }
    } catch (error) {
      await client.query(
        "UPDATE execution.workflow_billing_attempts SET error_code='settlement_unconfirmed',error=$2,updated_at=clock_timestamp() WHERE operation_key=$1",
        [
          operationKey,
          error instanceof Error
            ? error.message
            : "Workflow settlement was not confirmed",
        ],
      );
      throw error;
    }
    await client.query(
      "UPDATE execution.workflow_billing_attempts SET settled_at=now(),error_code=NULL,error=NULL,updated_at=now() WHERE operation_key=$1",
      [operationKey],
    );
    await client.query(
      "UPDATE execution.workflow_runs SET credit_settled_at=now() WHERE id=$1 AND credit_operation_key=$2",
      [attempt.workflow_run_id, operationKey],
    );
    return true;
  });
}
