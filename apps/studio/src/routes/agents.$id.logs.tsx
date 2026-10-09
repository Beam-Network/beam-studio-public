import { createFileRoute } from "@tanstack/react-router";
import { AgentDetailPage } from "./agents.$id";

export const Route: any = createFileRoute("/agents/$id/logs")({
  component: AgentLogsRoute,
});

function AgentLogsRoute() {
  const { id } = Route.useParams();

  return <AgentDetailPage agentId={id} tab="logs" />;
}
