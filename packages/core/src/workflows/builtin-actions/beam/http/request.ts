import {
  ActionExecutionError,
  ActionInputError,
  type ActionContext,
} from "../../../actions.js";
import {
  DEFAULT_RETRY,
  RETRYABLE_STATUS,
  backoffMs,
  retryAfterMs,
  transportMessage,
  type RetryOptions,
} from "./retry.js";

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
] as const;
export const DEFAULT_HTTP_TIMEOUT_SECONDS = 30;
export const MAX_HTTP_TIMEOUT_SECONDS = 120;

export type HttpCredential = {
  token: string;
  signingSecret: string;
  baseUrl: string;
};

export function httpUrl(value: unknown, subject: string) {
  const url = text(value);
  if (!url) throw new ActionInputError(`${subject} requires a URL.`);
  if (!/^https?:\/\//i.test(url)) {
    throw new ActionInputError(`${subject} URL must use http:// or https://.`);
  }
  return url;
}

export function httpMethod(
  value: unknown,
  allowed: readonly string[] = HTTP_METHODS,
) {
  const method = (text(value) || "GET").toUpperCase();
  if (!allowed.includes(method)) {
    throw new ActionInputError(
      `Method "${method}" must be one of ${allowed.join(", ")}.`,
    );
  }
  return method;
}

export function httpTimeoutMs(value: unknown) {
  const seconds =
    typeof value === "number" && value > 0
      ? value
      : DEFAULT_HTTP_TIMEOUT_SECONDS;
  return Math.min(seconds, MAX_HTTP_TIMEOUT_SECONDS) * 1000;
}

export async function resolveHttpCredential(
  context: ActionContext,
  credentialId: string,
): Promise<HttpCredential> {
  const raw = await context.secrets.get(credentialId);
  if (!raw) {
    throw new ActionInputError(
      `HTTP credential "${credentialId}" could not be resolved.`,
    );
  }
  let token = "";
  let signingSecret = "";
  let baseUrl = "";
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    token = text(payload.token);
    signingSecret = text(payload.signing_secret);
    baseUrl = text(payload.base_url);
  } catch {
    token = raw.trim();
  }
  if (!token && !signingSecret && !baseUrl) {
    throw new ActionInputError("The HTTP credential is empty.");
  }
  return { token, signingSecret: signingSecret || token, baseUrl };
}

export async function requestWithRetry(
  request: {
    url: string;
    init: RequestInit;
    timeoutMs: number;
    signal: AbortSignal;
    subject: string;
  },
  options: RetryOptions = {},
) {
  const settings = { ...DEFAULT_RETRY, ...options };
  const doFetch = options.fetchImpl ?? fetch;
  let lastError: ActionExecutionError | null = null;

  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await doFetch(request.url, {
        ...request.init,
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(request.timeoutMs),
        ]),
      });
    } catch (error) {
      lastError = new ActionExecutionError(
        transportMessage(error, request.subject),
        { retryable: true },
      );
      if (attempt === settings.maxAttempts) throw lastError;
      await settings.sleep(backoffMs(attempt, settings));
      continue;
    }

    if (response.ok) return response;

    const retryable = RETRYABLE_STATUS.has(response.status);
    lastError = new ActionExecutionError(
      `The ${request.subject} returned HTTP ${response.status}.`,
      { retryable },
    );
    if (!retryable || attempt === settings.maxAttempts) throw lastError;
    await settings.sleep(
      retryAfterMs(response.headers) ?? backoffMs(attempt, settings),
    );
  }

  throw lastError ?? new ActionExecutionError(`The ${request.subject} failed.`);
}

export function responseHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export async function responseBody(response: Response) {
  if (response.status === 204 || response.status === 205) return null;
  const raw = await response.text();
  if (!raw) return null;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ActionExecutionError(
        "The HTTP response declared JSON but contained invalid JSON.",
        { retryable: false },
      );
    }
  }
  return raw;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
