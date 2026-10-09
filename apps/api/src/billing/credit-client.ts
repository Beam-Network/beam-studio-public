import { webEnv } from "../env.js";
import { parseCreditAmount } from "./credit-amount.js";

/**
 * Why a billable action was refused. Mirrors the Beam API's reason codes so
 * Studio can tell the operator which lever to pull: an organization has one
 * credit pool but many API keys, and an empty pool, a spent key cap and a
 * blocked key budget are fixed in three different places.
 */
export type CreditDenialReason =
  | "pool_exhausted"
  | "key_cap_exhausted"
  | "key_budget_blocked";

export class CreditReservationError extends Error {
  constructor(
    readonly code:
      | "insufficient_credit"
      | "invalid_key"
      | "billing_unavailable",
    message: string,
    readonly statusCode: number,
    readonly reason?: CreditDenialReason,
  ) {
    super(message);
    this.name = "CreditReservationError";
  }
}

export type MeterMeasure = {
  metric: string;
  quantity: number | string;
  unit: string;
  attributes?: Record<string, string>;
};

export type ReserveCreditInput = {
  /**
   * Stable per-action key, prefixed with the action; a retried enqueue must
   * not charge twice.
   */
  idempotencyKey: string;
  action: string;
  usage: MeterMeasure[];
  transferId?: string;
};

export type ReserveCreditResult = {
  idempotencyKey: string;
  /** Credits held, rounded up to 0.01. */
  creditsUsed: number;
  replayed: boolean;
  status: string | null;
};

export type WorkflowBillingReceipt = {
  found: boolean;
  operation: {
    idempotencyKey: string;
    apiKeyId: string;
    action: string | null;
    status: string;
    creditsUsed: number;
  } | null;
  settlement: string | null;
};

export type QuoteCreditInput = {
  billingProfileId: string;
  usage: MeterMeasure[];
};

/** One priced line of a quote: what was metered and what it cost. */
export type QuoteCreditCharge = {
  metric: string;
  unit: string;
  attributes: Record<string, string>;
  quantity: string;
  microcredits: string;
};

export type QuoteCreditResult = {
  /** Credits this one reservation would cost, rounded up to 0.01. */
  credits: number;
  charges: QuoteCreditCharge[];
};

type QuoteResponse = {
  success: boolean;
  error?: string;
  credits?: number;
  quote?: {
    usageCharges?: Array<{
      usage: {
        metric: string;
        unit: string;
        quantity: string;
        attributes?: Record<string, string>;
      };
      chargedMicrocredits: string;
    }>;
  };
};

/**
 * Credits a key may spend right now, from `GET /v1/credits/available`: the
 * organization's pool net of outstanding holds, bounded by the key's own cap.
 * `null` means no balance bounds the key.
 */
type AvailableCreditsResponse = {
  success?: boolean;
  availableCredits?: unknown;
};

/**
 * The balance in a `GET /v1/credits/available` body: credits rounded down to
 * 0.01, null when no balance bounds the key, or undefined when the body is not
 * that answer.
 *
 * An overdrawn pool reports a negative balance; nothing is available from it,
 * so it reads as zero.
 */
export function parseAvailableCredits(
  json: unknown,
): number | null | undefined {
  if (!json || typeof json !== "object") return undefined;
  const body = json as AvailableCreditsResponse;
  if (body.success !== true) return undefined;
  if (body.availableCredits === null) return null;
  const credits = parseCreditAmount(body.availableCredits, "down");
  return credits === undefined ? undefined : Math.max(0, credits);
}

/**
 * The amount in a `POST /v1/pricing/quote` body rounded up to 0.01, or
 * undefined when it is not a credit amount. Beam quotes to the microcredit; a
 * positive price never reads lower than it is (0.010738 is 0.02). A price is
 * never negative; a negative one is a fault on the billing side, not a discount
 * to pass on.
 */
export function parseQuoteCredits(json: unknown): number | undefined {
  if (!json || typeof json !== "object") return undefined;
  const credits = parseCreditAmount((json as QuoteResponse).credits, "up");
  return credits === undefined || credits < 0 ? undefined : credits;
}

type ReserveResponse = {
  success: boolean;
  error?: string;
  reason?: CreditDenialReason;
  replayed?: boolean;
  operation?: { idempotencyKey: string; creditsUsed: number; status?: string };
};

