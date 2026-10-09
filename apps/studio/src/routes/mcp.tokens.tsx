import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { McpTokensPage } from "@/features/mcp/mcp-tokens-page";

export const Route: any = createFileRoute("/mcp/tokens")({
  component: McpTokensRoute,
});

function McpTokensRoute() {
  const location = useLocation();
  if (location.pathname !== "/mcp/tokens") {
    return <Outlet />;
  }

  return <McpTokensPage />;
}
