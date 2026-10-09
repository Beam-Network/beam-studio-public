import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeRoot = new URL("./", import.meta.url);

test("MCP parent routes render their nested public setup pages", async () => {
  const [mcp, tokens, newToken, tokensPage] = await Promise.all([
    readFile(new URL("mcp.tsx", routeRoot), "utf8"),
    readFile(new URL("mcp.tokens.tsx", routeRoot), "utf8"),
    readFile(new URL("mcp.tokens.new.tsx", routeRoot), "utf8"),
    readFile(
      new URL("../features/mcp/mcp-tokens-page.tsx", routeRoot),
      "utf8",
    ),
  ]);

  assert.match(mcp, /location\.pathname !== "\/mcp"/);
  assert.match(mcp, /return <Outlet \/>/);
  assert.match(tokens, /location\.pathname !== "\/mcp\/tokens"/);
  assert.match(tokens, /return <Outlet \/>/);
  assert.match(newToken, /createFileRoute\("\/mcp\/tokens\/new"\)/);
  // Both routes now render one shared page so a newly created token can be
  // shown before the dialog closes, so the endpoint lives with that page
  // rather than being repeated in the route file.
  assert.match(tokens, /McpTokensPage/);
  assert.match(newToken, /McpTokensPage/);
  assert.match(tokensPage, /endpoint: "\/studio\/mcp\/tokens"/);
});
