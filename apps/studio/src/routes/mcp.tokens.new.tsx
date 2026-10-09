import { createFileRoute } from "@tanstack/react-router";
import { McpTokensPage } from "@/features/mcp/mcp-tokens-page";

export const Route: any = createFileRoute("/mcp/tokens/new")({
  component: McpTokensPage,
});
