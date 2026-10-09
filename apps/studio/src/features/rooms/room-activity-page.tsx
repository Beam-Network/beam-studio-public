import { useMemo } from "react";
import { Activity, Clock3, RadioTower, Terminal } from "lucide-react";
import { EmptyState } from "@/components/data-page";
import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/routes/agents";
import { roomCommandMatches } from "./room-data";
import { useRoomData } from "./room-hooks";
import { RoomPageFrame } from "./room-page-frame";
import { RoomChannelSidebarAction } from "./room-channels-page";

export function RoomActivityPage({ roomId }: { roomId: string }) {
  const { query, room, refreshMutation } = useRoomData(roomId);
  const entries = useMemo(() => {
    if (!room) return [];
    const commands = room.commands.filter((command) =>
      roomCommandMatches(command, room.id),
    );
    const commandIds = new Set(commands.map((command) => command.id));
    return [
      ...commands.map((command) => ({
        id: `command:${command.id}`,
        title: command.operation,
        state: command.state,
        time: command.updatedAt ?? command.createdAt,
        detail: command.error ?? command.result,
        kind: "command" as const,
      })),
      ...room.events
        .filter((event) => Boolean(event.commandId && commandIds.has(event.commandId)))
        .map((event) => ({
          id: `event:${event.id}`,
          title: event.type,
          state: "event",
          time: event.createdAt,
          detail: event.payload,
          kind: "event" as const,
        })),
    ].sort(
      (left, right) =>
        new Date(right.time ?? 0).getTime() - new Date(left.time ?? 0).getTime(),
    );
  }, [room]);

  return (
    <RoomPageFrame
      activeView="activity"
      actionError={refreshMutation.error}
      channelAction={room ? <RoomChannelSidebarAction room={room} /> : null}
      error={query.error}
      isPending={query.isPending}
      room={room}
      roomId={roomId}
      title="Activity"
    >
      {room ? (
        <section className="overflow-hidden rounded-surface border bg-card">
          <div className="flex items-center justify-between gap-3 border-b p-4 sm:p-5">
            <div>
              <h2 className="font-medium">Room timeline</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Events persisted by Studio for this room and agent.
              </p>
            </div>
            <Badge className="gap-1.5" variant="secondary">
              <RadioTower className="size-3.5" />
              {entries.length}
            </Badge>
          </div>
          {entries.length ? (
            <div className="divide-y">
              {entries.map((entry) => (
                <article
                  className="grid gap-3 p-4 sm:grid-cols-[32px_minmax(0,1fr)_auto] sm:px-5"
                  key={entry.id}
                >
                  <span className="grid size-8 place-items-center rounded-control bg-muted">
                    {entry.kind === "command" ? (
                      <Terminal className="size-3.5" />
                    ) : (
                      <Activity className="size-3.5" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-mono text-sm font-medium">{entry.title}</p>
                      <Badge variant="outline">{entry.state}</Badge>
                    </div>
                    {entry.detail ? (
                      <pre className="mt-3 max-h-56 overflow-auto rounded-control bg-muted/50 p-3 text-xs">
                        {JSON.stringify(entry.detail, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock3 className="size-3" />
                    {formatRelative(entry.time)}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              className="m-4"
              description="No persisted command or event currently references this room."
              icon={Activity}
              title="No room activity"
            />
          )}
        </section>
      ) : null}
    </RoomPageFrame>
  );
}
