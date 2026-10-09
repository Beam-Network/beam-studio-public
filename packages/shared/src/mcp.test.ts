import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMcpScopes,
  MCP_ADMIN_SCOPES,
  mcpScopesJson,
  parseMcpScopes,
} from "./mcp.js";

test("no unusable scope list is ever widened to admin", () => {
  for (const value of [[], ["bogus"], ["bogus", "also-bogus"]]) {
    assert.throws(
      () => assertMcpScopes(value),
      `${JSON.stringify(value)} must not grant any scope`,
    );
  }
});

test("duplicates collapse without changing the grant", () => {
  assert.deepEqual(assertMcpScopes(["read:runs", "read:runs"]), ["read:runs"]);
});

test("assertMcpScopes rejects an unknown scope instead of dropping it", () => {
  assert.throws(
    () => assertMcpScopes(["red:runs"]),
    /Unknown MCP scope: red:runs/,
  );
  // A misspelling alongside a valid scope must not quietly narrow the grant.
  assert.throws(
    () => assertMcpScopes(["read:runs", "write:transfer"]),
    /Unknown MCP scope: write:transfer/,
  );
});

test("assertMcpScopes requires at least one scope", () => {
  assert.throws(() => assertMcpScopes([]), /Select at least one MCP scope/);
});

test("assertMcpScopes returns the requested subset", () => {
  assert.deepEqual(assertMcpScopes(["read:runs", "cancel:runs"]), [
    "read:runs",
    "cancel:runs",
  ]);
});

test("mcpScopesJson refuses to persist a scope set it cannot honour", () => {
  assert.throws(() => mcpScopesJson([]), /Select at least one MCP scope/);
  assert.throws(
    () => mcpScopesJson(["nope"] as never),
    /Unknown MCP scope: nope/,
  );
  assert.equal(mcpScopesJson(["read:runs"]), JSON.stringify(["read:runs"]));
});

test("an explicit admin request still yields every scope", () => {
  assert.deepEqual(assertMcpScopes([...MCP_ADMIN_SCOPES]), [
    ...MCP_ADMIN_SCOPES,
  ]);
});

test("parseMcpScopes stays closed for unreadable stored values", () => {
  assert.deepEqual(parseMcpScopes(null), []);
  assert.deepEqual(parseMcpScopes("not json"), []);
  assert.deepEqual(parseMcpScopes(JSON.stringify(["read:runs"])), [
    "read:runs",
  ]);
});
