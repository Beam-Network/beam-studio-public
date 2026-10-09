import { createFileRoute } from "@tanstack/react-router";
import { WorkerDetailPage } from "./orchestration";

export const Route: any = createFileRoute("/orchestration/workers/$id")({
  component: WorkerDetailRoute,
});

function WorkerDetailRoute() {
  const { id } = Route.useParams() as { id: string };

  return <WorkerDetailPage id={id} />;
}
