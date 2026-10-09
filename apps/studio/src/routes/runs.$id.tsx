import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { RunDetailView } from "@/features/runs/run-detail-view";

export const Route: any = createFileRoute("/runs/$id")({
  component: RunDetail,
});

function RunDetail() {
  const { id } = Route.useParams();
  return (
    <AppShell contentClassName="px-3 py-4">
      <RunDetailView
        endpoint={`/studio/runs/${id}`}
        title={`Run ${id}`}
        actions={[
          { label: "Cancel", method: "POST", path: () => `/studio/runs/${id}/cancel` },
          { label: "Retry", method: "POST", path: () => `/studio/runs/${id}/retry` },
        ]}
      />
    </AppShell>
  );
}
