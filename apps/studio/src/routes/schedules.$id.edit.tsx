import { createFileRoute } from "@tanstack/react-router";
import { ScheduleEditorPage } from "@/features/scheduling/schedule-editor";

export const Route: any = createFileRoute("/schedules/$id/edit")({
  component: ScheduleEditRoute,
});

function ScheduleEditRoute() {
  const { id } = Route.useParams();
  return <ScheduleEditorPage scheduleId={id} />;
}
