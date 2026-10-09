import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { DetailPage } from "@/components/data-page";

export const Route: any = createFileRoute("/transfers/$id")({
  component: TransferDetail,
});

function TransferDetail() {
  const { id } = Route.useParams();
  return (
    <AppShell contentClassName="px-3 py-4">
      <DetailPage
        endpoint={`/studio/transfers/${id}`}
        title={`Transfer ${id}`}
        actions={[
          { label: "Toggle", method: "POST", path: () => `/studio/transfers/${id}/toggle` },
          { label: "Run", method: "POST", path: () => `/studio/transfers/${id}/run` },
        ]}
      />
    </AppShell>
  );
}
