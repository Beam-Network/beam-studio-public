import { createFileRoute } from "@tanstack/react-router";
import { WorkflowDetailView } from "./workflows.$id";

export const Route: any = createFileRoute("/workflows/$id/settings")({
  component: WorkflowSettingsRoute,
});

function WorkflowSettingsRoute() {
  const { id } = Route.useParams();
  return <WorkflowDetailView activeTab="settings" workflowId={id} />;
}
