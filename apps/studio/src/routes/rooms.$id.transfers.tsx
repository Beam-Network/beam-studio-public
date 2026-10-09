import { createFileRoute } from "@tanstack/react-router";
import { RoomTransfersPage } from "@/features/rooms/room-transfers-page";

export const Route: any = createFileRoute("/rooms/$id/transfers")({
  component: RoomTransfersRoute,
});

function RoomTransfersRoute() {
  const { id } = Route.useParams();

  return <RoomTransfersPage roomId={id} />;
}
