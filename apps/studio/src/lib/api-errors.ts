/** No response at all: the Studio API is down or unreachable from the browser. */
export const STUDIO_API_UNREACHABLE = "studio_api_unreachable";

/**
 * Every workspace call on an installation nobody has claimed is refused with
 * this code. The app shell listens for it and opens the claim step instead of
 * letting each page report its own failed request.
 */
export const INSTANCE_UNCLAIMED = "instance_unclaimed";
export const INSTANCE_UNCLAIMED_EVENT = "beam-studio:instance-unclaimed";
export const INSTANCE_ACCESS_PATH = "/settings/access";

export function apiUnreachableMessage(apiUrl: string) {
  return `Studio can't reach its API at ${apiUrl}. Check that the Studio services are running.`;
}

/**
 * Whether `fetch` failed without a response. It rejects with a TypeError for
 * a refused connection, DNS failure or CORS rejection, and with an AbortError
 * (a DOMException) when the caller cancelled, which is not a failure.
 */
export function isNetworkFailure(error: unknown) {
  return error instanceof TypeError;
}

/** The API origin as the browser addresses it, for messages. */
export function apiDisplayUrl(requestUrl: string, pageOrigin?: string) {
  try {
    const url = new URL(requestUrl, pageOrigin);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return requestUrl;
  }
}

export function isInstanceUnclaimedResponse(status: number, code: unknown) {
  return status === 403 && code === INSTANCE_UNCLAIMED;
}

export function announceInstanceUnclaimed() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(INSTANCE_UNCLAIMED_EVENT));
}

export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly correlationId: string | null;
  readonly details: Record<string, unknown>;
  readonly action: string | null;
  readonly retryable: boolean;

  constructor(input: {
    message: string;
    code?: string;
    statusCode: number;
    correlationId?: string | null;
    details?: Record<string, unknown>;
    action?: string | null;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code ?? "request_error";
    this.statusCode = input.statusCode;
    this.correlationId = input.correlationId ?? null;
    this.details = input.details ?? {};
    this.action = input.action ?? null;
    this.retryable = input.retryable ?? false;
  }
}
