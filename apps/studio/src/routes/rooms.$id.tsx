import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { RoomPage } from "@/features/rooms/room-page";

export const Route: any = createFileRoute("/rooms/$id")({
  component: RoomRoute,
});

function RoomRoute() {
  const location = useLocation();
  const { id } = Route.useParams();
  const isRoomSubpage = [
    "/settings",
    "/members",
    "/activity",
    "/channels",
    "/transfers",
  ].some((segment) => location.pathname.includes(segment));

  return isRoomSubpage ? <Outlet /> : <RoomPage roomId={id} />;
}
