import { createFileRoute } from "@tanstack/react-router";
import { RoomMembersPage } from "@/features/rooms/room-members-page";

export const Route: any = createFileRoute("/rooms/$id/members")({
  component: RoomMembersRoute,
});

function RoomMembersRoute() {
  const { id } = Route.useParams();

  return <RoomMembersPage roomId={id} />;
}