type PostResult<T> = {
  ok: boolean;
  status: number;
  json: (T & { error?: string; reason?: CreditDenialReason }) | null;
};

/**
 * Reserve, settle and release credit against the Beam API.
 *
 * Reserving takes a hold; committing is what actually spends. Anything that
 * starts a billable action must reserve first and then settle exactly once, so a
 * run that never happened is never charged.
 *
 * Every call authenticates with the organization's own Beam API key. Beam takes
 * the organization, price scope and permission from that key, so Studio holds
 * no shared secret and a self-hosted install bills like any other.
 */
export class CreditClient {
  constructor(
    private readonly options: {
      apiUrl: string;
      fetch: typeof globalThis.fetch;
    },
  ) {}

  /**
   * Exchange a raw Beam API key for the key id the credit ledger records.
   *
   * Studio stores keys under its own local ids, which mean nothing to the Beam
   * API, so the raw secret is the only thing the two sides agree on. This also
   * rejects a key that cannot pay before any work begins.
   */
  async resolveKeyId(apiKey: string): Promise<string> {
    const response = await this.post<{ valid?: boolean; keyId?: string }>(
      apiKey,
      "/api/keys/verify",
      { apiKey },
    );
    if (!response.ok || !response.json?.keyId)
      throw refusal(
        response,
        `Key verification failed with ${response.status}`,
      );
    return response.json.keyId;
  }

  /** Beam prices the hold and checks the action's permission from the key. */
  async reserve(
    apiKey: string,
    input: ReserveCreditInput,
  ): Promise<ReserveCreditResult> {
    const response = await this.post<ReserveResponse>(
      apiKey,
      "/v1/usage/reservations",
      {
        idempotencyKey: input.idempotencyKey,
        action: input.action,
        usage: input.usage,
        transferId: input.transferId,
      },
    );
    if (!response.ok)
      throw refusal(
        response,
        `Credit reservation failed with ${response.status}`,
      );

    return {
      idempotencyKey:
        response.json?.operation?.idempotencyKey ?? input.idempotencyKey,
      creditsUsed:
        parseCreditAmount(response.json?.operation?.creditsUsed, "up") ?? 0,
      replayed: Boolean(response.json?.replayed),
      status: response.json?.operation?.status ?? null,
    };
  }

  async workflowOperation(
    apiKey: string,
    operationKey: string,
  ): Promise<WorkflowBillingReceipt> {
    const response = await this.post<WorkflowBillingReceipt>(
      apiKey,
      "/v1/workflow-billing/lookup",
      { operationKey },
    );
    if (!response.ok || typeof response.json?.found !== "boolean")
      throw refusal(response, "Workflow billing lookup was not confirmed");
    return response.json;
  }

  async settleWorkflowOperation(
    apiKey: string,
    operationKey: string,
    outcome: "completed" | "failed" | "cancelled",
  ) {
    const response = await this.post<{ confirmed?: boolean; status?: string }>(
      apiKey,
      "/v1/workflow-billing/settle",
      { operationKey, outcome },
    );
    const expected = {
      completed: "COMMITTED",
      failed: "FAILED",
      cancelled: "CANCELED",
    }[outcome];
    if (
      !response.ok ||
      response.json?.confirmed !== true ||
      response.json.status !== expected
    )
      throw refusal(response, "Workflow billing settlement was not confirmed");
  }

  /**
   * What an action would cost, without charging for it.
   *
   * Deliberately not a reserve followed by a cancel: reserving writes a usage
   * operation, moves the key's counters and can charge a saved card through
   * auto top-up. Asking a price must do none of that.
   *
   * The amount is credits for one reservation, rounded up to 0.01. Pricing
   * several actions means summing these amounts, never summing usage into a
   * single quote: each reservation rounds up on its own and carries its
   * profile's base and minimum, so one pooled quote can read cheaper than the
   * bill.
   */
  async quote(
    apiKey: string,
    input: QuoteCreditInput,
  ): Promise<QuoteCreditResult> {
    const response = await this.post<QuoteResponse>(
      apiKey,
      "/v1/pricing/quote",
      {
        billingProfileId: input.billingProfileId,
        usage: input.usage,
      },
    );
    const credits = response.ok ? parseQuoteCredits(response.json) : undefined;
    if (credits === undefined)
      throw refusal(response, `Credit quote failed with ${response.status}`);

    return {
      credits,
      charges: (response.json?.quote?.usageCharges ?? []).map((charge) => ({
        metric: charge.usage.metric,
        unit: charge.usage.unit,
        attributes: charge.usage.attributes ?? {},
        quantity: charge.usage.quantity,
        microcredits: charge.chargedMicrocredits,
      })),
    };
  }

