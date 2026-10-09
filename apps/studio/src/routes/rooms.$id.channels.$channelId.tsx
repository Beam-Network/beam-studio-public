import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { RoomPage } from "@/features/rooms/room-page";

export const Route: any = createFileRoute("/rooms/$id/channels/$channelId")({
  component: RoomChannelRoute,
});

function RoomChannelRoute() {
  const location = useLocation();
  const { channelId, id } = Route.useParams();

  return location.pathname === `/rooms/${id}/channels/${channelId}` ? (
    <RoomPage channelId={channelId} roomId={id} />
  ) : (
    <Outlet />
  );
}
