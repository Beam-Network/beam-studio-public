import {
  Outlet,
  createFileRoute,
  useLocation,
} from "@tanstack/react-router";
import { ResourceAppPage } from "@/components/data-page";

export const Route: any = createFileRoute("/mcp")({
  component: McpRoute,
});

function McpRoute() {
  const location = useLocation();
  if (location.pathname !== "/mcp") {
    return <Outlet />;
  }

  return (
    <ResourceAppPage
      collectionKey="tokens"
      endpoint="/studio/mcp"
      hidePageHeader
      title="MCP"
    />
  );
}
