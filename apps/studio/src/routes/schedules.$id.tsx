import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { ScheduleDetailPage } from "@/features/scheduling/schedule-detail";

export const Route: any = createFileRoute("/schedules/$id")({
  component: ScheduleRoute,
});

function ScheduleRoute() {
  const { id } = Route.useParams();
  const location = useLocation();
  return location.pathname === `/schedules/${id}` ? (
    <ScheduleDetailPage scheduleId={id} />
  ) : (
    <Outlet />
  );
}
