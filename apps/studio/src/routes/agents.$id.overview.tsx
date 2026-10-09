import { createFileRoute } from "@tanstack/react-router";
import { AgentDetailPage } from "./agents.$id";

export const Route: any = createFileRoute("/agents/$id/overview")({
  component: AgentOverviewRoute,
});

function AgentOverviewRoute() {
  const { id } = Route.useParams();

  return <AgentDetailPage agentId={id} tab="overview" />;
}
