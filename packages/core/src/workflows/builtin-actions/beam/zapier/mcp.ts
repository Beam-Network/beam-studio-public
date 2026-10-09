/**
 * A minimal MCP client, enough to list and call the tools a Zapier MCP server
 * exposes.
 *
 * Hand-rolled rather than taken from @modelcontextprotocol/sdk because this
 * package has exactly one runtime dependency and builtin actions are bundled
 * into the worker: an SDK here would be paid for by every action, not just
 * this one. The protocol surface actually used is three calls wide.
 *
 * Two details of Streamable HTTP that a naive implementation gets wrong:
 *
 *   - A server may answer a POST with either `application/json` or an SSE
 *     stream carrying the same JSON-RPC frames. Both are legal for a single
 *     request/response exchange, and Zapier has used both.
 *   - `initialize` returns a session id in a *header*, which every subsequent
 *     request must echo. Miss it and the second call is rejected as unknown.
 */

import {
  DEFAULT_RETRY,
  RETRYABLE_STATUS,
  backoffMs,
  retryAfterMs,
  transportMessage,
  type RetryOptions,
} from "../http/retry.js";

/**
 * Pinned rather than negotiated. A server that speaks a newer revision still
 * answers this one; guessing "latest" would silently change behaviour the day
 * a new revision ships.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const CLIENT_INFO = { name: "beam-studio", version: "1.0.0" };

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
};

export type McpToolResult = {
  /** Concatenated text content, which is what Zapier returns. */
  content: string;
  /** Parsed structured content when the server provides it. */
  structured: unknown;
  isError: boolean;
};

export type McpConnection = {
  endpoint: string;
  apiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export class McpError extends Error {
  readonly retryable: boolean;
  readonly code: number | null;

  constructor(
    message: string,
    options: { retryable?: boolean; code?: number | null } = {},
  ) {
    super(message);
    this.name = "McpError";
    this.retryable = options.retryable ?? false;
    this.code = options.code ?? null;
  }
}

type Session = { sessionId: string };

/**
 * Opens a session and lists the server's tools.
 *
 * Listing is the cheapest call that proves the endpoint is reachable and the
 * credential is accepted, so it doubles as the connection test.
 */
export async function listMcpTools(
  connection: McpConnection,
  options: RetryOptions = {},
): Promise<McpTool[]> {
  const session = await initialize(connection, options);
  const result = await rpc<{ tools?: unknown }>(
    connection,
    session,
    "tools/list",
    {},
    options,
  );
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") {
      return [];
    }
    const record = tool as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) {
      return [];
    }
    return [
      {
        name,
        description:
          typeof record.description === "string" ? record.description : "",
        inputSchema:
          record.inputSchema && typeof record.inputSchema === "object"
            ? (record.inputSchema as Record<string, unknown>)
            : null,
      },
    ];
  });
}

export async function callMcpTool(
  connection: McpConnection,
  input: { name: string; arguments: Record<string, unknown> },
  options: RetryOptions = {},
): Promise<McpToolResult> {
  const session = await initialize(connection, options);
  const result = await rpc<{
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  }>(
    connection,
    session,
    "tools/call",
    { name: input.name, arguments: input.arguments },
    options,
  );

  return {
    content: textContent(result.content),
    structured: result.structuredContent ?? null,
    // A tool that fails reports it in the result, not as a JSON-RPC error, so
    // this flag is the only signal that the call did not do what was asked.
    isError: result.isError === true,
  };
}

async function initialize(
  connection: McpConnection,
  options: RetryOptions,
): Promise<Session> {
  const { body, sessionId } = await post(
    connection,
    { sessionId: "" },
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    },
    options,
  );
  unwrap(body);

  const session = { sessionId };
  // The spec requires this notification before any other call. It is a
  // notification, so there is no response to wait on beyond the HTTP status.
  await post(
    connection,
    session,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    options,
  );
  return session;
}

async function rpc<T>(
  connection: McpConnection,
  session: Session,
  method: string,
  params: Record<string, unknown>,
  options: RetryOptions,
): Promise<T> {
  const { body } = await post(
    connection,
    session,
    { jsonrpc: "2.0", id: nextId(), method, params },
    options,
  );
  return unwrap(body) as T;
}

let idCounter = 1;
function nextId() {
  idCounter += 1;
  return idCounter;
}

function unwrap(frame: Record<string, unknown> | null) {
  if (!frame) {
    throw new McpError("The MCP server returned no JSON-RPC response.");
  }
  const error = frame.error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "number" ? record.code : null;
    const message =
      typeof record.message === "string" ? record.message : "unknown error";
    // A JSON-RPC error is the server refusing the call. Repeating it verbatim
    // produces the same refusal, so none of these are retryable.
    throw new McpError(`The MCP server refused the call: ${message}.`, {
      code,
    });
  }
  const result = frame.result;
  return result && typeof result === "object"
    ? (result as Record<string, unknown>)
    : {};
}

async function post(
  connection: McpConnection,
  session: Session,
  payload: Record<string, unknown>,
  options: RetryOptions,
): Promise<{ body: Record<string, unknown> | null; sessionId: string }> {
  const settings = { ...DEFAULT_RETRY, ...options };
  const doFetch = options.fetchImpl ?? fetch;
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Both encodings are legal for a single exchange, so accept both rather
    // than forcing one and hoping the server agrees.
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
  if (connection.apiKey) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  }
  if (session.sessionId) {
    headers["Mcp-Session-Id"] = session.sessionId;
  }

  let lastError: McpError | null = null;

  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await doFetch(connection.endpoint, {
        method: "POST",
        headers,
        body,
        signal: requestSignal(connection),
      });
    } catch (error) {
      lastError = new McpError(transportMessage(error, "Zapier MCP"), {
        retryable: true,
      });
      if (attempt === settings.maxAttempts) {
        throw lastError;
      }
      await settings.sleep(backoffMs(attempt, settings));
      continue;
    }

    if (response.ok) {
      return {
        body: await readFrame(response),
        sessionId:
          response.headers.get("mcp-session-id") ?? session.sessionId ?? "",
      };
    }

    const retryable = RETRYABLE_STATUS.has(response.status);
    lastError = new McpError(
      response.status === 401 || response.status === 403
        ? "The MCP server rejected these credentials."
        : `The MCP server returned HTTP ${response.status}.`,
      { retryable },
    );
    if (!retryable || attempt === settings.maxAttempts) {
      throw lastError;
    }
    await settings.sleep(
      retryAfterMs(response.headers) ?? backoffMs(attempt, settings),
    );
  }

  throw lastError ?? new McpError("The MCP request failed.");
}

/**
 * Reads one JSON-RPC frame from either encoding.
 *
 * For an SSE body this takes the last `data:` frame that carries a `result` or
 * an `error`: a server may emit progress notifications ahead of the response,
 * and those have neither.
 */
export async function readFrame(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return parseJson(text);
  }

  let frame: Record<string, unknown> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const parsed = parseJson(line.slice("data:".length).trim());
    if (parsed && ("result" in parsed || "error" in parsed)) {
      frame = parsed;
    }
  }
  return frame;
}

function parseJson(text: string) {
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    throw new McpError(
      "The MCP server returned a response that was not valid JSON.",
    );
  }
}

function textContent(content: unknown) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function requestSignal(connection: McpConnection) {
  const timeout = connection.timeoutMs
    ? AbortSignal.timeout(connection.timeoutMs)
    : null;
  if (connection.signal && timeout) {
    return AbortSignal.any([connection.signal, timeout]);
  }
  return connection.signal ?? timeout ?? undefined;
}
