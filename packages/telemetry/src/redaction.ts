const sensitiveKey =
  /(^|[._-])(authorization|cookie|credential|password|secret|signature|token|api[_-]?key|access[_-]?key|claim[_-]?code)([._-]|$)/i;
const signedUrl = /[?&](x-amz-signature|signature|sig|token)=/i;
const credentialedUrl = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i;

export const REDACTED = "[REDACTED]";

export function redactTelemetryValue(value: unknown, key = ""): unknown {
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  if (sensitiveKey.test(normalizedKey)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return signedUrl.test(value) || credentialedUrl.test(value)
      ? REDACTED
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactTelemetryValue(entry, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([childKey, child]) => [
          childKey,
          redactTelemetryValue(child, childKey),
        ],
      ),
    );
  }
  return value;
}

export function redactingLogger<
  T extends {
    debug(...args: unknown[]): unknown;
    info(...args: unknown[]): unknown;
    warn(...args: unknown[]): unknown;
    error(...args: unknown[]): unknown;
  },
>(logger: T) {
  const call =
    (level: "debug" | "info" | "warn" | "error") =>
    (payload: unknown, message?: string) => {
      if (typeof payload === "string" && message === undefined) {
        logger[level](String(redactTelemetryValue(payload)));
        return;
      }
      logger[level](redactTelemetryValue(payload), message);
    };
  return {
    debug: call("debug"),
    info: call("info"),
    warn: call("warn"),
    error: call("error"),
  };
}

export function redactTelemetryAttributes(attributes: Record<string, unknown>) {
  return redactTelemetryValue(attributes) as Record<string, unknown>;
}
