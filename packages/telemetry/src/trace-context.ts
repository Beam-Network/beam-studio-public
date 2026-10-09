import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type TraceContext = {
  traceId: string;
  spanId: string;
  traceFlags: "00" | "01";
  correlationId: string;
};

const storage = new AsyncLocalStorage<TraceContext>();
const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/;

export function createTraceContext(
  correlationId: string,
  parent?: TraceContext | null,
): TraceContext {
  return {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    traceFlags: parent?.traceFlags ?? "01",
    correlationId,
  };
}

export function parseTraceparent(
  value: string | undefined,
  correlationId: string,
): TraceContext | null {
  const match = value?.trim().toLowerCase().match(traceparentPattern);
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) {
    return null;
  }
  return {
    traceId: match[1]!,
    spanId: match[2]!,
    traceFlags: match[3] as "00" | "01",
    correlationId,
  };
}

export function formatTraceparent(context: TraceContext) {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

export function activeTraceContext() {
  return storage.getStore() ?? null;
}

export function runWithTraceContext<T>(
  context: TraceContext,
  callback: () => T,
) {
  return storage.run(context, callback);
}

function randomHex(bytes: number) {
  return crypto.randomBytes(bytes).toString("hex");
}
