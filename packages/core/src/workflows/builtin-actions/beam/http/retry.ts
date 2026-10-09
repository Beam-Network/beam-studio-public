/**
 * Outbound HTTP retry mechanics shared by the actions that call third-party
 * APIs.
 *
 * The classification of *which* failures are worth retrying is provider
 * specific and stays with each provider — Salesforce turns a 403 governor limit
 * into a terminal error, Slack answers 200 for a refusal. What is not provider
 * specific is the arithmetic: the backoff curve, reading `Retry-After`, and
 * turning Node's uniformly unhelpful "fetch failed" into a message that names
 * the actual problem. Those live here so the next integration does not copy
 * them a third time.
 */

/** Statuses that will plausibly succeed on a later attempt. */
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected in tests so retry behaviour can be asserted without waiting. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  fetchImpl?: typeof fetch;
};

export const DEFAULT_RETRY: Required<Omit<RetryOptions, "fetchImpl">> = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Exponential backoff with 50-150% jitter, so retries do not synchronise. */
export function backoffMs(
  attempt: number,
  settings: { baseDelayMs: number; maxDelayMs: number; random: () => number },
) {
  const exponential = Math.min(
    settings.baseDelayMs * 2 ** (attempt - 1),
    settings.maxDelayMs,
  );
  return Math.round(exponential * (0.5 + settings.random()));
}

/** Retry-After is either seconds or an HTTP date. */
export function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * Node reports every transport failure as a bare "fetch failed" and hides the
 * cause one level down, which makes a wrong hostname and a refused connection
 * read identically in a run log. `subject` names the thing being called so the
 * message says which endpoint failed.
 */
export function transportMessage(error: unknown, subject: string) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return `The ${subject} request timed out.`;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (error.message === "fetch failed" && cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    if (code === "ENOTFOUND") {
      return `That ${subject} host does not exist. Check the URL.`;
    }
    if (code === "ECONNREFUSED") {
      return `The ${subject} host refused the connection.`;
    }
    return `${cause.message}${code ? ` (${code})` : ""}`;
  }
  return error.message;
}
