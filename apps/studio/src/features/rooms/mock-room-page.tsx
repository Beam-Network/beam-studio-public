import { useMemo, useState, type ComponentType } from "react";
import { useLocation } from "@tanstack/react-router";
import {
  Activity,
  Check,
  Copy,
  FileArchive,
  Globe2,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  RadioTower,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  UserPlus,
  Users,
  Zap,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PanelHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  mockParticipants,
  mockRoomActivity,
  type MockParticipant,
} from "./mock-room-activity-data";
import { mockRoomById } from "./mock-room-data";

type ChannelKind = "http" | "object" | "tcp";
type ChannelState = "active" | "idle" | "syncing";

type MockChannel = {
  id: string;
  name: string;
  description: string;
  group: "Network" | "Objects";
  kind: ChannelKind;
  state: ChannelState;
  endpoint: string;
  target: string;
  sessions: number;
  throughput: string;
};

const channels: MockChannel[] = [
  {
    id: "api-gateway",
    name: "api-gateway",
    description: "Public HTTP access to the production API gateway.",
    group: "Network",
    kind: "http",
    state: "active",
    endpoint: "https://api-gateway.room.beam.sh",
    target: "127.0.0.1:3000",
    sessions: 12,
    throughput: "2.8 MB/s",
  },
  {
    id: "postgres-primary",
    name: "postgres-primary",
    description: "Private TCP channel for the primary database.",
    group: "Network",
    kind: "tcp",
    state: "active",
    endpoint: "tcp://postgres-primary.room.beam.sh:55432",
    target: "10.0.2.14:5432",
    sessions: 4,
    throughput: "780 KB/s",
  },
  {
    id: "ssh-maintenance",
    name: "ssh-maintenance",
    description: "Restricted maintenance access for room owners.",
    group: "Network",
    kind: "tcp",
    state: "idle",
    endpoint: "tcp://ssh-maintenance.room.beam.sh:22022",
    target: "127.0.0.1:22",
    sessions: 0,
    throughput: "0 B/s",
  },
  {
    id: "build-artifacts",
    name: "build-artifacts",
    description: "Shared object channel for release artifacts.",
    group: "Objects",
    kind: "object",
    state: "syncing",
    endpoint: "beam://production-eu/build-artifacts",
    target: "/srv/releases",
    sessions: 3,
    throughput: "12.4 MB/s",
  },
];
const defaultChannel = channels[0]!;

