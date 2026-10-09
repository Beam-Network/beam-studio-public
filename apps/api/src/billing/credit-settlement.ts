import type { PgPool } from "@beam-studio/db";
import {
  createCreditClient,
  CreditReservationError,
  type CreditClient,
} from "./credit-client.js";
import {
  settleWorkflowBillingAttempt,
  storeBillingKeys,
  type WorkflowBillingKeys,
} from "./workflow-billing.js";

/**
 * Run states that end a reservation, and how each one settles.
 *
 * Only work that actually happened is charged: a run that failed or was
 * cancelled releases its hold instead of spending it.
 */
const SETTLEMENT_BY_STATUS: Record<string, "commit" | "cancel" | "fail"> = {
  completed: "commit",
  succeeded: "commit",
  failed: "fail",
  cancelled: "cancel",
  canceled: "cancel",
};

type PendingSettlement = {
  id: string;
  status: string;
  credit_operation_key: string;
  organization_id: string;
};

const SETTLEABLE_STATUSES = Object.keys(SETTLEMENT_BY_STATUS);

/**
 * Settle credit reservations for runs that have reached a terminal state.
 *
 * Deliberately a separate pass rather than a step in the run lifecycle: billing
 * must never sit between a run and its next state, and a reservation that is
 * settled late is far better than a run that stalls waiting on the billing API.
 *
 * Idempotent — a row is only marked settled after the remote call returns, and
 * the remote lifecycle itself is keyed on the operation id, so a repeated pass
 * cannot double-charge. A hold with no usable Beam API key stays pending and
 * is retried on the next pass.
 */
export async function settleCreditReservations(
  pool: PgPool,
  client?: CreditClient,
  keys: WorkflowBillingKeys = storeBillingKeys,
): Promise<{ settled: number }> {
  let settled = 0;
  const failures: unknown[] = [];
  const workflows = await pool.query<{ operation_key: string }>(
    "SELECT operation_key FROM execution.workflow_billing_attempts WHERE outcome IS NOT NULL AND settled_at IS NULL ORDER BY updated_at,created_at LIMIT 200",
  );
  for (const row of workflows.rows) {
    try {
      if (
        await settleWorkflowBillingAttempt(
          pool,
          row.operation_key,
          client,
          keys,
        )
      )
        settled++;
    } catch (error) {
      failures.push(error);
    }
  }

  // Beam scopes settlement to the organization rather than the key that
  // reserved, so a legacy run settles with its organization's default key.
  const legacyClient = client ?? createCreditClient();
  for (const row of await selectPending(pool)) {
    const outcome = SETTLEMENT_BY_STATUS[row.status];
    if (!outcome) continue;
    try {
      const apiKey = await keys.organization(row.organization_id);
      if (!apiKey)
        throw new CreditReservationError(
          "billing_unavailable",
          "The organization has no usable Beam API key to settle this hold.",
          503,
        );

      if (outcome === "commit") {
        await legacyClient.commit(apiKey, row.credit_operation_key);
      } else if (outcome === "cancel") {
        await legacyClient.cancel(
          apiKey,
          row.credit_operation_key,
          "run cancelled",
        );
      } else {
        await legacyClient.fail(apiKey, row.credit_operation_key, "run failed");
      }

      await pool.query(
        "UPDATE public.runs SET credit_settled_at = now() WHERE id = $1 AND credit_operation_key=$2 AND status=$3",
        [row.id, row.credit_operation_key, row.status],
      );
      settled += 1;
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length)
    throw new AggregateError(
      failures,
      "Billing settlements remain pending and will be retried.",
    );
  return { settled };
}

const SETTLEMENT_INTERVAL_MS = 30_000;

type SettlementLogger = {
  error: (context: Record<string, unknown>, message: string) => void;
};

/**
 * Run settlement on an interval until stopped.
 *
 * A failed pass is logged and retried on the next tick rather than escalated:
 * the reservation stays outstanding, which is recoverable, whereas crashing the
 * API over a billing hiccup is not.
 */
export function startCreditSettlementLoop(
  pool: PgPool,
  logger: SettlementLogger,
  intervalMs = SETTLEMENT_INTERVAL_MS,
) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void settleCreditReservations(pool)
      .catch((error) => {
        logger.error({ error }, "Credit settlement pass failed");
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  // Settlement must not hold the process open at shutdown.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function selectPending(pool: PgPool): Promise<PendingSettlement[]> {
  try {
    const result = await pool.query(
      `SELECT r.id, r.status, r.credit_operation_key, t.organization_id
         FROM public.runs r
         JOIN public.transfer_templates t ON t.id = r.transfer_template_id
        WHERE r.credit_operation_key IS NOT NULL
          AND r.credit_settled_at IS NULL
          AND r.status = ANY($1)
        LIMIT 200`,
      [SETTLEABLE_STATUSES],
    );

    return result.rows as PendingSettlement[];
  } catch (error) {
    // The legacy transfer tables are not created by the target schema and may
    // be absent in a fresh install; a missing table means nothing to settle.
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
}
