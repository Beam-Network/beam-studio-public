import { createFileRoute } from "@tanstack/react-router";
import { AgentDetailPage } from "./agents.$id";

export const Route: any = createFileRoute("/agents/$id/rooms")({
  component: AgentRoomsRoute,
});

function AgentRoomsRoute() {
  const { id } = Route.useParams();

  return <AgentDetailPage agentId={id} tab="rooms" />;
}
