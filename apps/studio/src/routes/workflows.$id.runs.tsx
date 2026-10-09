import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { WorkflowDetailView } from "./workflows.$id";

export const Route: any = createFileRoute("/workflows/$id/runs")({
  component: WorkflowRunsRoute,
});

function WorkflowRunsRoute() {
  const { id } = Route.useParams();
  const location = useLocation();

  if (location.pathname !== `/workflows/${id}/runs`) {
    return <Outlet />;
  }

  return <WorkflowDetailView activeTab="runs" workflowId={id} />;
}
