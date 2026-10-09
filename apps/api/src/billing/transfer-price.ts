import {
  createCreditClient,
  type CreditClient,
  type MeterMeasure,
} from "./credit-client.js";
import {
  BILLABLE_ACTIONS,
  defaultApiKeyResolver,
  type ApiKeyResolver,
} from "./action-gate.js";

/**
 * Metric and unit BeamCore's transfer settlement is priced under.
 *
 * A rate matches usage only when metric and unit agree exactly; anything else
 * is unrated and silently falls through to the profile minimum, which reads as
 * a pricing bug and is a units bug.
 */
const BANDWIDTH_METRIC = "bandwidth";
const BANDWIDTH_UNIT = "bytes";

/**
 * Endpoints a transfer touches, which is how fan-out is priced.
 *
 * `beam.transfer.v1` charges per destination connector, and the price book
 * decides how many are included — currently the first, through a rate-level
 * allowance. The estimate reports the full count and lets the catalogue apply
 * that: subtracting here would double the discount the moment the allowance
 * changes, and would go stale silently because nothing compares the two.
 */
const CONNECTOR_METRIC = "connector";
const CONNECTOR_UNIT = "operation";

/**
 * What one transfer is metered as when BeamCore settles it: the bytes it
 * delivered (every copy it wrote, so a source sent to two destinations counts
 * twice), one source connector and each destination connector.
 */
export function transferUsage(
  deliveredBytes: string,
  destinationCount: number,
): MeterMeasure[] {
  return [
    {
      metric: BANDWIDTH_METRIC,
      quantity: deliveredBytes,
      unit: BANDWIDTH_UNIT,
    },
    {
      metric: CONNECTOR_METRIC,
      quantity: 1,
      unit: CONNECTOR_UNIT,
      attributes: { role: "source" },
    },
    {
      metric: CONNECTOR_METRIC,
      quantity: Math.max(0, Math.trunc(destinationCount)),
      unit: CONNECTOR_UNIT,
      attributes: { role: "destination" },
    },
  ];
}

export type TransferPriceInput = {
  /** Studio's id for the Beam API key the transfer's runs are charged to. */
  apiKeyId: string | null | undefined;
  organizationId?: string | null;
  /** Bytes the transfer delivers per run, across all its destinations. */
  deliveredBytes: string;
  destinationCount: number;
};

/** How long a quoted transfer price is reused before Beam is asked again. */
export const TRANSFER_PRICE_TTL_MS = 5 * 60_000;

/** How long a read waits for a quote before answering without it. */
export const TRANSFER_PRICE_TIMEOUT_MS = 2_000;

/** Quotes kept before expired ones are swept. */
const MAX_CACHED_PRICES = 500;

/** Credits one run of a transfer costs, or null when no price can be had. */
export type TransferPricer = (
  input: TransferPriceInput,
) => Promise<number | null>;

/**
 * Price transfers from the published price book.
 *
 * The price is the `beam.transfer.v1` quote Beam answers for the transfer's
 * usage under the key its runs are charged to, so an organization or
 * billing-plan price book applies exactly as it will on the bill. The amount is
 * rounded up to 0.01 credit (`parseQuoteCredits`).
 *
 * Pricing is a read, never part of a write: a transfer or schedule is saved
 * with its byte totals only, and the price is asked when those are shown.
 *
 * A quote is reused for `TRANSFER_PRICE_TTL_MS` per key and usage, so a list
 * asks Beam once per distinct transfer shape rather than on every read, and a
 * price book change shows within that time. A read waits at most
 * `TRANSFER_PRICE_TIMEOUT_MS`; a slower quote keeps going and is reused by the
 * next read. No key, an unreadable key, a refused key, an unreachable Beam or a
 * malformed answer is null — "estimate unavailable" — and is not remembered, so
 * the next read asks again.
 */
export function createTransferPricer(
  options: {
    client?: () => CreditClient;
    resolveApiKey?: ApiKeyResolver;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): TransferPricer {
  const client = options.client ?? (() => createCreditClient());
  const resolveApiKey = options.resolveApiKey ?? defaultApiKeyResolver;
  const ttlMs = options.ttlMs ?? TRANSFER_PRICE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? TRANSFER_PRICE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<
    string,
    { expiresAt: number; credits: Promise<number | null> }
  >();

  const quote = async (
    apiKeyId: string,
    input: TransferPriceInput,
    usage: MeterMeasure[],
  ) => {
    const rawApiKey = await resolveApiKey(apiKeyId, input.organizationId);
    if (!rawApiKey) return null;
    const result = await client().quote(rawApiKey, {
      billingProfileId: BILLABLE_ACTIONS["transfer.run"].billingProfileId,
      usage,
    });
    return result.credits;
  };

  return async (input) => {
    const apiKeyId = input.apiKeyId;
    if (!apiKeyId) return null;

    const usage = transferUsage(input.deliveredBytes, input.destinationCount);
    const signature = JSON.stringify([
      input.organizationId ?? null,
      apiKeyId,
      usage,
    ]);

    let entry = cache.get(signature);
    if (!entry || entry.expiresAt <= now()) {
      if (cache.size >= MAX_CACHED_PRICES) {
        for (const [key, cached] of cache) {
          if (cached.expiresAt <= now()) cache.delete(key);
        }
      }
      const created = {
        expiresAt: now() + ttlMs,
        credits: quote(apiKeyId, input, usage).catch(() => null),
      };
      void created.credits.then((credits) => {
        if (credits === null && cache.get(signature) === created)
          cache.delete(signature);
      });
      cache.set(signature, created);
      entry = created;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      return await Promise.race([entry.credits, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The pricer every Studio read shares, so its quotes are reused across requests. */
export const priceTransfer: TransferPricer = createTransferPricer();
