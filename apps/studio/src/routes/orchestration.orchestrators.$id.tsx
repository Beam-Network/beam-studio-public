import { createFileRoute } from "@tanstack/react-router";
import { OrchestratorDetailPage } from "./orchestration";

export const Route: any = createFileRoute("/orchestration/orchestrators/$id")({
  component: OrchestratorDetailRoute,
});

function OrchestratorDetailRoute() {
  const { id } = Route.useParams() as { id: string };

  return <OrchestratorDetailPage id={id} />;
}
