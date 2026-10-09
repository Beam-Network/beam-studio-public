import { ActionExecutionError, ActionInputError } from "../../../actions.js";
import {
  DEFAULT_RETRY,
  RETRYABLE_STATUS,
  backoffMs,
  retryAfterMs,
  transportMessage,
  type RetryOptions,
} from "../http/retry.js";

/**
 * HTTP layer for the Salesforce actions.
 *
 * The backoff arithmetic is shared (see ../http/retry.ts). What stays here is
 * the part that is genuinely Salesforce's: it distinguishes three failure
 * classes that look alike over HTTP.
 *
 *   - transient (429, 5xx)          -> retry with backoff
 *   - the request is wrong (4xx)    -> never retry; the next attempt fails too
 *   - the org is out of quota       -> never retry, even though it arrives as
 *                                      a 403. Backing off against a governor
 *                                      limit spends the org's remaining daily
 *                                      calls on attempts that cannot succeed.
 *
 * Retry-After is honoured when present; Salesforce sends it on 429 and it is
 * more accurate than any backoff we compute.
 */

// Re-exported so the Salesforce actions and their tests keep one import site.
export { RETRYABLE_STATUS, backoffMs, retryAfterMs, type RetryOptions };

/**
 * Salesforce error codes that are terminal despite arriving as 4xx. Retrying
 * these makes the situation worse rather than better.
 */
export const NON_RETRYABLE_CODES = new Set([
  "REQUEST_LIMIT_EXCEEDED",
  "TOTAL_REQUESTS_LIMIT_EXCEEDED",
  "API_DISABLED_FOR_ORG",
  "INVALID_SESSION_ID",
  "INSUFFICIENT_ACCESS",
  "INSUFFICIENT_ACCESS_OR_READONLY",
]);

export type SalesforceRequest = {
  url: string;
  method?: string;
  accessToken: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Defaults to application/json; Bulk uploads send text/csv. */
  contentType?: string;
  accept?: string;
  signal?: AbortSignal;
};

export type SalesforceResponse = {
  status: number;
  headers: Headers;
  text: string;
};

/**
 * Performs a Salesforce request, retrying only what is worth retrying, and
 * raising an ActionExecutionError whose `retryable` flag the workflow engine
 * uses to decide whether to reschedule the step.
 */
export async function salesforceFetch(
  request: SalesforceRequest,
  options: RetryOptions = {},
): Promise<SalesforceResponse> {
  const settings = { ...DEFAULT_RETRY, ...options };
  const doFetch = options.fetchImpl ?? fetch;
  let lastError: ActionExecutionError | null = null;

  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      const init: RequestInit = {
        method: request.method ?? "GET",
        headers: {
          Authorization: `Bearer ${request.accessToken}`,
          Accept: request.accept ?? "application/json",
          ...(request.body === undefined
            ? {}
            : { "Content-Type": request.contentType ?? "application/json" }),
          ...request.headers,
        },
      };
      if (request.body !== undefined) {
        init.body = request.body as BodyInit;
      }
      if (request.signal) {
        init.signal = request.signal;
      }
      response = await doFetch(request.url, init);
    } catch (error) {
      // A transport failure is retryable, but the message must be legible:
      // Node reports every one of these as a bare "fetch failed".
      lastError = new ActionExecutionError(
        transportMessage(error, "Salesforce"),
        { retryable: true },
      );
      if (attempt === settings.maxAttempts) {
        throw lastError;
      }
      await settings.sleep(backoffMs(attempt, settings));
      continue;
    }

    const text = await response.text();
    if (response.ok) {
      return { status: response.status, headers: response.headers, text };
    }

    const failure = describeFailure(response.status, text);
    lastError = new ActionExecutionError(failure.message, {
      retryable: failure.retryable,
    });
    if (!failure.retryable || attempt === settings.maxAttempts) {
      throw lastError;
    }

    await settings.sleep(
      retryAfterMs(response.headers) ?? backoffMs(attempt, settings),
    );
  }

  throw lastError ?? new ActionExecutionError("Salesforce request failed.");
}

/** Convenience wrapper for the JSON endpoints, which is most of them. */
export async function salesforceJson<T = unknown>(
  request: SalesforceRequest,
  options: RetryOptions = {},
): Promise<T> {
  const response = await salesforceFetch(request, options);
  if (!response.text) {
    return undefined as T;
  }
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new ActionExecutionError(
      "Salesforce returned a response that was not valid JSON.",
      { retryable: false },
    );
  }
}

/**
 * Classifies a failed response.
 *
 * Salesforce returns errors as `[{ errorCode, message }]` on most endpoints and
 * as `{ error, error_description }` on the OAuth ones, so both are read.
 */
export function describeFailure(status: number, body: string) {
  const parsed = parseErrorBody(body);
  const code = parsed.errorCode;

  if (code && NON_RETRYABLE_CODES.has(code)) {
    return {
      retryable: false,
      message: `Salesforce ${code}: ${parsed.message}`,
    };
  }

  return {
    retryable: RETRYABLE_STATUS.has(status),
    message: code
      ? `Salesforce ${code}: ${parsed.message}`
      : `Salesforce returned HTTP ${status}${parsed.message ? `: ${parsed.message}` : "."}`,
  };
}

function parseErrorBody(body: string) {
  if (!body.trim()) {
    return { errorCode: "", message: "" };
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first && typeof first === "object") {
      const record = first as Record<string, unknown>;
      return {
        errorCode: str(record.errorCode) || str(record.error),
        message:
          str(record.message) ||
          str(record.error_description) ||
          str(record.errorCode),
      };
    }
  } catch {
    // Not JSON; fall through and use the raw body.
  }
  return { errorCode: "", message: body.slice(0, 300) };
}

export function requireText(value: unknown, label: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new ActionInputError(`${label} is required.`);
  }
  return text;
}

export function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
