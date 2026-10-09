import { createFileRoute } from "@tanstack/react-router";
import { WorkflowDetailView } from "./workflows.$id";

export const Route: any = createFileRoute("/workflows/$id/overview")({
  component: WorkflowOverviewRoute,
});

function WorkflowOverviewRoute() {
  const { id } = Route.useParams();
  return <WorkflowDetailView activeTab="overview" workflowId={id} />;
}
