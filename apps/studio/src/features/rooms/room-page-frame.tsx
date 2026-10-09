import { RoomEnvironmentSelect } from "./room-environment-select";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  LayoutDashboard,
  RadioTower,
  Search,
  Send,
  Terminal,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Skeleton } from "@/components/data-page";
import { PageSectionHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { roomChannels, roomDisplayName, type RoomSnapshot } from "./room-data";
import { roomErrorMessage } from "./room-hooks";
import { RoomShareDialog, RoomShareTrigger } from "./room-share-dialog";

type RoomFrameView =
  | "activity"
  | "channels"
  | "members"
  | "settings"
  | "transfers";

export function RoomPageFrame({
  actionError,
  activeView,
  channelAction,
  children,
  error,
  isPending,
  room,
  roomId,
  title,
  actions,
}: {
  actionError?: unknown;
  activeView: RoomFrameView;
  actions?: ReactNode;
  channelAction?: ReactNode;
  children?: ReactNode;
  error?: unknown;
  isPending: boolean;
  room: RoomSnapshot | null;
  roomId: string;
  title: string;
}) {
  const [channelSearch, setChannelSearch] = useState("");
  const channels = useMemo(() => {
    const allChannels = roomChannels(room);
    const needle = channelSearch.trim().toLowerCase();
    return needle
      ? allChannels.filter((channel) =>
          [channel.name, channel.kind, channel.description, channel.id]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : allChannels;
  }, [channelSearch, room]);

  return (
    <AppShell
      contentClassName="min-h-full p-0 xl:h-full xl:overflow-hidden"
      headerActions={
        <>
          <RoomEnvironmentSelect />
          {room ? (
            <RoomShareDialog
              room={room}
              trigger={<RoomShareTrigger room={room} />}
            />
          ) : null}
          {actions}
        </>
      }
      title={`${room ? roomDisplayName(room) : roomId} / ${title}`}
    >
      {isPending ? (
        <div className="grid min-h-[calc(100svh-56px)] lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]">
          <Skeleton className="h-full rounded-none" />
          <div className="grid content-start gap-4 p-6">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-80 w-full" />
          </div>
        </div>
      ) : error ? (
        <div className="p-6">
          <RoomError message={roomErrorMessage(error)} />
        </div>
      ) : !room ? (
        <div className="p-6">
          <EmptyState
            description="Refresh the connected agents, or verify that this room still belongs to one of them."
            icon={RadioTower}
            title={`Room ${roomId} was not found`}
          />
        </div>
      ) : (
        <div className="grid min-h-[calc(100svh-56px)] bg-background lg:grid-cols-[220px_minmax(0,1fr)] xl:h-[calc(100svh-56px)] xl:min-h-0 xl:grid-cols-[240px_minmax(0,1fr)] xl:overflow-hidden">
          <RoomFrameSidebar
            activeView={activeView}
            channelAction={channelAction}
            channelSearch={channelSearch}
            channels={channels}
            onChannelSearchChange={setChannelSearch}
            room={room}
          />
          <main className="min-w-0 bg-background xl:flex xl:min-h-0 xl:flex-col xl:overflow-hidden">
            <div className="p-4 sm:p-5 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
              <div className="mx-auto grid w-full max-w-6xl gap-5 pb-8">
                <PageSectionHeader>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {roomDisplayName(room)}
                  </p>
                  <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">
                    {title}
                  </h1>
                </PageSectionHeader>
                {actionError ? (
                  <RoomError message={roomErrorMessage(actionError)} />
                ) : null}
                {children}
              </div>
            </div>
          </main>
        </div>
      )}
    </AppShell>
  );
}

function RoomFrameSidebar({
  activeView,
  channelAction,
  channelSearch,
  channels,
  onChannelSearchChange,
  room,
}: {
  activeView: RoomFrameView;
  channelAction?: ReactNode;
  channelSearch: string;
  channels: ReturnType<typeof roomChannels>;
  onChannelSearchChange(value: string): void;
  room: RoomSnapshot;
}) {
  return (
    <aside className="border-b bg-muted/20 lg:border-b-0 lg:border-r xl:flex xl:min-h-0 xl:flex-col xl:overflow-hidden">
      <div className="flex h-14 shrink-0 items-center border-b px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p
              className="truncate text-sm font-semibold"
              title={roomDisplayName(room)}
            >
              {roomDisplayName(room)}
            </p>
            {room.readOnly ? (
              <span className="shrink-0 rounded-control-compact border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                Read only
              </span>
            ) : room.canManage ? (
              <span className="shrink-0 rounded-control-compact border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary">
                {room.accessRole}
              </span>
            ) : null}
          </div>
          <p
            className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
            title={room.id}
          >
            {room.id}
          </p>
        </div>
      </div>
      <div className="shrink-0 p-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search channels"
            className="h-8 w-full rounded-control border bg-background pl-8 pr-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => onChannelSearchChange(event.target.value)}
            placeholder="Find a channel"
            value={channelSearch}
          />
        </label>
      </div>
      <div className="grid content-start gap-5 px-2 pb-4 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
        <section>
          <RoomFrameLabel label="Room" />
          <div className="grid gap-0.5">
            <Link
              className={cn(roomFrameRowClass)}
              to={`/rooms/${room.id}` as never}
            >
              <LayoutDashboard className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">overview</span>
              <RoomFrameStatusDot state={room.state} />
            </Link>
            <Link
              className={cn(
                roomFrameRowClass,
                activeView === "members" && roomFrameActiveClass,
              )}
              to={`/rooms/${room.id}/members` as never}
            >
              <Users className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">members</span>
              <Badge
                className="h-5 min-w-5 justify-center px-1.5 font-mono text-[10px]"
                variant="secondary"
              >
                {room.memberships.length}
              </Badge>
            </Link>
            <Link
              className={cn(
                roomFrameRowClass,
                activeView === "activity" && roomFrameActiveClass,
              )}
              to={`/rooms/${room.id}/activity` as never}
            >
              <Activity className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">activity</span>
            </Link>
            <Link
              className={cn(
                roomFrameRowClass,
                activeView === "transfers" && roomFrameActiveClass,
              )}
              to={`/rooms/${room.id}/transfers` as never}
            >
              <Send className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">transfers</span>
            </Link>
          </div>
        </section>
        <section>
          <RoomFrameLabel action={channelAction} label="Channels" />
          <div className="grid gap-0.5">
            {channels.map((channel) => (
              <Link
                className={roomFrameRowClass}
                key={channel.id}
                to={`/rooms/${room.id}/channels/${channel.id}` as never}
              >
                <Terminal className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                <RoomFrameStatusDot state={channel.state} />
              </Link>
            ))}
          </div>
          {!channels.length ? (
            <p className="px-2 py-2 text-xs leading-5 text-muted-foreground">
              {channelSearch
                ? "No matching channels"
                : "No channels reported by the coordinator"}
            </p>
          ) : null}
        </section>
      </div>
    </aside>
  );
}

function RoomFrameLabel({
  action,
  label,
}: {
  action?: ReactNode;
  label: string;
}) {
  return (
    <div className="mb-1 flex h-7 items-center justify-between px-2">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      {action}
    </div>
  );
}

function RoomFrameStatusDot({ state }: { state: string }) {
  return (
    <span
      className={cn(
        "size-1.5 rounded-full bg-muted-foreground/50",
        state === "active" && "bg-success",
      )}
    />
  );
}

const roomFrameRowClass =
  "flex h-9 items-center gap-2 border-l-2 border-transparent px-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground";
const roomFrameActiveClass =
  "border-l-primary bg-primary/10 font-medium text-foreground";

export function RoomError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function RoomMeta({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all text-sm font-medium">{value || "—"}</dd>
    </div>
  );
}
