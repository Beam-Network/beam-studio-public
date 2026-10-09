import { createFileRoute } from "@tanstack/react-router";
import { ScheduleEditorPage } from "@/features/scheduling/schedule-editor";

export const Route: any = createFileRoute("/schedules/new")({
  component: () => <ScheduleEditorPage />,
});
