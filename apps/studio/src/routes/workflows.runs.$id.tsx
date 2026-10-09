import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { RunDetailView } from "@/features/runs/run-detail-view";

export const Route: any = createFileRoute("/workflows/runs/$id")({
  component: WorkflowRunDetail,
});

function WorkflowRunDetail() {
  const { id } = Route.useParams();
  return (
    <AppShell contentClassName="px-3 py-4">
      <RunDetailView
        endpoint={`/studio/workflow-runs/${id}`}
        title={`Workflow run ${id}`}
        actions={[
          { label: "Cancel", method: "POST", path: () => `/studio/workflow-runs/${id}/cancel` },
          { label: "Retry", method: "POST", path: () => `/studio/workflow-runs/${id}/retry` },
        ]}
      />
    </AppShell>
  );
}
