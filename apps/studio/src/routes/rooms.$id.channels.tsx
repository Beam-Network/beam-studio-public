import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { RoomChannelsPage } from "@/features/rooms/room-channels-page";

export const Route: any = createFileRoute("/rooms/$id/channels")({
  component: RoomChannelsRoute,
});

function RoomChannelsRoute() {
  const location = useLocation();
  const { id } = Route.useParams();

  return location.pathname === `/rooms/${id}/channels` ? (
    <RoomChannelsPage roomId={id} />
  ) : (
    <Outlet />
  );
}
