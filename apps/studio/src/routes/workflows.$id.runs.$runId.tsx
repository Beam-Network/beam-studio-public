import { createFileRoute } from "@tanstack/react-router";
import { RunDetailView } from "@/features/runs/run-detail-view";
import { WorkflowContextShell } from "./workflows.$id";

export const Route: any = createFileRoute("/workflows/$id/runs/$runId")({
  component: WorkflowRunDetail,
});

function WorkflowRunDetail() {
  const { id, runId } = Route.useParams();

  return (
    <WorkflowContextShell
      contentClassName="px-3 py-4"
      workflowId={id}
    >
      <RunDetailView
        actions={[
          {
            label: "Cancel",
            method: "POST",
            path: () => `/studio/workflow-runs/${runId}/cancel`,
          },
          {
            label: "Retry",
            method: "POST",
            path: () => `/studio/workflow-runs/${runId}/retry`,
          },
        ]}
        backLink={{
          label: "Workflow runs",
          to: `/workflows/${id}/runs`,
        }}
        endpoint={`/studio/workflow-runs/${runId}`}
        runPath={(nextRunId) => `/workflows/${id}/runs/${nextRunId}`}
        title={`Workflow run ${runId}`}
      />
    </WorkflowContextShell>
  );
}
