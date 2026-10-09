import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_PROTOCOL_VERSION,
  McpError,
  callMcpTool,
  listMcpTools,
  readFrame,
} from "./mcp.js";

type Frame = { method: string; headers: Record<string, string>; body: string };

/**
 * Answers each POST by method name, so a test states what the server returns
 * for `tools/list` without also scripting the initialize handshake.
 */
function stubServer(
  handlers: Record<
    string,
    {
      status?: number;
      json?: unknown;
      sse?: unknown[];
      headers?: Record<string, string>;
    }
  >,
) {
  const frames: Frame[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = String(init.body ?? "{}");
    const payload = JSON.parse(body) as { method: string; id?: number };
    frames.push({
      method: payload.method,
      headers: init.headers as Record<string, string>,
      body,
    });

    const handler = handlers[payload.method] ?? {};
    const headers = new Headers(handler.headers ?? {});
    if (handler.sse) {
      headers.set("content-type", "text/event-stream");
      const text = handler.sse
        .map((frame) => `event: message\ndata: ${JSON.stringify(frame)}\n`)
        .join("\n");
      return new Response(text, { status: handler.status ?? 200, headers });
    }
    headers.set("content-type", "application/json");
    return new Response(
      handler.json === undefined
        ? JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} })
        : JSON.stringify(handler.json),
      { status: handler.status ?? 200, headers },
    );
  }) as unknown as typeof fetch;
  return { impl, frames };
}

const connection = { endpoint: "https://mcp.zapier.com/api/mcp/s/secret/mcp" };
const noRetry = { sleep: async () => {}, random: () => 0.5 };

test("lists tools and carries the session id from initialize onward", async () => {
  const { impl, frames } = stubServer({
    initialize: {
      json: {
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: MCP_PROTOCOL_VERSION },
      },
      headers: { "mcp-session-id": "sess_1" },
    },
    "tools/list": {
      json: {
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [
            {
              name: "slack_send_channel_message",
              description: "Post to Slack",
            },
            { name: "jira_create_issue" },
          ],
        },
      },
    },
  });

  const tools = await listMcpTools(connection, { ...noRetry, fetchImpl: impl });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["slack_send_channel_message", "jira_create_issue"],
  );
  assert.equal(tools[0]!.description, "Post to Slack");

  assert.deepEqual(
    frames.map((frame) => frame.method),
    ["initialize", "notifications/initialized", "tools/list"],
  );
  // The handshake cannot carry a session id it has not been given yet; every
  // later call must.
  assert.equal(frames[0]!.headers["Mcp-Session-Id"], undefined);
  assert.equal(frames[1]!.headers["Mcp-Session-Id"], "sess_1");
  assert.equal(frames[2]!.headers["Mcp-Session-Id"], "sess_1");
  assert.equal(
    frames[0]!.headers["MCP-Protocol-Version"],
    MCP_PROTOCOL_VERSION,
  );
});

test("an api key is sent as a bearer token", async () => {
  const { impl, frames } = stubServer({});
  await listMcpTools(
    { ...connection, apiKey: "zap_key" },
    { ...noRetry, fetchImpl: impl },
  );
  assert.equal(frames[0]!.headers.Authorization, "Bearer zap_key");
});

test("no api key means no Authorization header", async () => {
  const { impl, frames } = stubServer({});
  await listMcpTools(connection, { ...noRetry, fetchImpl: impl });
  assert.equal(frames[0]!.headers.Authorization, undefined);
});

test("an SSE response is read, skipping frames that carry no result", async () => {
  const { impl } = stubServer({
    "tools/call": {
      sse: [
        {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progress: 1 },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "sent" }] },
        },
      ],
    },
  });

  const result = await callMcpTool(
    connection,
    { name: "slack_send_channel_message", arguments: { instructions: "hi" } },
    { ...noRetry, fetchImpl: impl },
  );

  assert.equal(result.content, "sent");
  assert.equal(result.isError, false);
});

test("tool arguments are passed through verbatim", async () => {
  const { impl, frames } = stubServer({
    "tools/call": { json: { jsonrpc: "2.0", id: 2, result: { content: [] } } },
  });

  await callMcpTool(
    connection,
    {
      name: "jira_create_issue",
      arguments: { instructions: "open a bug", project: "OPS" },
    },
    { ...noRetry, fetchImpl: impl },
  );

  const call = JSON.parse(frames.at(-1)!.body) as {
    params: { name: string; arguments: Record<string, unknown> };
  };
  assert.equal(call.params.name, "jira_create_issue");
  assert.deepEqual(call.params.arguments, {
    instructions: "open a bug",
    project: "OPS",
  });
});

test("a tool that reports its own failure is surfaced, not swallowed", async () => {
  const { impl } = stubServer({
    "tools/call": {
      json: {
        jsonrpc: "2.0",
        id: 2,
        result: {
          isError: true,
          content: [{ type: "text", text: "channel not found" }],
        },
      },
    },
  });

  const result = await callMcpTool(
    connection,
    { name: "slack_send_channel_message", arguments: {} },
    { ...noRetry, fetchImpl: impl },
  );

  assert.equal(result.isError, true);
  assert.equal(result.content, "channel not found");
});

test("a JSON-RPC error is terminal", async () => {
  const { impl } = stubServer({
    "tools/list": {
      json: {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32601, message: "unknown method" },
      },
    },
  });

  await assert.rejects(
    () => listMcpTools(connection, { ...noRetry, fetchImpl: impl }),
    (error: unknown) =>
      error instanceof McpError &&
      error.retryable === false &&
      error.code === -32601,
  );
});

test("401 is terminal and says so plainly; 503 retries", async () => {
  const rejected = stubServer({ initialize: { status: 401 } });
  await assert.rejects(
    () => listMcpTools(connection, { ...noRetry, fetchImpl: rejected.impl }),
    (error: unknown) =>
      error instanceof McpError &&
      error.retryable === false &&
      error.message.includes("rejected these credentials"),
  );
  assert.equal(rejected.frames.length, 1);

  let attempts = 0;
  const flaky = (async (_url: string, init: RequestInit) => {
    attempts += 1;
    const payload = JSON.parse(String(init.body)) as { id?: number };
    if (attempts === 1) {
      return new Response("", { status: 503 });
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

  await listMcpTools(connection, { ...noRetry, fetchImpl: flaky });
  assert.ok(attempts > 1, "a 503 should have been retried");
});

test("readFrame rejects a body that is not JSON", async () => {
  await assert.rejects(
    () =>
      readFrame(
        new Response("<html>gateway</html>", {
          headers: { "content-type": "application/json" },
        }),
      ),
    McpError,
  );
});
