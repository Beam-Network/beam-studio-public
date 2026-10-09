import { createFileRoute } from "@tanstack/react-router";
import { RoomActivityPage } from "@/features/rooms/room-activity-page";

export const Route: any = createFileRoute("/rooms/$id/activity")({
  component: RoomActivityRoute,
});

function RoomActivityRoute() {
  const { id } = Route.useParams();

  return <RoomActivityPage roomId={id} />;
}
