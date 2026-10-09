import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { ScheduleListPage } from "@/features/scheduling/schedule-list";

export const Route: any = createFileRoute("/schedules")({
  component: SchedulesRoute,
});

function SchedulesRoute() {
  const location = useLocation();
  return location.pathname === "/schedules" ? <ScheduleListPage /> : <Outlet />;
}
