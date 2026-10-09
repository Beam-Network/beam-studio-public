import { createFileRoute } from "@tanstack/react-router";
import { AgentDetailPage } from "./agents.$id";

export const Route: any = createFileRoute("/agents/$id/activity")({
  component: AgentActivityRoute,
});

function AgentActivityRoute() {
  const { id } = Route.useParams();

  return <AgentDetailPage agentId={id} tab="activity" />;
}
