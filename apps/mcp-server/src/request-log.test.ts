import assert from "node:assert/strict";
import test from "node:test";
import {
  isWriteOperation,
  logMcpRequest,
  mcpRequestLogLevel,
  startMcpOperation,
  type McpRequestLog,
} from "./request-log.js";

function recorder() {
  const lines: Array<{
    level: string;
    object: Record<string, unknown>;
    message: string;
  }> = [];
  const at = (level: string) => (object: object, message: string) =>
    lines.push({ level, object: object as Record<string, unknown>, message });
  return {
    lines,
    logger: {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    },
  };
}

test("only read:* scopes make an operation a read", () => {
  assert.equal(isWriteOperation(["read:runs"]), false);
  assert.equal(isWriteOperation([]), false);
  assert.equal(isWriteOperation(["write:transfers"]), true);
  assert.equal(isWriteOperation(["run:transfers"]), true);
  assert.equal(isWriteOperation(["cancel:runs"]), true);
});

test("levels follow the API rules: failures error, refusals warn, writes info, reads debug", () => {
  const read = {
    kind: "tool",
    name: "beam.get_run_status",
    write: false,
    scope: "granted",
    outcome: "ok",
  } as const;
  const write = { ...read, name: "beam.create_workflow", write: true } as const;
  assert.equal(mcpRequestLogLevel("/health", 200), null);
  assert.equal(mcpRequestLogLevel("/health", 503), "error");
  assert.equal(mcpRequestLogLevel("/mcp", 500, write), "error");
  assert.equal(mcpRequestLogLevel("/mcp", 401), "warn");
  assert.equal(mcpRequestLogLevel("/mcp", 429), "warn");
  assert.equal(
    mcpRequestLogLevel("/mcp", 200, {
      ...read,
      scope: "denied",
      outcome: "error",
    }),
    "warn",
  );
  assert.equal(
    mcpRequestLogLevel("/mcp", 200, { ...read, outcome: "error" }),
    "warn",
  );
  assert.equal(mcpRequestLogLevel("/mcp", 200, write), "info");
  assert.equal(mcpRequestLogLevel("/mcp", 200, read), "debug");
  assert.equal(
    mcpRequestLogLevel("/mcp", 200),
    "debug",
    "initialize, tools/list",
  );
});

test("one line names the tool, scope decision, status and duration, never arguments or the token", () => {
  const { lines, logger } = recorder();
  const log: McpRequestLog = { tokenId: "mcp_tok_1" };
  const operation = startMcpOperation(log, {
    kind: "tool",
    name: "beam.create_workflow",
    requiredScopes: ["write:transfers"],
    scope: "granted",
  });
  operation.outcome = "ok";
  logMcpRequest(logger, {
    method: "POST",
    path: "/mcp",
    statusCode: 200,
    durationMs: 12.6,
    log,
  });
  assert.deepEqual(lines, [
    {
      level: "info",
      message: "MCP request completed",
      object: {
        method: "POST",
        path: "/mcp",
        statusCode: 200,
        tool: "beam.create_workflow",
        scope: "granted",
        outcome: "ok",
        tokenId: "mcp_tok_1",
        durationMs: 13,
      },
    },
  ]);
});

test("a denied scope is a warning, a resource is named as such, and an unfinished operation is an error outcome", () => {
  const { lines, logger } = recorder();
  const denied: McpRequestLog = {};
  startMcpOperation(denied, {
    kind: "resource",
    name: "beam://recent-runs",
    requiredScopes: ["read:runs"],
    scope: "denied",
  });
  logMcpRequest(logger, {
    method: "POST",
    path: "/mcp",
    statusCode: 200,
    durationMs: 1,
    log: denied,
  });
  assert.equal(lines[0]?.level, "warn");
  assert.equal(lines[0]?.object.resource, "beam://recent-runs");
  assert.equal(lines[0]?.object.scope, "denied");
  assert.equal(lines[0]?.object.outcome, "error");

  logMcpRequest(logger, {
    method: "GET",
    path: "/health",
    statusCode: 200,
    durationMs: 1,
    log: {},
  });
  logMcpRequest(logger, {
    method: "POST",
    path: "/mcp",
    statusCode: 401,
    durationMs: 1,
    log: {},
  });
  assert.equal(lines.length, 2, "health probes are skipped");
  assert.deepEqual(lines[1]?.object, {
    method: "POST",
    path: "/mcp",
    statusCode: 401,
    durationMs: 1,
  });
});
