import { createFileRoute, Navigate } from "@tanstack/react-router";
import { studioEnv } from "@/lib/env";
import { AgentDetailPage } from "./agents.$id";

export const Route: any = createFileRoute("/agents/$id/destinations")({
  component: AgentDestinationsRoute,
});

function AgentDestinationsRoute() {
  const { id } = Route.useParams();

  // Hidden while Studio offers only Rooms; old links land on the overview.
  if (!studioEnv.tunnelsEnabled)
    return <Navigate replace to={`/agents/${id}/overview` as never} />;
  return <AgentDetailPage agentId={id} tab="destinations" />;
}
