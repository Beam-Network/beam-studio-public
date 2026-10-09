import { createFileRoute } from "@tanstack/react-router";
import { RoomSettingsPage } from "@/features/rooms/room-settings-page";

export const Route: any = createFileRoute("/rooms/$id/settings")({
  component: RoomSettingsRoute,
});

function RoomSettingsRoute() {
  const { id } = Route.useParams();

  return <RoomSettingsPage roomId={id} />;
}
