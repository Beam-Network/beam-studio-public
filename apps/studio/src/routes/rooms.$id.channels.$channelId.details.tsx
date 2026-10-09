import { createFileRoute } from "@tanstack/react-router";
import { RoomPage } from "@/features/rooms/room-page";

export const Route: any = createFileRoute(
  "/rooms/$id/channels/$channelId/details",
)({
  component: RoomChannelDetailsRoute,
});

function RoomChannelDetailsRoute() {
  const { channelId, id } = Route.useParams();

  return <RoomPage channelId={channelId} channelView="details" roomId={id} />;
}
