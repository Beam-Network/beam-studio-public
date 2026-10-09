import crypto, { createHash, randomBytes } from "node:crypto";
import { StudioValidationError } from "../validation-error.js";

/** Identifier and timestamp shapes shared by the extracted repositories. */
export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

export function timestampText(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function createRawMcpToken() {
  return `beam_mcp_${randomBytes(32).toString("base64url")}`;
}

export function hashMcpToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeOptionalIsoDate(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new StudioValidationError(
      "expiration_date_invalid",
      "Expiration date must be a valid date.",
      { field: "expiresAt" },
    );
  }

  return new Date(parsed).toISOString();
}

export type Row = Record<string, unknown>;

/** Coerces a database or payload value to a trimmed string. */
export function credentialText(value: unknown) {
  return String(value ?? "").trim();
}

/** Reads a payload that may already be an object or may still be JSON text. */
export function parsePayload(payload: unknown): Row {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Row;
  }
  try {
    return JSON.parse(String(payload)) as Row;
  } catch {
    return {};
  }
}
