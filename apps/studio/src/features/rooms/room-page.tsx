import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Boxes,
  Clock3,
  FileArchive,
  Globe2,
  Info,
  Link2,
  LayoutDashboard,
  MessageSquare,
  Network,
  Plus,
  RadioTower,
  Search,
  Send,
  Server,
  Check,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Skeleton } from "@/components/data-page";
import { PanelHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { formatRelative } from "@/routes/agents";
import { cn } from "@/lib/utils";
import {
  roomAgentName,
  roomChannels,
  roomCoordinator,
  roomDisplayName,
  record,
  text,
  type RoomAgent,
  type RoomChannel,
  type RoomSnapshot,
} from "./room-data";
import {
  roomErrorMessage,
  useChannelMessages,
  useRoomData,
} from "./room-hooks";
import { RoomChannelCreateDialog } from "./room-channels-page";
import { RoomMeta } from "./room-page-frame";
import {
  RoomChannelGrants,
  RoomChannelPolicyDialog,
} from "./room-channel-controls";
import { RoomObjectChannelTransfers } from "./room-object-channel-transfers";
import { RoomMemberGraph } from "./room-member-graph";
import { RoomMediaPlayer } from "./room-media-player";
import {
  fetchRoomTransfers,
  roomTransfersQueryKey,
} from "./room-transfer-data";
import {
  RoomShareDialog,
  RoomShareTrigger,
  copyText,
} from "./room-share-dialog";

export function RoomPage({
  channelId,
  channelView = "content",
  roomId,
}: {
  channelId?: string;
  channelView?: "content" | "details";
  roomId: string;
}) {
  const navigate = useNavigate();
  const { query, room, refreshMutation, actionMutation } = useRoomData(roomId);
  const [channelSearch, setChannelSearch] = useState("");
  const channels = useMemo(() => roomChannels(room), [room]);
  const selectedChannel = channelId
    ? (channels.find((channel) => channel.id === channelId) ?? null)
    : null;
  const visibleChannels = useMemo(() => {
    const needle = channelSearch.trim().toLowerCase();
    return needle
      ? channels.filter((channel) =>
          [channel.name, channel.kind, channel.description, channel.id]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : channels;
  }, [channelSearch, channels]);

  async function closeSelectedChannel() {
    if (!room || !selectedChannel) return;
    await actionMutation.mutateAsync({
      operation: "room.channel.close",
      payload: {
        channel_id: selectedChannel.id,
        expected_authorization_epoch: numeric(
          room.metadata.authorization_epoch,
        ),
        expected_channel_revision: numeric(
          selectedChannel.raw.channel_revision,
        ),
      },
    });
    navigate({ to: `/rooms/${room.id}` as never });
  }

  async function activateSelectedChannel() {
    if (!room || !selectedChannel || selectedChannel.state !== "draft") return;
    await actionMutation.mutateAsync({
      operation: "room.channel.activate",
      payload: {
        channel_id: selectedChannel.id,
        expected_authorization_epoch: numeric(
          room.metadata.authorization_epoch,
        ),
        expected_channel_revision: numeric(
          selectedChannel.raw.channel_revision,
        ),
        new_key_epoch: numeric(selectedChannel.raw.key_epoch) + 1,
      },
    });
  }

  return (
    <AppShell
      contentClassName="min-h-full p-0 xl:h-full xl:overflow-hidden"
      headerActions={
        <>
          {room ? (
            <RoomShareDialog
              room={room}
              trigger={<RoomShareTrigger room={room} />}
            />
          ) : null}
        </>
      }
      title={room ? roomDisplayName(room) : roomId}
    >
      {query.isPending ? (
        <div className="grid min-h-[calc(100svh-56px)] lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]">
          <Skeleton className="h-full rounded-none" />
          <div className="grid content-start gap-4 p-6">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      ) : query.error || refreshMutation.error ? (
        <div className="p-6">
          <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {roomErrorMessage(query.error ?? refreshMutation.error)}
          </div>
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
          <ChannelSidebar
            channelSearch={channelSearch}
            channels={visibleChannels}
            onChannelSearchChange={setChannelSearch}
            room={room}
            selectedChannelId={channelId ?? null}
          />

          <main className="min-w-0 bg-background xl:flex xl:min-h-0 xl:flex-col xl:overflow-hidden">
            {channelId ? (
              <ChannelHeader
                activationPending={actionMutation.isPending}
                channel={selectedChannel}
                channelId={channelId}
                channelView={channelView}
                onActivateChannel={activateSelectedChannel}
                room={room}
              />
            ) : null}
            {actionMutation.error ? (
              <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive sm:px-6">
                {roomErrorMessage(actionMutation.error)}
              </div>
            ) : null}
            {channelId && !selectedChannel ? (
              <div className="p-4 sm:p-6 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
                <EmptyState
                  description="This channel is no longer visible to the current room membership."
                  icon={RadioTower}
                  title={`Channel ${channelId} was not found`}
                />
              </div>
            ) : selectedChannel && channelView === "content" ? (
              selectedChannel.kind === "object" ? (
                <RoomObjectChannelTransfers
                  channel={selectedChannel}
                  room={room}
                />
              ) : selectedChannel.kind === "media" ? (
                <RoomMediaPlayer channel={selectedChannel} room={room} />
              ) : (
                <ChannelConversation channel={selectedChannel} room={room} />
              )
            ) : (
              <RoomContent
                agents={query.data?.agents ?? []}
                channel={selectedChannel}
                closePending={actionMutation.isPending}
                onCloseChannel={closeSelectedChannel}
                room={room}
              />
            )}
          </main>
        </div>
      )}
    </AppShell>
  );
}

function ChannelSidebar({
  channelSearch,
  channels,
  onChannelSearchChange,
  room,
  selectedChannelId,
}: {
  channelSearch: string;
  channels: RoomChannel[];
  onChannelSearchChange(value: string): void;
  room: RoomSnapshot;
  selectedChannelId: string | null;
}) {
  return (
    <aside className="border-b bg-muted/20 lg:border-b-0 lg:border-r xl:flex xl:min-h-0 xl:flex-col xl:overflow-hidden">
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div className="min-w-0">
          <p
            className="truncate text-sm font-semibold"
            title={roomDisplayName(room)}
          >
            {roomDisplayName(room)}
          </p>
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
          <SidebarGroupLabel label="Room" />
          <div className="grid gap-0.5">
            <Link
              className={cn(
                channelRowClass,
                selectedChannelId === null &&
                  "border-l-primary bg-primary/10 font-medium text-foreground",
              )}
              to={`/rooms/${room.id}` as never}
            >
              <LayoutDashboard className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">overview</span>
              <StatusDot state={room.state} />
            </Link>
            <Link
              className={channelRowClass}
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
              className={channelRowClass}
              to={`/rooms/${room.id}/activity` as never}
            >
              <Activity className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">activity</span>
            </Link>
            <Link
              className={channelRowClass}
              to={`/rooms/${room.id}/transfers` as never}
            >
              <Send className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">transfers</span>
            </Link>
          </div>
        </section>

        <section>
          <SidebarGroupLabel
            action={
              <RoomChannelCreateDialog
                room={room}
                trigger={
                  <button
                    aria-label="Add channel"
                    className="grid size-6 place-items-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title="Add channel"
                    type="button"
                  >
                    <Plus className="size-3.5" />
                  </button>
                }
              />
            }
            label="Channels"
          />

          <div className="grid gap-0.5">
            {channels.map((channel) => (
              <Link
                className={cn(
                  channelRowClass,
                  channel.id === selectedChannelId &&
                    "border-l-primary bg-primary/10 font-medium text-foreground",
                )}
                key={channel.id}
                to={`/rooms/${room.id}/channels/${channel.id}` as never}
              >
                <ChannelIcon kind={channel.kind} />
                <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                <StatusDot state={channel.state} />
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

function SidebarGroupLabel({
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

function ChannelHeader({
  activationPending,
  channel,
  channelId,
  channelView,
  onActivateChannel,
  room,
}: {
  activationPending: boolean;
  channel: RoomChannel | null;
  channelId?: string;
  channelView: "content" | "details";
  onActivateChannel(): Promise<void>;
  room: RoomSnapshot;
}) {
  return (
    <PanelHeader className="flex-wrap justify-between gap-3 px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center border bg-muted/40 text-muted-foreground">
          {channel ? (
            <ChannelIcon kind={channel.kind} />
          ) : (
            <LayoutDashboard className="size-4" />
          )}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold normal-case tracking-normal">
              {channel?.name ?? (channelId ? "Unknown channel" : "overview")}
            </h1>
            <Badge
              className={cn(
                "px-1.5 py-0.5 text-[10px]",
                (channel?.state ?? room.state) === "active" &&
                  "border-success/30 text-success",
              )}
              variant="outline"
            >
              {channel?.state ?? (channelId ? "missing" : room.state)}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {channel?.description ??
              (channelId
                ? "This channel is not available to the current membership"
                : "Room state and coordinator activity")}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {channel?.state === "draft" ? (
          <Button
            disabled={activationPending || room.readOnly}
            onClick={() => void onActivateChannel()}
            size="sm"
          >
            <ShieldCheck className="size-3.5" />
            {activationPending ? "Activating…" : "Activate channel"}
          </Button>
        ) : null}
        {channel ? (
          <div className="flex items-center rounded-control border bg-muted/30 p-0.5">
            <Button
              asChild
              className={cn(
                "h-7 gap-1.5 px-2.5 text-xs",
                channelView === "content" && "bg-background shadow-sm",
              )}
              size="sm"
              variant="ghost"
            >
              <Link to={`/rooms/${room.id}/channels/${channel.id}` as never}>
                <MessageSquare className="size-3.5" />
                Content
              </Link>
            </Button>
            <Button
              asChild
              className={cn(
                "h-7 gap-1.5 px-2.5 text-xs",
                channelView === "details" && "bg-background shadow-sm",
              )}
              size="sm"
              variant="ghost"
            >
              <Link
                to={`/rooms/${room.id}/channels/${channel.id}/details` as never}
              >
                <SlidersHorizontal className="size-3.5" />
                Details
              </Link>
            </Button>
          </div>
        ) : null}
        {room.agent ? (
          <Button asChild size="sm" variant="ghost">
            <Link to={`/agents/${room.agent.id}/rooms` as never}>
              <RadioTower className="size-3.5 text-primary" />
              {roomAgentName(room.agent)}
            </Link>
          </Button>
        ) : (
          <Badge variant="secondary">Organization-owned</Badge>
        )}
      </div>
    </PanelHeader>
  );
}

function ChannelConversation({
  channel,
  room,
}: {
  channel: RoomChannel;
  room: RoomSnapshot;
}) {
  const [draft, setDraft] = useState("");
  const messageTail = useRef<HTMLDivElement>(null);
  const session = useChannelMessages(room, channel);
  const canPublish =
    channel.kind === "message" &&
    (room.consumer?.status === "online" || room.agent?.status === "online") &&
    session.state === "live";
  const conversation = channel.kind === "message";

  useEffect(() => {
    messageTail.current?.scrollIntoView({ block: "end" });
  }, [session.messages.length]);

  function sendMessage() {
    if (!canPublish || !draft.trim()) return;
    try {
      session.publish(draft);
      setDraft("");
    } catch {
      // The session status/error banner will surface a concurrent disconnect.
    }
  }

  return (
    <div className="flex min-h-[calc(100svh-130px)] flex-col bg-muted/5 xl:min-h-0 xl:flex-1 xl:overflow-hidden">
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {session.messages.length ? (
          <div className="mx-auto grid max-w-3xl gap-5">
            {session.messages.map((message) => (
              <article
                className={cn(
                  "flex items-end gap-2",
                  conversation && "max-w-[85%]",
                  conversation && message.local && "ml-auto flex-row-reverse",
                )}
                key={message.id}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full border bg-card font-mono text-[10px] font-semibold">
                  {initials(message.author)}
                </span>
                <div
                  className={cn(
                    "min-w-0 flex-1",
                    conversation && message.local && "text-right",
                  )}
                >
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {message.author}
                    </span>
                    <span>{formatRelative(message.createdAt)}</span>
                    {!conversation ? (
                      <>
                        <Badge
                          className="font-mono text-[10px]"
                          variant="outline"
                        >
                          {message.eof
                            ? "closed"
                            : (message.workloadKind ?? channel.kind)}
                        </Badge>
                        {message.contentType ? (
                          <span className="font-mono">
                            {message.contentType}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "rounded-surface rounded-bl-badge border bg-card px-4 py-3 text-left text-sm shadow-sm",
                      conversation &&
                        message.local &&
                        "rounded-bl-surface rounded-br-badge border-primary/20 bg-primary/10",
                      !conversation && "rounded-surface",
                    )}
                  >
                    {conversation ? (
                      message.text
                    ) : (
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                        {message.text}
                      </pre>
                    )}
                  </div>
                  {!conversation && message.workloadId ? (
                    <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                      {message.workloadId}
                    </p>
                  ) : null}
                  {message.local && message.status ? (
                    <p
                      className={cn(
                        "mt-1 font-mono text-[10px] text-muted-foreground",
                        message.status === "failed" && "text-destructive",
                      )}
                    >
                      {message.status}
                    </p>
                  ) : null}
                </div>
              </article>
            ))}
            <div aria-hidden ref={messageTail} />
          </div>
        ) : (
          <EmptyState
            className="mx-auto mt-10 max-w-xl"
            description={
              channel.kind === "message"
                ? "Messages appear here while this live session is connected. Room payloads are not stored by Studio."
                : `${channel.kind} workload output will appear here automatically while the Studio consumer is connected. Payloads are not persisted by Studio.`
            }
            icon={MessageSquare}
            title={
              channel.kind === "message"
                ? "No live messages"
                : `Waiting for ${channel.kind} output`
            }
          />
        )}
      </div>
      <div className="border-t bg-background p-3 sm:p-4">
        <form
          className="mx-auto max-w-3xl"
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-3 px-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  "size-1.5 rounded-full bg-muted-foreground",
                  session.state === "live" && "bg-success",
                  session.state === "connecting" && "bg-warning",
                  session.state === "error" && "bg-destructive",
                )}
              />
              {session.state === "live"
                ? session.hasGap
                  ? "Live again · messages may have been missed while offline"
                  : "Live · content stays ephemeral in Studio"
                : session.state === "connecting"
                  ? "Connecting to the managed agent…"
                  : (session.error ??
                    (session.state === "error"
                      ? "Managed agent channel could not start"
                      : "Managed agent channel is offline"))}
            </span>
            {channel.kind === "message" ? (
              <span className="font-mono">{draft.length}/32768</span>
            ) : (
              <span className="font-mono">observation only</span>
            )}
          </div>
          {channel.kind === "message" ? (
            <div className="flex items-center gap-2 rounded-surface border bg-muted/20 p-2">
              <input
                aria-label="Channel message"
                className="h-9 min-w-0 flex-1 bg-transparent px-2 text-sm outline-none disabled:cursor-not-allowed"
                disabled={!canPublish}
                maxLength={32 * 1024}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  canPublish
                    ? `Message ${channel.name}`
                    : "Publishing requires a live message channel"
                }
                value={draft}
              />
              <Button
                disabled={!canPublish || !draft.trim()}
                size="sm"
                type="submit"
              >
                Send
              </Button>
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function RoomContent({
  agents,
  channel,
  closePending,
  onCloseChannel,
  room,
}: {
  channel: RoomChannel | null;
  closePending: boolean;
  onCloseChannel(): Promise<void>;
  agents: RoomAgent[];
  room: RoomSnapshot;
}) {
  const activity = channel
    ? room.commands
        .filter(
          (command) =>
            containsValue(command.payload, channel.id) ||
            containsValue(command.result, channel.id),
        )
        .slice(0, 6)
    : [];
  const transfersQuery = useQuery({
    queryKey: roomTransfersQueryKey(room.id),
    queryFn: () => fetchRoomTransfers(room.id),
    enabled: !channel,
    refetchInterval: 5_000,
  });
  return (
    <div className="grid auto-rows-max content-start gap-4 p-4 sm:p-6 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
      {channel ? null : <RoomQuickActions room={room} />}

      <section
        className={cn(
          "grid shrink-0 gap-px overflow-hidden border bg-border",
          channel ? "sm:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-4",
        )}
      >
        {channel ? (
          <>
            <Metric
              icon={Network}
              label="Channel state"
              value={channel.state}
            />
            <Metric icon={Terminal} label="Transport" value={channel.kind} />
            <Metric
              icon={ShieldCheck}
              label="Authorization"
              value={`epoch ${String(room.metadata.authorization_epoch ?? "—")}`}
            />
          </>
        ) : (
          <>
            <Metric
              icon={Users}
              label="Members"
              value={String(room.memberships.length)}
            />
            <Metric
              icon={Network}
              label="Channels"
              value={String(room.channels.length)}
            />
            <Metric
              icon={Send}
              label="Transfers"
              value={
                transfersQuery.data
                  ? String(transfersQuery.data.length)
                  : transfersQuery.isPending
                    ? "—"
                    : "0"
              }
            />
            <Metric
              icon={ShieldCheck}
              label="Authorization"
              value={`epoch ${String(room.metadata.authorization_epoch ?? "—")}`}
            />
          </>
        )}
      </section>

      {channel ? null : <RoomOverviewDetails room={room} />}

      {channel ? (
        <section className="border bg-card">
          <SectionHeader
            action={
              <RoomChannelPolicyDialog
                channel={channel}
                key={channel.id}
                room={room}
              />
            }
            description="Coordinator policy currently applied to this channel."
            title="Channel policy"
          />
          <div className="grid gap-px bg-border md:grid-cols-2">
            <PolicyBlock
              label="Delivery"
              value={record(channel.raw.delivery)}
            />
            <PolicyBlock
              label="Persistence"
              value={record(channel.raw.persistence)}
            />
            <PolicyBlock
              label="Quality of service"
              value={record(channel.raw.qos)}
            />
            <PolicyBlock label="Limits" value={record(channel.raw.limits)} />
          </div>
        </section>
      ) : null}

      {channel ? (
        <RoomChannelGrants channel={channel} key={channel.id} room={room} />
      ) : null}

      {channel ? (
        <section className="border bg-card">
          <SectionHeader
            description="Current channel details reported by beam-agentd."
            title="Channel endpoint"
          />
          <div className="grid gap-5 p-4 sm:grid-cols-2 sm:p-5">
            <Detail label="Channel ID">
              <code className="break-all text-sm">{channel.id}</code>
            </Detail>
            <Detail label="Content type">
              <code className="break-all text-sm">
                {text(channel.raw.content_type) ?? "—"}
              </code>
            </Detail>
            <Detail label="Visibility">
              <span className="text-sm">
                {text(channel.raw.visibility) ?? "—"}
              </span>
            </Detail>
            <Detail label="Transport">
              <div className="flex items-center gap-2 text-sm">
                <ChannelIcon kind={channel.kind} />
                {channel.kind}
              </div>
            </Detail>
            <Detail label="Revision">
              <span className="text-sm">
                {String(channel.raw.channel_revision ?? "—")}
              </span>
            </Detail>
            <Detail label="Key epoch">
              <span className="text-sm">
                {String(channel.raw.key_epoch ?? "—")}
              </span>
            </Detail>
          </div>
        </section>
      ) : null}

      {channel ? (
        <section className="border bg-card">
          <SectionHeader
            action={<Badge variant="secondary">Live</Badge>}
            description="Recent durable commands for this channel."
            title="Activity"
          />
          {activity.length ? (
            <div className="divide-y">
              {activity.map((command) => (
                <div
                  className="flex items-start gap-3 px-4 py-3.5 sm:px-5"
                  key={command.id}
                >
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/50",
                      command.state === "completed" &&
                        "bg-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.12)]",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-mono text-sm font-medium">
                        {command.operation}
                      </p>
                      <Badge variant="outline">{command.state}</Badge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {command.id}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock3 className="size-3" />
                    {formatRelative(command.updatedAt ?? command.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              className="m-4"
              description="No persisted command currently references this channel."
              icon={Activity}
              title="No channel activity"
            />
          )}
        </section>
      ) : null}

      {channel && channel.state !== "closed" ? (
        <section className="flex flex-col gap-4 border border-destructive/40 bg-card p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div>
            <h2 className="text-sm font-semibold">Close channel</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Stop new traffic and close this channel for every room member.
            </p>
          </div>
          <ConfirmationDialog
            confirmLabel="Close channel"
            description={`Closing ${channel.name} affects every member using this channel.`}
            onConfirm={onCloseChannel}
            title="Close this channel?"
            trigger={
              <Button
                disabled={
                  closePending ||
                  room.readOnly ||
                  (room.agent !== null && room.agent.status !== "online")
                }
                size="sm"
                variant="destructive"
              >
                <Trash2 className="size-4" />
                Close channel
              </Button>
            }
          />
        </section>
      ) : null}
      {channel ? null : <RoomMemberGraph key={room.id} room={room} agents={agents} />}
    </div>
  );
}

function RoomQuickActions({ room }: { room: RoomSnapshot }) {
  const [linkState, setLinkState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const disabled = room.state !== "active" || room.readOnly;

  async function copyRoomLink() {
    try {
      await copyText(new URL(`/rooms/${room.id}`, window.location.origin).href);
      setLinkState("copied");
    } catch {
      setLinkState("failed");
    }
    window.setTimeout(() => setLinkState("idle"), 2_000);
  }

  return (
    <section className="flex flex-wrap items-center gap-2 border bg-card p-3 sm:p-4">
      <RoomShareDialog
        room={room}
        trigger={
          <Button disabled={disabled} size="sm" type="button">
            <UserPlus className="size-4" />
            Invite participant
          </Button>
        }
      />
      <Button
        onClick={() => void copyRoomLink()}
        size="sm"
        type="button"
        variant="outline"
      >
        {linkState === "copied" ? (
          <Check className="size-4" />
        ) : (
          <Link2 className="size-4" />
        )}
        {linkState === "copied"
          ? "Link copied"
          : linkState === "failed"
            ? "Copy failed"
            : "Share link"}
      </Button>
      <RoomChannelCreateDialog
        room={room}
        trigger={
          <Button disabled={disabled} size="sm" type="button" variant="outline">
            <Plus className="size-4" />
            New channel
          </Button>
        }
      />
      <Button asChild size="sm" variant="outline">
        <Link to={`/rooms/${room.id}/transfers` as never}>
          <Send className="size-4" />
          Send a file
        </Link>
      </Button>
    </section>
  );
}

function RoomOverviewDetails({ room }: { room: RoomSnapshot }) {
  return (
    <div className="grid gap-4">
      <section className="border bg-card">
        <SectionHeader
          description="Read-only identifiers and versions reported by the coordinator."
          title="Room metadata"
        />
        <dl className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3">
          <RoomMeta label="Room ID" value={room.id} />
          <RoomMeta label="State" value={room.state} />
          <RoomMeta
            label="Version"
            value={String(room.metadata.version ?? "—")}
          />
          <RoomMeta
            label="Plan version"
            value={String(room.metadata.plan_version ?? "—")}
          />
          <RoomMeta
            label="Authorization epoch"
            value={String(room.metadata.authorization_epoch ?? "—")}
          />
          <RoomMeta
            label="Key epoch"
            value={String(
              room.metadata.key_epoch ?? room.membership.key_epoch ?? "—",
            )}
          />
          <RoomMeta
            label="Owner principal"
            value={text(room.metadata.owner_principal_id)}
          />
          <RoomMeta
            label="Owner member"
            value={text(room.metadata.owner_member_id)}
          />
          <RoomMeta
            label="Created"
            value={formatTimestamp(text(room.metadata.created_at))}
          />
        </dl>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="border bg-card">
          <SectionHeader
            action={<Server className="size-4 text-primary" />}
            description="Identity currently carrying the room control session."
            title="Runtime"
          />
          <dl className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
            <RoomMeta label="Agent" value={roomAgentName(room.agent)} />
            <RoomMeta label="Agent ID" value={room.agent?.id ?? "—"} />
            <RoomMeta
              label="Agent status"
              value={room.agent?.status ?? "not associated"}
            />
            <RoomMeta label="Coordinator" value={roomCoordinator(room)} />
            <RoomMeta
              label="Renew after"
              value={formatTimestamp(text(room.resume.renew_after))}
            />
            <RoomMeta
              label="Last coordinator attempt"
              value={formatTimestamp(text(room.resume.last_attempt_at))}
            />
          </dl>
        </section>

        <section className="border bg-card">
          <SectionHeader
            action={<ShieldCheck className="size-4 text-primary" />}
            description="Current local member lease and authorization state."
            title="Membership security"
          />
          <div className="grid gap-4 p-4 sm:p-5">
            <div className="flex items-start gap-3 border bg-muted/30 p-3.5">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Room authorization active</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  This status comes from the local BTR membership, not Studio
                  configuration.
                </p>
              </div>
              <Badge variant="secondary">
                {text(room.membership.state) ?? "unknown"}
              </Badge>
            </div>
            <dl className="grid gap-4 sm:grid-cols-2">
              <RoomMeta
                label="Member ID"
                value={text(room.membership.member_id)}
              />
              <RoomMeta
                label="Presence"
                value={text(room.membership.presence)}
              />
              <RoomMeta
                label="Lease version"
                value={String(room.membership.lease_version ?? "—")}
              />
              <RoomMeta
                label="Lease expires"
                value={formatTimestamp(text(room.membership.lease_expires_at))}
              />
            </dl>
            <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" />
              The display label is stored by Studio. It does not alter the room
              identity or the coordinator protocol.
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function formatTimestamp(value: string | null) {
  if (!value || value.startsWith("0001-")) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 bg-card p-4">
      <span className="grid size-9 shrink-0 place-items-center bg-primary/10 text-primary">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 truncate text-lg font-semibold tabular-nums">
          {value}
        </p>
      </div>
    </div>
  );
}

function SectionHeader({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b px-4 py-3 sm:px-5">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

function Detail({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function PolicyBlock({
  label,
  value,
}: {
  label: string;
  value: Record<string, unknown>;
}) {
  return (
    <div className="min-w-0 bg-card p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Boxes className="size-4 text-primary" />
        <h3 className="text-sm font-medium">{label}</h3>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        {Object.entries(value).map(([key, item]) => (
          <Detail key={key} label={humanize(key)}>
            <span className="break-all text-sm">{formatValue(item)}</span>
          </Detail>
        ))}
      </dl>
    </div>
  );
}

function StatusDot({ state }: { state: string }) {
  return (
    <span
      aria-label={state}
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-muted-foreground/50",
        state === "active" && "bg-success",
        state === "syncing" && "animate-pulse bg-running",
      )}
    />
  );
}

function ChannelIcon({ kind }: { kind: string }) {
  const className = "size-4 shrink-0";
  if (["http", "https", "web"].includes(kind)) {
    return <Globe2 className={className} />;
  }
  if (["object", "file", "blob"].includes(kind)) {
    return <FileArchive className={className} />;
  }
  return <Terminal className={className} />;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function containsValue(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  if (Array.isArray(value))
    return value.some((item) => containsValue(item, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) =>
    containsValue(item, expected),
  );
}

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "—");
}

const channelRowClass =
  "group flex h-9 w-full items-center gap-2 border-l-2 border-transparent px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground";
