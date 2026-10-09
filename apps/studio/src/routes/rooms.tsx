import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { RoomsPage } from "@/features/rooms/rooms-page";

export const Route: any = createFileRoute("/rooms")({
  component: RoomsRoute,
});

function RoomsRoute() {
  const location = useLocation();
  return location.pathname === "/rooms" ? <RoomsPage /> : <Outlet />;
}
