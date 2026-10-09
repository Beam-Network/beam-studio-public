import { createFileRoute } from "@tanstack/react-router";
import { ResourceAppPage } from "@/components/data-page";

export const Route: any = createFileRoute("/mcp/activity")({
  component: () => (
    <ResourceAppPage
      collectionKey="activity"
      endpoint="/studio/mcp"
      hidePageHeader
      title="MCP activity"
    />
  ),
});