export function MockRoomPage() {
  const location = useLocation();
  const room = mockRoomById(roomIdFromPath(location.pathname));
  const [selectedChannelId, setSelectedChannelId] = useState(defaultChannel.id);
  const [channelSearch, setChannelSearch] = useState("");
  const [copyState, setCopyState] = useState<"copied" | "idle">("idle");
  const [inviteVisible, setInviteVisible] = useState(false);
  const selectedChannel =
    channels.find((channel) => channel.id === selectedChannelId) ??
    defaultChannel;
  const channelGroups = useMemo(() => {
    const needle = channelSearch.trim().toLowerCase();
    const visible = needle
      ? channels.filter((channel) =>
          [channel.name, channel.kind, channel.description]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : channels;
    return ["Network", "Objects"].map((group) => ({
      channels: visible.filter((channel) => channel.group === group),
      name: group,
    }));
  }, [channelSearch]);

  async function copyEndpoint() {
    await navigator.clipboard.writeText(selectedChannel.endpoint);
    setCopyState("copied");
    window.setTimeout(() => setCopyState("idle"), 1_500);
  }

  return (
    <AppShell
      contentClassName="min-h-full p-0"
      headerActions={
        <>
          <Badge
            className="hidden border-amber-500/30 bg-amber-500/10 text-warning sm:inline-flex dark:text-amber-400"
            variant="outline"
          >
            Mock data
          </Badge>
          <Button
            onClick={() => setInviteVisible((visible) => !visible)}
            size="sm"
            type="button"
            variant="outline"
          >
            <UserPlus className="size-4" />
            Invite
          </Button>
        </>
      }
      title={room.name}
    >
      <div className="grid min-h-[calc(100svh-56px)] bg-background lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_280px]">
        <ChannelSidebar
          channelGroups={channelGroups}
          channelSearch={channelSearch}
          onChannelSearchChange={setChannelSearch}
          onSelectChannel={setSelectedChannelId}
          roomName={room.name}
          selectedChannelId={selectedChannel.id}
        />

        <main className="min-w-0 bg-background">
          <ChannelHeader agentName={room.agentName} channel={selectedChannel} />
          <div className="grid gap-4 p-4 sm:p-6">
            {inviteVisible ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
                <div>
                  <p className="font-medium">Mock invite ready</p>
                  <p className="text-muted-foreground">
                    The real flow will generate a scoped room invitation here.
                  </p>
                </div>
                <Button
                  onClick={() => setInviteVisible(false)}
                  size="sm"
                  variant="ghost"
                >
                  Dismiss
                </Button>
              </div>
            ) : null}

            <section className="grid gap-px overflow-hidden border bg-border sm:grid-cols-3">
              <Metric
                icon={Users}
                label="Active sessions"
                value={String(selectedChannel.sessions)}
              />
              <Metric
                icon={Zap}
                label="Throughput"
                value={selectedChannel.throughput}
              />
              <Metric icon={Activity} label="Median latency" value="24 ms" />
            </section>

            <section className="border bg-card" id="activity">
              <SectionHeader
                description="Current routing details reported by beam-agentd."
                title="Channel endpoint"
              />
              <div className="grid gap-5 p-4 sm:grid-cols-2 sm:p-5">
                <Detail label="Public endpoint">
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 flex-1 truncate text-sm">
                      {selectedChannel.endpoint}
                    </code>
                    <Button
                      aria-label="Copy endpoint"
                      className="size-8 shrink-0"
                      onClick={() => void copyEndpoint()}
                      size="icon"
                      variant="ghost"
                    >
                      {copyState === "copied" ? (
                        <Check className="size-4 text-success" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                    </Button>
                  </div>
                </Detail>
                <Detail label="Agent target">
                  <code className="text-sm">{selectedChannel.target}</code>
                </Detail>
                <Detail label="Transport">
                  <div className="flex items-center gap-2 text-sm">
                    <ChannelIcon kind={selectedChannel.kind} />
                    {selectedChannel.kind.toUpperCase()}
                  </div>
                </Detail>
                <Detail label="Security">
                  <div className="flex items-center gap-2 text-sm">
                    <LockKeyhole className="size-4 text-primary" />
                    End-to-end encrypted
                  </div>
                </Detail>
              </div>
            </section>

            <section className="border bg-card">
              <SectionHeader
                action={<Badge variant="secondary">Live</Badge>}
                description="Recent room events for this channel."
                title="Activity"
              />
              <div className="divide-y">
                {mockRoomActivity.map((event) => (
                  <div
                    className="flex items-start gap-3 px-4 py-3.5 sm:px-5"
                    key={event.id}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/50",
                        event.tone === "active" &&
                          "bg-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.12)]",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{event.label}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {event.meta}
                      </p>
                    </div>
                    <Button
                      aria-label="Event actions"
                      className="size-8"
                      disabled
                      size="icon"
                      variant="ghost"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </main>

        <ParticipantSidebar id="members" participants={mockParticipants} />
      </div>
    </AppShell>
  );
}

function ChannelSidebar({
  channelGroups,
  channelSearch,
  onChannelSearchChange,
  onSelectChannel,
  roomName,
  selectedChannelId,
}: {
  channelGroups: Array<{ channels: MockChannel[]; name: string }>;
  channelSearch: string;
  onChannelSearchChange(value: string): void;
  onSelectChannel(id: string): void;
  roomName: string;
  selectedChannelId: string;
}) {
  return (
    <aside className="border-b bg-muted/20 lg:border-b-0 lg:border-r">
      <div className="flex h-14 items-center justify-between border-b px-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{roomName}</p>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            Room connected
          </div>
        </div>
      </div>
      <div className="p-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search channels"
            className="h-8 w-full border bg-background pl-8 pr-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => onChannelSearchChange(event.target.value)}
            placeholder="Find a channel"
            value={channelSearch}
          />
        </label>
      </div>
      <div className="grid gap-5 px-2 pb-4">
        {channelGroups.map((group) => (
          <section key={group.name}>
            <div className="mb-1 flex h-7 items-center justify-between px-2">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {group.name}
              </span>
              <button
                aria-label={`Add ${group.name.toLowerCase()} channel`}
                className="grid size-6 place-items-center text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                disabled
                type="button"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            <div className="grid gap-0.5">
              {group.channels.map((channel) => {
                const active = channel.id === selectedChannelId;
                return (
                  <button
                    className={cn(
                      "group flex h-9 w-full items-center gap-2 border-l-2 border-transparent px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
                      active &&
                        "border-l-primary bg-primary/10 font-medium text-foreground",
                    )}
                    key={channel.id}
                    onClick={() => onSelectChannel(channel.id)}
                    type="button"
                  >
                    <ChannelIcon kind={channel.kind} />
                    <span className="min-w-0 flex-1 truncate">
                      {channel.name}
                    </span>
                    <StatusDot state={channel.state} />
                  </button>
                );
              })}
              {!group.channels.length ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  No matching channels
                </p>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}

function ChannelHeader({
  agentName,
  channel,
}: {
  agentName: string;
  channel: MockChannel;
}) {
  return (
    <PanelHeader className="flex-wrap justify-between gap-3 px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center border bg-muted/40 text-muted-foreground">
          <ChannelIcon kind={channel.kind} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold normal-case tracking-normal">
              {channel.name}
            </h1>
            <Badge
              className={cn(
                "px-1.5 py-0.5 text-[10px]",
                channel.state === "active" &&
                  "border-success/30 text-success",
                channel.state === "syncing" &&
                  "border-cyan-500/30 text-cyan-600 dark:text-cyan-400",
              )}
              variant="outline"
            >
              {channel.state}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {channel.description}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <RadioTower className="size-3.5 text-primary" />
        {agentName}
      </div>
    </PanelHeader>
  );
}

function ParticipantSidebar({
  id,
  participants,
}: {
  id?: string;
  participants: MockParticipant[];
}) {
  const present = participants.filter(
    (participant) => participant.status !== "offline",
  );
  const offline = participants.filter(
    (participant) => participant.status === "offline",
  );

  return (
    <aside
      className="border-t bg-muted/10 lg:col-span-2 xl:col-span-1 xl:border-l xl:border-t-0"
      id={id}
    >
      <div className="flex h-14 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Participants</span>
          <span className="font-mono text-xs text-muted-foreground">
            {participants.length}
          </span>
        </div>
        <Button
          aria-label="Invite participant"
          className="size-8"
          disabled
          size="icon"
          variant="ghost"
        >
          <UserPlus className="size-4" />
        </Button>
      </div>
      <div className="grid gap-6 p-3 lg:grid-cols-2 xl:grid-cols-1">
        <ParticipantGroup
          label={`Online — ${present.length}`}
          participants={present}
        />
        <ParticipantGroup
          label={`Offline — ${offline.length}`}
          participants={offline}
        />
      </div>
      <div className="mx-3 border p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="size-4 text-primary" />
          Room security
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Membership and channel grants are enforced by every connected agent.
        </p>
      </div>
    </aside>
  );
}

function ParticipantGroup({
  label,
  participants: groupParticipants,
}: {
  label: string;
  participants: MockParticipant[];
}) {
  return (
    <section>
      <p className="px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-2 grid gap-1">
        {groupParticipants.map((participant) => (
          <div
            className={cn(
              "flex w-full items-center gap-3 px-2 py-2 text-left",
              participant.status === "offline" && "opacity-50",
            )}
            key={participant.id}
          >
            <span className="relative grid size-8 shrink-0 place-items-center border bg-muted font-mono text-[10px] font-semibold">
              {initials(participant.name)}
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-muted-foreground",
                  participant.status === "online" && "bg-success",
                  participant.status === "away" && "bg-warning",
                )}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">
                  {participant.name}
                </span>
                {participant.role === "Owner" ? (
                  <LockKeyhole className="size-3 text-primary" />
                ) : null}
              </span>
              <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                <Server className="size-3 shrink-0" />
                {participant.machine}
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
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
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      </div>
    </div>
  );
}

function SectionHeader({
  action,
  description,
  title,
}: {
  action?: React.ReactNode;
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

function Detail({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function StatusDot({ state }: { state: ChannelState }) {
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

function ChannelIcon({ kind }: { kind: ChannelKind }) {
  const className = "size-4 shrink-0";
  if (kind === "http") return <Globe2 className={className} />;
  if (kind === "object") return <FileArchive className={className} />;
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

function roomIdFromPath(pathname: string) {
  const match = pathname.match(/^\/rooms\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
