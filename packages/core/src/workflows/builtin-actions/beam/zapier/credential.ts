import { ActionInputError, type ActionExecute } from "../../../actions.js";
import type { McpConnection } from "./mcp.js";

export const ZAPIER_TIMEOUT_MS = 60_000;

/**
 * Resolves a Zapier credential into a connection.
 *
 * The endpoint is stored rather than derived. Zapier's MCP URL has changed
 * shape more than once and embeds a per-server secret in its path, so what the
 * user copied out of mcp.zapier.com is the only reliable source; a Zapier-side
 * change stays a paste, not a Studio release.
 */
export async function zapierConnection(
  context: Parameters<ActionExecute>[1],
  credentialId: string,
): Promise<McpConnection> {
  const raw = await context.secrets.get(credentialId);
  if (!raw) {
    throw new ActionInputError(
      `Zapier credential "${credentialId}" could not be resolved.`,
    );
  }

  let endpoint = "";
  let apiKey = "";
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    endpoint = text(payload.base_url);
    apiKey = text(payload.api_key);
  } catch {
    // A credential stored as a bare URL is still usable.
    endpoint = raw.trim();
  }

  if (!endpoint) {
    throw new ActionInputError(
      "The Zapier credential does not contain an MCP server URL.",
    );
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new ActionInputError(
      "The Zapier credential's MCP server URL must be an http:// or https:// URL.",
    );
  }

  return {
    endpoint,
    ...(apiKey ? { apiKey } : {}),
    signal: context.signal,
    timeoutMs: ZAPIER_TIMEOUT_MS,
  };
}

export function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
