import { createFileRoute } from "@tanstack/react-router";
import { AgentDetailPage } from "./agents.$id";

export const Route: any = createFileRoute("/agents/$id/settings")({
  component: AgentSettingsRoute,
});

function AgentSettingsRoute() {
  const { id } = Route.useParams();

  return <AgentDetailPage agentId={id} tab="settings" />;
}
