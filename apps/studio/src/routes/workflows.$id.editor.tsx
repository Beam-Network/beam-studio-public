import { createFileRoute } from "@tanstack/react-router";
import { WorkflowDetailView } from "./workflows.$id";

export const Route: any = createFileRoute("/workflows/$id/editor")({
  component: WorkflowEditorRoute,
});

function WorkflowEditorRoute() {
  const { id } = Route.useParams();
  return <WorkflowDetailView activeTab="editor" workflowId={id} />;
}
