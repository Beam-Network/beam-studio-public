import { createServiceLogger } from "@beam-studio/shared/logging";
import {
  REDACTED,
  redactTelemetryValue,
} from "@beam-studio/telemetry";
import { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import pino from "pino";

/**
 * API-only redaction on top of the shared secret paths. Nested `url` fields
 * are often presigned object-storage URLs, and a request body can carry a
 * credential payload, so neither is written as-is.
 */
export const API_EXTRA_REDACT_PATHS = ["*.url", "body", "*.body"] as const;

/** A pino logger with the level from `LOG_LEVEL` and secrets redacted. */
export function createApiLogger(
  name = "beam-transfer-api",
  env: Record<string, string | undefined> = process.env,
  destination?: pino.DestinationStream,
) {
  return createServiceLogger(
    (options) => (destination ? pino(options, destination) : pino(options)),
    name,
    { env, extraRedactPaths: API_EXTRA_REDACT_PATHS },
  );
}

export type ApiLogger = ReturnType<typeof createApiLogger>;

const PROBE_ROUTES = new Set(["/health", "/studio/health", "/metrics"]);

export type RequestLogLevel = "debug" | "info" | "warn" | "error";

/**
 * How loud a finished request is, or `null` to skip it.
 *
 * The Studio UI polls several reads every few seconds, so a successful read
 * is `debug`. Writes are `info`, refusals (4xx) `warn` and failures (5xx)
 * `error`, so the default `info` level keeps every change and every problem —
 * a 409 `room_consumer_unavailable` included — without the polling noise.
 */
export function requestLogLevel(
  method: string,
  route: string | undefined,
  statusCode: number,
): RequestLogLevel | null {
  if (statusCode >= 500) return "error";
  if (route && PROBE_ROUTES.has(route)) return null;
  if (statusCode >= 400) return "warn";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return "debug";
  }
  return "info";
}

/**
 * The request path with secrets removed.
 *
 * Some routes carry a secret in the path (the webhook trigger token in
 * `/hooks/workflows/:workflowId/:triggerId/:token`), and a query string can
 * carry a token or a signature. Path parameters and query values are redacted
 * by the same key and value rules as telemetry.
 */
export function redactedRequestPath(request: FastifyRequest) {
  const raw = request.url;
  const queryStart = raw.indexOf("?");
  let path = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const params = (request.params ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string" || !value) continue;
    if (redactTelemetryValue(value, key) !== REDACTED) continue;
    path = path
      .split("/")
      .map((segment) =>
        segment === value || safeDecode(segment) === value ? REDACTED : segment,
      )
      .join("/");
  }
  if (queryStart === -1) return path;
  const query = new URLSearchParams(raw.slice(queryStart + 1));
  const redacted = [...query.entries()].map(
    ([key, value]) => `${key}=${String(redactTelemetryValue(value, key))}`,
  );
  return redacted.length ? `${path}?${redacted.join("&")}` : path;
}

/**
 * Fastify's own per-request lines ("incoming request" and "request
 * completed") are two lines per request with every health probe included.
 * {@link logCompletedRequest} writes one line instead, so those two are
 * switched off; Fastify's failure logs (stream, serializer and write errors)
 * stay on.
 */
export class ApiLogController extends LogController {
  override incomingRequest() {}
  override requestCompleted() {}
}

/** The single line written when a request finishes. */
export function logCompletedRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  details: { durationMs: number; correlationId?: string; code?: string },
) {
  const route = request.routeOptions.url;
  const level = requestLogLevel(request.method, route, reply.statusCode);
  if (!level) return;
  request.log[level](
    {
      method: request.method,
      route: route ?? "unmatched",
      path: redactedRequestPath(request),
      statusCode: reply.statusCode,
      ...(details.code ? { code: details.code } : {}),
      durationMs: Math.round(details.durationMs),
      ...(details.correlationId
        ? { correlationId: details.correlationId }
        : {}),
    },
    "request completed",
  );
}

function safeDecode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
