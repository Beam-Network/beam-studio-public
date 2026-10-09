import {
  ApiError,
  STUDIO_API_UNREACHABLE,
  announceInstanceUnclaimed,
  apiDisplayUrl,
  apiUnreachableMessage,
  isInstanceUnclaimedResponse,
  isNetworkFailure,
} from "./api-errors";
import { selectedRoomTemplateKey } from "./beam-environments";
import { studioEnv } from "./env";

export type ApiHealth = {
  ok: boolean;
  service?: string;
};

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await apiResponse(path, init);
  return (await response.json()) as T;
}

export async function apiConditionalGet<T>(path: string, etag?: string, signal?: AbortSignal): Promise<T | null> {
  const response = await apiResponse(path, { cache: "no-store", signal,
    headers: etag ? { "If-None-Match": etag } : undefined,
  });
  return response.status === 304 ? null : (await response.json()) as T;
}

async function apiResponse(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (
    /^\/studio\/(rooms|room-consumers|agents|agent-enrollments)/.test(path) &&
    !headers.has("x-beam-environment-template")
  ) {
    const templateKey = selectedRoomTemplateKey();
    if (templateKey) headers.set("x-beam-environment-template", templateKey);
  }
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(apiUrlForPath(path), {
      credentials: "include",
      ...init,
      headers,
    });
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
    // The browser's own text ("Failed to fetch", "NetworkError when
    // attempting to fetch resource") names neither the service nor a fix.
    throw new ApiError({
      message: apiUnreachableMessage(
        apiDisplayUrl(
          apiUrlForPath("/"),
          typeof window === "undefined" ? undefined : window.location.origin,
        ),
      ),
      code: STUDIO_API_UNREACHABLE,
      statusCode: 0,
      retryable: true,
    });
  }

  if (!response.ok && response.status !== 304) {
    const responseText = await response.text();
    const payload = parseErrorPayload(responseText);
    const message =
      stringValue(payload.error) ??
      (responseText
        ? `API request failed with ${response.status}: ${responseText}`
        : `API request failed with ${response.status}`);
    console.error("Studio API request failed", {
      method: init?.method ?? "GET",
      path,
      status: response.status,
      body: responseText,
    });
    if (isInstanceUnclaimedResponse(response.status, payload.code)) {
      announceInstanceUnclaimed();
    }
    throw new ApiError({
      message,
      code: stringValue(payload.code) ?? undefined,
      statusCode: response.status,
      correlationId: stringValue(payload.correlationId),
      details: recordValue(payload.details),
      action: stringValue(payload.action),
      retryable: payload.retryable === true,
    });
  }

  return response;
}

function parseErrorPayload(value: string) {
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function apiUrlForPath(path: string) {
  const base = shouldUseSameOriginProxy(studioEnv.apiUrl)
    ? "/__studio_api"
    : studioEnv.apiUrl;

  if (base.startsWith("/")) {
    return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  }

  return new URL(path, base).toString();
}

export function apiWebSocketUrlForPath(path: string) {
  const httpUrl = apiUrlForPath(path);
  const url = new URL(
    httpUrl,
    typeof window === "undefined" ? "http://localhost" : window.location.href,
  );
  if (/^\/studio\/agents\/[^/]+\/rooms\//.test(path)) {
    const templateKey = selectedRoomTemplateKey();
    if (templateKey)
      url.searchParams.set("environmentTemplateKey", templateKey);
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function shouldUseSameOriginProxy(apiUrl: string) {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const api = new URL(apiUrl);
    const page = new URL(window.location.href);
    if (isLoopbackHost(page.hostname)) {
      return false;
    }
    return isLoopbackHost(api.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

export function getApiHealth() {
  return apiFetch<ApiHealth>("/health", { cache: "no-store" });
}

export function apiGet<T>(path: string, signal?: AbortSignal) {
  return apiFetch<T>(path, { cache: "no-store", signal });
}

export function apiSend<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  init?: Omit<RequestInit, "method" | "body">,
) {
  return apiFetch<T>(path, {
    ...init,
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
