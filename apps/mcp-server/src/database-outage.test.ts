import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  answerDatabaseOutageInstead,
  DATABASE_UNAVAILABLE_MESSAGE,
  noteDatabaseOutage,
  writeMcpFailure,
  type DatabaseOutage,
} from "./database-outage.js";

// What an in-flight query reports when pg_terminate_backend ends its
// connection. The SDK used to hand it to the client as a tool error.
const terminated = () => new Error("Connection terminated unexpectedly");

/**
 * The request path of main.ts in miniature: a real McpServer and transport,
 * one tool that fails the way the audit wrapper sees it fail.
 */
async function startMcp(failure: () => Error) {
  const server: Server = createServer(async (req, res) => {
    const mcp = new McpServer({ name: "outage-test", version: "0.0.0" });
    const outage: DatabaseOutage = {};
    mcp.tool("beam.list_recent_runs", "Lists runs", async () => {
      try {
        throw failure();
      } catch (error) {
        noteDatabaseOutage(outage, error);
        throw error;
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const restore = answerDatabaseOutageInstead(res, outage, (error) =>
      writeMcpFailure(res, error),
    );
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      restore();
      await transport.close();
      await mcp.close();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    call: () =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "beam.list_recent_runs", arguments: {} },
        }),
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a tool call cut off by a database outage answers the retryable 503", async () => {
  const mcp = await startMcp(terminated);
  try {
    const response = await mcp.call();
    assert.equal(response.status, 503);
    const body = (await response.json()) as {
      error?: { code: number; message: string };
    };
    assert.deepEqual(body.error, {
      code: -32603,
      message: DATABASE_UNAVAILABLE_MESSAGE,
    });
    assert.doesNotMatch(JSON.stringify(body), /Connection terminated/);
  } finally {
    await mcp.close();
  }
});

test("any other tool failure stays a tool error", async () => {
  const mcp = await startMcp(() => new Error("Run not found."));
  try {
    const response = await mcp.call();
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };
    assert.equal(body.result?.isError, true);
    assert.equal(body.result?.content?.[0]?.text, "Run not found.");
  } finally {
    await mcp.close();
  }
});
