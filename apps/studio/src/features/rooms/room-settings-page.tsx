import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, RadioTower, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { roomAgentName, roomsQueryKey, updateRoomLabel } from "./room-data";
import { useRoomData } from "./room-hooks";
import { RoomPageFrame } from "./room-page-frame";
import { RoomChannelSidebarAction } from "./room-channels-page";

export function RoomSettingsPage({ roomId }: { roomId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { query, room, refreshMutation, actionMutation } = useRoomData(roomId);
  const [label, setLabel] = useState("");
  useEffect(() => setLabel(room?.label ?? ""), [room?.id, room?.label]);
  const labelMutation = useMutation({
    mutationFn: () => updateRoomLabel(roomId, label.trim() || null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: roomsQueryKey }),
  });

  async function finishMembership(operation: "room.close" | "room.leave") {
    if (!room) return;
    await actionMutation.mutateAsync({ operation });
    navigate({ to: "/rooms" });
  }

  return (
    <RoomPageFrame
      activeView="settings"
      actionError={
        refreshMutation.error ?? actionMutation.error ?? labelMutation.error
      }
      channelAction={room ? <RoomChannelSidebarAction room={room} /> : null}
      error={query.error}
      isPending={query.isPending}
      room={room}
      roomId={roomId}
      title="Settings"
    >
      {room ? (
        <div className="grid gap-5">
          <section className="overflow-hidden rounded-surface border bg-card">
            <SectionHeader
              description="Use a readable Studio label while retaining the immutable Room ID."
              icon={RadioTower}
              title="Display label"
            />
            <form
              className="grid gap-3 p-4 sm:p-5"
              onSubmit={(event) => {
                event.preventDefault();
                labelMutation.mutate();
              }}
            >
              <label className="grid max-w-xl gap-2 text-sm font-medium">
                Label
                <input
                  autoComplete="off"
                  className="h-10 rounded-control border bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  maxLength={120}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="e.g. Production transfers"
                  value={label}
                />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Leave the field empty and save to remove the label.
                </p>
                <Button
                  disabled={
                    labelMutation.isPending ||
                    label.trim() === (room.label ?? "")
                  }
                  size="sm"
                  type="submit"
                >
                  <Save className="size-4" />
                  {labelMutation.isPending ? "Saving…" : "Save label"}
                </Button>
              </div>
            </form>
          </section>

          <section className="overflow-hidden rounded-surface border border-destructive/40 bg-card">
            <SectionHeader
              description="These operations are sent to the coordinator and affect real room state."
              icon={Trash2}
              title="Danger zone"
              tone="danger"
            />
            <div className="grid gap-4 p-4 sm:p-5">
              {room.agent ? (
                <DangerAction
                  action={
                    <ConfirmationDialog
                      confirmLabel="Leave room"
                      description={`The agent ${roomAgentName(room.agent)} will leave ${room.id}. Owner memberships may be required to close the room instead.`}
                      onConfirm={() => finishMembership("room.leave")}
                      title="Leave this room?"
                      trigger={
                        <Button
                          disabled={room.readOnly}
                          type="button"
                          variant="outline"
                        >
                          <LogOut className="size-4" />
                          Leave room
                        </Button>
                      }
                    />
                  }
                  description="Remove this agent's membership while leaving the room available to other members."
                  title="Leave room"
                />
              ) : null}
              <DangerAction
                action={
                  <ConfirmationDialog
                    confirmLabel="Close room"
                    description={`Closing ${room.id} affects every member and cannot be reversed.`}
                    onConfirm={() => finishMembership("room.close")}
                    title="Close this room?"
                    trigger={
                      <Button
                        disabled={room.readOnly}
                        type="button"
                        variant="destructive"
                      >
                        <Trash2 className="size-4" />
                        Close room
                      </Button>
                    }
                  />
                }
                description="Close the coordinator room and disconnect all of its members and channels."
                title="Close room"
              />
            </div>
          </section>
        </div>
      ) : null}
    </RoomPageFrame>
  );
}

function SectionHeader({
  description,
  icon: Icon,
  title,
  tone = "default",
}: {
  description: string;
  icon: typeof RadioTower;
  title: string;
  tone?: "default" | "danger";
}) {
  return (
    <div className="flex items-start gap-3 border-b p-4 sm:p-5">
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-control ${
          tone === "danger"
            ? "bg-destructive/10 text-destructive"
            : "bg-primary/10 text-primary"
        }`}
      >
        <Icon className="size-4" />
      </span>
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function DangerAction({
  action,
  description,
  title,
}: {
  action: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-control border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