  /**
   * Credits this key may spend right now, or null when no balance bounds it.
   *
   * A read: it takes no hold and never reaches auto top-up. It throws when the
   * balance cannot be read — an older Beam without the route answers 404 — so
   * a caller that can do without it decides what that means.
   */
  async availableCredits(
    apiKey: string,
    timeoutMs: number,
  ): Promise<number | null> {
    const response = await this.request<AvailableCreditsResponse>(
      apiKey,
      "/v1/credits/available",
      { method: "GET", timeoutMs },
    );
    const availableCredits = response.ok
      ? parseAvailableCredits(response.json)
      : undefined;
    if (availableCredits === undefined)
      throw refusal(
        response,
        `Credit balance read failed with ${response.status}`,
      );
    return availableCredits;
  }

  /** Settle a hold. This is the point credits leave the pool. */
  async commit(apiKey: string, idempotencyKey: string) {
    await this.release(apiKey, idempotencyKey, "commit");
  }

  async cancel(apiKey: string, idempotencyKey: string, reason?: string) {
    await this.release(apiKey, idempotencyKey, "cancel", reason);
  }

  async fail(apiKey: string, idempotencyKey: string, reason?: string) {
    await this.release(apiKey, idempotencyKey, "fail", reason);
  }

  /** Only confirmed settlement may clear a durable pending billing record. */
  private async release(
    apiKey: string,
    idempotencyKey: string,
    outcome: "commit" | "cancel" | "fail",
    reason?: string,
  ) {
    const response = await this.post<{ success?: boolean }>(
      apiKey,
      `/v1/usage/reservations/${encodeURIComponent(idempotencyKey)}/${outcome}`,
      { reason },
    );
    if (!response.ok || response.json?.success !== true)
      throw refusal(response, "Billing settlement was not confirmed");
  }

  private post<T>(
    apiKey: string,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<PostResult<T>> {
    return this.request<T>(apiKey, path, {
      method: "POST",
      payload,
      timeoutMs: 8_000,
    });
  }

  private async request<T>(
    apiKey: string,
    path: string,
    init: {
      method: "GET" | "POST";
      payload?: Record<string, unknown>;
      timeoutMs: number;
    },
  ): Promise<PostResult<T>> {
    let response: Response;
    try {
      response = await this.options.fetch(new URL(path, this.options.apiUrl), {
        method: init.method,
        headers: init.payload
          ? {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            }
          : { authorization: `Bearer ${apiKey}` },
        ...(init.payload ? { body: JSON.stringify(init.payload) } : {}),
        signal: AbortSignal.timeout(init.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new CreditReservationError(
        "billing_unavailable",
        "Beam billing API is unreachable",
        503,
      );
    }

    const json = (await response
      .json()
      .catch(() => null)) as PostResult<T>["json"];

    return { ok: response.ok, status: response.status, json };
  }
}

/**
 * 402 is the only refusal a caller can act on, and a rejected key is fixed
 * under Credentials; everything else is a fault on our side and must not be
 * reported as "out of credit".
 */
function refusal(response: PostResult<unknown>, fallback: string) {
  if (response.status === 402)
    return new CreditReservationError(
      "insufficient_credit",
      response.json?.error || "Insufficient credits",
      402,
      response.json?.reason,
    );
  if (response.status === 401 || response.status === 403)
    return new CreditReservationError(
      "invalid_key",
      response.json?.error || "The Beam API key was rejected",
      response.status,
      response.json?.reason,
    );
  return new CreditReservationError(
    "billing_unavailable",
    response.json?.error || fallback,
    response.ok ? 503 : response.status,
  );
}

export function createCreditClient(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  apiUrl: string = webEnv.apiUrl,
) {
  return new CreditClient({ apiUrl, fetch: fetchImpl });
}
