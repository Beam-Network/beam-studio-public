import {
  createCreditClient,
  type CreditClient,
  type MeterMeasure,
} from "./credit-client.js";
import {
  ActionNotBillableError,
  BILLABLE_ACTIONS,
  defaultApiKeyResolver,
  type ApiKeyResolver,
} from "./action-gate.js";
import { sumCredits } from "./credit-amount.js";
import { transferUsage } from "./transfer-price.js";

/**
 * A transfer step as the editor currently has it configured.
 *
 * `sourceBytes` is what the editor could size, not what the transfer will
 * necessarily move: a source it cannot list leaves it null, and a listing that
 * was truncated sets `partial`, which makes every total derived from it a floor.
 */
export type TransferProjection = {
  stepId: string;
  label: string;
  /** Summed size of this transfer's sources, in bytes, or null when unknown. */
  sourceBytes: string | null;
  destinationCount: number;
  partial: boolean;
};

export type WorkflowEstimateInput = {
  apiKeyId: string | null | undefined;
  organizationId?: string | null;
  transfers: TransferProjection[];
};

export type WorkflowEstimateLine = {
  kind: "workflow-run" | "transfer";
  label: string;
  stepId?: string;
  /** Credits for this one reservation, rounded up to 0.01. */
  credits: number;
  /** Bytes priced, or null when the volume is not known yet. */
  bytes: string | null;
  /**
   * The volume is unknown, so `credits` is only the floor this reservation
   * cannot go below — what the profile charges for zero bytes, which is its
   * minimum and may be zero.
   */
  volumeUnknown: boolean;
  /** The bytes are a floor: they came from a listing that was cut short. */
  partial: boolean;
};

export type WorkflowCreditEstimate = {
  /** Sum of the lines, exact at two decimals. */
  total: number;
  /** The total is a lower bound, because some line is a floor. */
  atLeast: boolean;
  lines: WorkflowEstimateLine[];
  /**
   * Credits the billing key may spend right now, rounded down to 0.01 and
   * never below zero, or null when no balance bounds it. Omitted when the
   * balance could not be read in time: the estimate never waits on, or fails
   * because of, the balance.
   */
  availableCredits?: number | null;
};

/** How long an estimate waits for the balance before answering without it. */
export const BALANCE_TIMEOUT_MS = 2_000;

const INVOCATION: MeterMeasure = { metric: "invocation", quantity: 1, unit: "count" };

/**
 * What running this workflow would cost, priced from the published price book.
 *
 * Two owners charge for one run and they are quoted separately, because that is
 * how they bill:
 *
 * - Studio reserves `workflow.run` once, priced per invocation.
 * - BeamCore settles each transfer on its own from the bytes it delivered.
 *
 * Credits are summed per reservation rather than pooled into one quote. Each
 * reservation rounds up to 0.01 credit on its own and carries its profile's
 * base and minimum, so a pooled quote can read cheaper than the bill. The sum
 * is taken in whole hundredths, never in floating point.
 */
export async function estimateWorkflowCredits(
  input: WorkflowEstimateInput,
  client: CreditClient = createCreditClient(),
  resolveApiKey: ApiKeyResolver = defaultApiKeyResolver,
  balanceTimeoutMs = BALANCE_TIMEOUT_MS,
): Promise<WorkflowCreditEstimate> {
  if (!input.apiKeyId) {
    throw new ActionNotBillableError(
      "A Beam API key must be selected before this workflow can be priced.",
    );
  }

  const rawApiKey = await resolveApiKey(input.apiKeyId, input.organizationId);
  if (!rawApiKey) {
    throw new ActionNotBillableError(
      "The selected Beam API key could not be read; re-enter it under Credentials.",
    );
  }

  // Read alongside the quotes, so the balance costs no time unless it is
  // slower than all of them, and then no more than its timeout.
  const balance = availableCreditsOrUnknown(client, rawApiKey, balanceTimeoutMs);

  // Beam prices under the key's own scope: an organization or billing-plan
  // price book applies here exactly as it will when the run is charged.
  //
  // Identical usage prices identically, so a graph repeating the same transfer
  // shape asks the billing API once rather than once per node.
  const quoted = new Map<string, Promise<number>>();
  const priceOf = (billingProfileId: string, usage: MeterMeasure[]) => {
    const signature = JSON.stringify([billingProfileId, usage]);
    const existing = quoted.get(signature);
    if (existing) return existing;
    const pending = client
      .quote(rawApiKey, { billingProfileId, usage })
      .then((result) => result.credits);
    quoted.set(signature, pending);
    return pending;
  };

  const runLine = priceOf(BILLABLE_ACTIONS["workflow.run"].billingProfileId, [
    INVOCATION,
  ]).then(
    (credits): WorkflowEstimateLine => ({
      kind: "workflow-run",
      label: "Workflow run",
      credits,
      bytes: null,
      volumeUnknown: false,
      partial: false,
    }),
  );

  const transferLines = input.transfers.map(async (transfer) => {
    const bytes = deliveredBytes(transfer);

    const credits = await priceOf(
      BILLABLE_ACTIONS["transfer.run"].billingProfileId,
      transferUsage(bytes ?? "0", transfer.destinationCount),
    );

    return {
      kind: "transfer" as const,
      label: transfer.label,
      stepId: transfer.stepId,
      credits,
      bytes,
      volumeUnknown: bytes === null,
      partial: transfer.partial && bytes !== null,
    };
  });

  const lines = await Promise.all([runLine, ...transferLines]);
  const availableCredits = await balance;

  return {
    total: sumCredits(lines.map((line) => line.credits)),
    atLeast: lines.some((line) => line.volumeUnknown || line.partial),
    lines,
    ...(availableCredits === undefined ? {} : { availableCredits }),
  };
}

/**
 * The key's balance, or undefined when it cannot be read within the timeout.
 *
 * Never rejects: a Beam without the balance route, an unreachable API or a
 * malformed answer leaves the estimate without a balance, and so without a
 * shortfall warning, rather than without an estimate.
 */
async function availableCreditsOrUnknown(
  client: CreditClient,
  apiKey: string,
  timeoutMs: number,
): Promise<number | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([
      client.availableCredits(apiKey, timeoutMs).catch(() => undefined),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bytes a transfer will have delivered when it is billed.
 *
 * BeamCore settles on `delivery_bytes_completed`, which counts every copy it
 * wrote: the same source sent to two destinations is delivered twice and billed
 * twice. Pricing the source size alone halves the bill for a two-destination
 * transfer.
 *
 * A transfer with no destination delivers nothing and is priced as zero bytes,
 * which costs whatever the profile charges for zero bytes.
 */
function deliveredBytes(transfer: TransferProjection) {
  if (transfer.sourceBytes === null) return null;

  const sourceBytes = BigInt(transfer.sourceBytes);
  const destinations = BigInt(Math.max(0, Math.trunc(transfer.destinationCount)));

  return (sourceBytes * destinations).toString();
}
