import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Navigate,
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  Activity,
  ChevronDown,
  CircleStop,
  Clock3,
  Code2,
  Gauge,
  FolderInput,
  LogIn,
  LogOut,
  Network,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  Settings2,
  ShieldAlert,
  Terminal,
  Trash2,
  Unplug,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import {
  EmptyState,
  Skeleton,
  FilterBar,
  FilterSelect,
  SearchInput,
  ResultCounter,
} from "@/components/data-page";
import { AgentCopyButton } from "@/components/agent-copy-button";
import {
  capabilityLabel,
  compactAgentId,
  compactDaemonVersion,
  endpointPermissions,
  isTunnelCapability,
  mergeAgentLogs,
  refreshAfterCommand,
  terminalCommandStates,
  type AgentLog,
} from "@/lib/agent-workspace";
import { studioEnv } from "@/lib/env";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apiGet, apiSend } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { BillingKeySelect } from "@/features/billing/billing-key-select";
import {
  roomsQueryKey,
  roomDisplayName,
  runRoomCommand,
} from "@/features/rooms/room-data";
import { useRoomsData } from "@/features/rooms/room-hooks";
import { formatRelative, type AgentRecord } from "./agents";

type CommandRecord = {
  id: string;
  sequence: number;
  operation: string;
  state: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  sessionGeneration?: number | null;
};

type AgentEvent = {
  id: string;
  commandId?: string | null;
  sequence?: number | null;
  type: string;
  payload?: Record<string, unknown>;
  createdAt?: string | null;
};

type AgentDetailPayload = {
  agent: AgentRecord;
  commands?: CommandRecord[];
  events?: AgentEvent[];
};
const emptyCommands: CommandRecord[] = [];
const emptyEvents: AgentEvent[] = [];

export type AgentTab =
  | "overview"
  | "tunnels"
  | "destinations"
  | "rooms"
  | "logs"
  | "activity"
  | "settings";

// Tunnel and destination tabs are hidden while Studio offers only Rooms.
const tunnelTabs = new Set<AgentTab>(["tunnels", "destinations"]);

const allTabs: Array<{ id: AgentTab; label: string; icon: typeof Gauge }> = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "tunnels", label: "Tunnels", icon: Network },
  { id: "destinations", label: "Destinations", icon: FolderInput },
  { id: "rooms", label: "Rooms", icon: Users },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings },
];
const tabs = allTabs.filter(
  (item) => studioEnv.tunnelsEnabled || !tunnelTabs.has(item.id),
);

export const Route: any = createFileRoute("/agents/$id")({
  component: AgentRoute,
});

function AgentRoute() {
  const { id } = Route.useParams();
  const location = useLocation();

  if (location.pathname !== `/agents/${id}`) {
    return <Outlet />;
  }

  return <Navigate replace to={`/agents/${id}/overview` as never} />;
}

export function AgentDetailPage({
  agentId,
  tab,
}: {
  agentId: string;
  tab: AgentTab;
}) {
  return <AgentWorkspace key={agentId} agentId={agentId} tab={tab} />;
}

function AgentWorkspace({
  agentId: id,
  tab,
}: {
  agentId: string;
  tab: AgentTab;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const [submitted, setSubmitted] = useState<CommandRecord[]>([]);
  const completedCommands = useRef<Set<string> | null>(null);
  const entrySnapshot = useRef("");
  const queryKey = [`/studio/agents/${id}`];
  const query = useQuery({
    queryKey,
    queryFn: () => apiGet<AgentDetailPayload>(`/studio/agents/${id}`),
    refetchInterval: 2_500,
  });
  const commandMutation = useMutation({
    mutationFn: (input: {
      operation: string;
      payload?: Record<string, unknown>;
      ttlSeconds?: number;
    }) =>
      apiSend<{ command: CommandRecord }>(
        "POST",
        `/studio/agents/${id}/commands`,
        {
          ...input,
          idempotencyKey: crypto.randomUUID(),
        },
      ),
    onSuccess: (result, input) => {
      setNotice("Request sent. Track execution below.");
      // Delegated responses may contain transient invitation tokens. Track
      // identity/state only; fetch redacted results from command history.
      const { id: commandId, sequence, operation, state } = result.command;
      setSubmitted((current) =>
        [{ id: commandId, sequence, operation, state }, ...current].slice(
          0,
          10,
        ),
      );
      void queryClient.invalidateQueries({ queryKey });
      if (input.operation.startsWith("room.")) {
        void queryClient.invalidateQueries({ queryKey: roomsQueryKey });
      }
    },
  });
  const revokeMutation = useMutation({
    mutationFn: () => apiSend("POST", `/studio/agents/${id}/revoke`),
    onSuccess: () => navigate({ to: "/agents" }),
  });
  const agent = query.data?.agent;
  const commands = query.data?.commands ?? emptyCommands;
  const events = query.data?.events ?? emptyEvents;

  useEffect(() => {
    if (!query.data) return;
    const finished = commands.filter((command) =>
      terminalCommandStates.has(command.state),
    );
    if (!completedCommands.current) {
      completedCommands.current = new Set(
        finished.map((command) => command.id),
      );
      return;
    }
    const refresh = new Set<string>();
    for (const command of finished) {
      if (completedCommands.current.has(command.id)) continue;
      completedCommands.current.add(command.id);
      if (command.state !== "completed") continue;
      refreshAfterCommand(command.operation).forEach((operation) =>
        refresh.add(operation),
      );
      if (command.operation.startsWith("room."))
        void queryClient.invalidateQueries({ queryKey: roomsQueryKey });
    }
    for (const operation of refresh) {
      void apiSend("POST", `/studio/agents/${id}/commands`, {
        operation,
        payload: {},
        idempotencyKey: crypto.randomUUID(),
      })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: [`/studio/agents/${id}`] }),
        )
        .catch(() =>
          setNotice(
            "The action completed, but its snapshot could not be refreshed. Use Refresh to retry.",
          ),
        );
    }
  }, [query.data, id, queryClient]);

  // Load each section on entry/reconnection, never on every heartbeat.
  useEffect(() => {
    if (agent?.status !== "online") return;
    const entry = `${id}:${tab}:${agent.sessionGeneration}`;
    if (entrySnapshot.current === entry) return;
    entrySnapshot.current = entry;
    const operations =
      tab === "overview"
        ? ["metrics.snapshot", "agent.status.get"]
        : tab === "tunnels" || tab === "destinations"
          ? ["endpoint.list"]
          : tab === "logs"
            ? ["logs.snapshot"]
            : [];
    for (const operation of operations) {
      void apiSend("POST", `/studio/agents/${id}/commands`, {
        operation,
        payload: {},
        idempotencyKey: crypto.randomUUID(),
      })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: [`/studio/agents/${id}`] }),
        )
        .catch(() =>
          setNotice("Could not request fresh data. Use Refresh to retry."),
        );
    }
  }, [id, tab, agent?.status, agent?.sessionGeneration, queryClient]);

  function send(operation: string, payload: Record<string, unknown> = {}) {
    commandMutation.mutate({ operation, payload });
  }

  async function sendAndWait(
    operation: string,
    payload: Record<string, unknown> = {},
  ) {
    await commandMutation.mutateAsync({ operation, payload });
  }

  if (query.isPending) {
    return (
      <AppShell contentClassName="px-3 py-4">
        <div className="grid gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      </AppShell>
    );
  }
  if (!agent) {
    return (
      <AppShell contentClassName="px-3 py-4">
        <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {String(query.error ?? "Agent not found")}
        </div>
      </AppShell>
    );
  }

  const online = agent.status === "online";
  return (
    <AppShell
      contentClassName="min-h-full p-0 xl:h-full xl:overflow-hidden"
      title={agent.name || agent.machineName || agent.id}
      headerActions={
        <>
          <Button
            disabled={commandMutation.isPending || !online}
            onClick={() => send("agent.status.get")}
            size="sm"
            variant="secondary"
          >
            <RefreshCw
              className={cn(
                "size-4",
                commandMutation.isPending && "animate-spin",
              )}
            />{" "}
            Sync status
          </Button>
        </>
      }
    >
      <div className="grid min-h-[calc(100svh-56px)] grid-rows-[auto_1fr] lg:grid-cols-[220px_minmax(0,1fr)] lg:grid-rows-1 xl:h-[calc(100svh-56px)] xl:min-h-0 xl:grid-cols-[240px_minmax(0,1fr)] xl:overflow-hidden">
        <AgentSidebar agent={agent} tab={tab} />
        <div className="min-w-0 p-4 sm:p-6 xl:min-h-0 xl:overflow-y-auto">
          <div className="grid min-w-0 content-start gap-5 pb-6">
            <header>
              <h1 className="text-xl font-semibold tracking-tight">
                {tabs.find((item) => item.id === tab)?.label}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {sectionDescriptions[tab]}
              </p>
            </header>
            <div
              className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
              role="status"
            >
              <span title={new Date(query.dataUpdatedAt).toLocaleString()}>
                Last synced{" "}
                {formatRelative(new Date(query.dataUpdatedAt).toISOString())}
              </span>
              {query.error ? (
                <>
                  <span className="text-amber-700 dark:text-amber-300">
                    Connection interrupted — showing last known data.
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void query.refetch()}
                  >
                    Retry
                  </Button>
                </>
              ) : null}
            </div>
            {!online ? (
              <div className="flex items-start gap-3 rounded-surface border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <div>
                  <p className="font-medium">
                    {agent.status === "revoked"
                      ? "Agent access revoked"
                      : "Agent is offline"}
                  </p>
                  <p className="text-muted-foreground">
                    {agent.status === "revoked"
                      ? "Enroll this machine again to restore access."
                      : "Commands will wait for this agent to reconnect and may expire if it stays offline."}
                  </p>
                </div>
              </div>
            ) : null}
            {notice ? (
              <div
                className="flex items-center justify-between gap-3 rounded-control border bg-muted/30 px-4 py-3 text-sm"
                role="status"
              >
                <span>
                  {notice}{" "}
                  <Link
                    className="underline underline-offset-4"
                    to={`/agents/${id}/activity` as never}
                  >
                    View activity
                  </Link>
                </span>
                <Button onClick={() => setNotice("")} size="sm" variant="ghost">
                  Dismiss
                </Button>
              </div>
            ) : null}
            {commandMutation.error ? (
              <ErrorBlock error={commandMutation.error} />
            ) : null}
            {notice && submitted.length ? (
              <div
                className="divide-y rounded-surface border"
                aria-live="polite"
              >
                {submitted
                  .map(
                    (accepted) =>
                      commands.find((command) => command.id === accepted.id) ??
                      accepted,
                  )
                  .map((command) => (
                    <div
                      className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm"
                      key={command.id}
                    >
                      <span>{capabilityLabel(command.operation)}</span>
                      <CommandState state={command.state} />
                      {command.error ? (
                        <span className="text-destructive">
                          {String(
                            command.error.message ||
                              command.error.code ||
                              "Command failed",
                          )}
                        </span>
                      ) : null}
                    </div>
                  ))}
              </div>
            ) : null}
            {revokeMutation.error ? (
              <ErrorBlock error={revokeMutation.error} />
            ) : null}

            {tab === "overview" ? (
              <Overview
                agent={agent}
                commands={commands}
                pending={commandMutation.isPending}
                send={send}
              />
            ) : null}
            {tab === "tunnels" ? (
              <Tunnels
                agent={agent}
                commands={commands}
                pending={commandMutation.isPending}
                send={send}
                sendAndWait={sendAndWait}
              />
            ) : null}
            {tab === "destinations" ? (
              <Destinations
                agent={agent}
                commands={commands}
                pending={commandMutation.isPending}
                send={send}
                sendAndWait={sendAndWait}
              />
            ) : null}
            {tab === "rooms" ? (
              <>
                {(agent.policy?.rooms_enabled ?? agent.policy?.roomsEnabled) ===
                false ? (
                  <p className="text-sm text-muted-foreground">
                    Room actions are disabled by Studio policy.
                  </p>
                ) : null}
                <Rooms
                  agentId={id}
                  pending={
                    commandMutation.isPending ||
                    agent.status === "revoked" ||
                    (agent.policy?.rooms_enabled ??
                      agent.policy?.roomsEnabled) === false
                  }
                  send={send}
                  sendAndWait={sendAndWait}
                />
              </>
            ) : null}
            {tab === "logs" ? (
              <Logs
                key={id}
                events={events}
                online={online}
                sessionGeneration={agent.sessionGeneration}
                commands={commands}
                pending={
                  commandMutation.isPending ||
                  commands.some(
                    (command) =>
                      ["logs.subscribe", "logs.unsubscribe"].includes(
                        command.operation,
                      ) && !terminalCommandStates.has(command.state),
                  )
                }
                send={send}
              />
            ) : null}
            {tab === "activity" ? (
              <ActivityTimeline commands={commands} events={events} />
            ) : null}
            {tab === "settings" ? (
              <AgentSettings
                agent={agent}
                pending={revokeMutation.isPending}
                onRevoke={() => revokeMutation.mutateAsync()}
              />
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

const sectionDescriptions: Record<AgentTab, string> = {
  overview: "Connection health, runtime and available capabilities.",
  tunnels: "Expose a service running on this machine.",
  destinations: "Manage where this machine receives files.",
  rooms: "Connect this agent to shared rooms.",
  logs: "Inspect recent logs and manage live updates.",
  activity: "Track commands and events reported by this agent.",
  settings: "Review this machine’s identity, permissions and access.",
};

function AgentSidebar({ agent, tab }: { agent: AgentRecord; tab: AgentTab }) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const id = agent.id;
  const online = agent.status === "online";
  return (
    <aside className="flex min-w-0 flex-col border-b bg-muted/20 lg:border-b-0 lg:border-r xl:min-h-0 xl:overflow-y-auto">
      <div className="min-w-0 border-b p-4">
        <p className="break-words text-sm font-semibold leading-5">
          {agent.name || agent.machineName || id}
        </p>
        <span className="mt-1 inline-flex items-center gap-1.5 text-xs capitalize text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              online
                ? "bg-success"
                : ["stale", "connecting"].includes(agent.status)
                  ? "bg-warning"
                  : "bg-muted-foreground",
            )}
          />
          {agent.status}
        </span>
      </div>
      <Button
        aria-controls="agent-navigation"
        aria-expanded={navigationOpen}
        className="m-2 justify-between lg:hidden"
        onClick={() => setNavigationOpen(!navigationOpen)}
        variant="ghost"
      >
        {tabs.find((item) => item.id === tab)?.label}
        <ChevronDown
          className={cn(
            "size-4 transition-transform",
            navigationOpen && "rotate-180",
          )}
        />
      </Button>
      <nav
        id="agent-navigation"
        aria-label="Agent sections"
        className={cn("gap-1 p-2 lg:grid", navigationOpen ? "grid" : "hidden")}
      >
        {tabs.map(({ id: tabID, label, icon: Icon }) => (
          <Link
            aria-current={tab === tabID ? "page" : undefined}
            className={cn(
              "flex h-10 min-w-0 items-center gap-2 border-l-2 border-transparent px-3 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              tab === tabID &&
                "border-l-primary bg-primary/10 font-medium text-foreground",
              tabID === "logs" && "mt-4",
            )}
            key={tabID}
            onClick={() => setNavigationOpen(false)}
            to={`/agents/${id}/${tabID}` as never}
          >
            <Icon className="size-4 shrink-0" /> {label}
          </Link>
        ))}
      </nav>
      <div
        className={cn(
          "mt-auto min-w-0 border-t p-4 lg:block",
          navigationOpen ? "block" : "hidden",
        )}
      >
        <dl className="grid gap-3 text-sm">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">ID</dt>
            <dd className="mt-1 flex min-w-0 items-center gap-1">
              <code className="truncate text-xs" title={id} aria-label={id}>
                {compactAgentId(id)}
              </code>
              <AgentCopyButton value={id} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Daemon</dt>
            <dd
              className="mt-1 truncate font-mono text-xs"
              title={agent.daemonVersion || "Unknown"}
              aria-label={agent.daemonVersion || "Unknown"}
            >
              {compactDaemonVersion(agent.daemonVersion)}
            </dd>
          </div>
          <Meta
            label="Platform"
            value={
              [agent.platform, agent.architecture]
                .filter(Boolean)
                .join(" / ") || "Unknown"
            }
          />
          <Meta
            label="Last heartbeat"
            value={formatRelative(agent.heartbeatAt || agent.lastSeenAt)}
          />
        </dl>
      </div>
    </aside>
  );
}

function Overview({
  agent,
  commands,
  pending,
  send,
}: {
  agent: AgentRecord;
  commands: CommandRecord[];
  pending: boolean;
  send(operation: string, payload?: Record<string, unknown>): void;
}) {
  const latestMetrics = latestResult(commands, "metrics.snapshot")?.metrics as
    | Record<string, unknown>
    | undefined;
  const latestStatus = latestResult(commands, "agent.status.get")?.status as
    | Record<string, unknown>
    | undefined;
  const visibleCapabilities = (agent.capabilities ?? []).filter(
    (capability) => studioEnv.tunnelsEnabled || !isTunnelCapability(capability),
  );
  return (
    <div className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.5fr)]">
      <section className="min-w-0 overflow-hidden rounded-surface border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div>
            <h2 className="font-medium">Runtime snapshot</h2>
            <p className="text-sm text-muted-foreground">
              Latest metrics reported by this machine.
            </p>
            <SnapshotFreshness
              commands={commands}
              operation="metrics.snapshot"
            />
          </div>
          <Button
            disabled={pending || agent.status !== "online"}
            onClick={() => send("metrics.snapshot")}
            size="sm"
            variant="outline"
          >
            <Gauge className="size-4" /> Refresh metrics
          </Button>
        </div>
        {studioEnv.tunnelsEnabled ? (
          <dl className="grid gap-px bg-border sm:grid-cols-2">
            <Metric
              label="Endpoints"
              value={metric(latestMetrics, "endpoints_total")}
            />
            <Metric
              label="Active endpoints"
              value={metric(latestMetrics, "endpoints_active")}
            />
            <Metric
              label="Operations"
              value={metric(latestMetrics, "operations_total")}
            />
            <Metric
              label="Running operations"
              value={metric(latestMetrics, "operations_running")}
            />
          </dl>
        ) : null}
        <div className="border-t p-4">
          <dl className="grid min-w-0 gap-4 text-sm sm:grid-cols-2">
            <Meta
              label="Last heartbeat"
              value={formatRelative(agent.heartbeatAt || agent.lastSeenAt)}
            />
            <Meta label="Enrolled" value={formatRelative(agent.enrolledAt)} />
            <Meta
              label="Platform"
              value={
                [agent.platform, agent.architecture]
                  .filter(Boolean)
                  .join(" / ") || "Unknown"
              }
            />
            <Meta label="Daemon" value={agent.daemonVersion || "Unknown"} />
          </dl>
          {latestStatus ? (
            <div className="mt-4">
              <DataDetailsDialog
                title="Runtime details"
                description="Latest status reported by the agent."
                value={latestStatus}
              />
            </div>
          ) : null}
        </div>
      </section>
      <section className="min-w-0 rounded-surface border bg-card p-4">
        <h2 className="font-medium">Capabilities</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Available actions on this machine.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {visibleCapabilities.length ? (
            visibleCapabilities.map((capability) => (
              <Badge
                className="max-w-full break-all normal-case tracking-normal"
                key={String(capability)}
                title={String(capability)}
                variant="secondary"
              >
                {capabilityLabel(capability)}
              </Badge>
            ))
          ) : (
            <span className="text-sm text-muted-foreground">None reported</span>
          )}
        </div>
        <div className="mt-5 border-t pt-4">
          <Meta
            label="Topology"
            value={
              agent.workerId
                ? `Embedded in worker ${agent.workerId}`
                : "Standalone agent"
            }
          />
        </div>
      </section>
    </div>
  );
}

type EndpointWorkspaceProps = {
  agent: AgentRecord;
  commands: CommandRecord[];
  pending: boolean;
  send(operation: string, payload?: Record<string, unknown>): void;
  sendAndWait(
    operation: string,
    payload?: Record<string, unknown>,
  ): Promise<void>;
};

function Tunnels(props: EndpointWorkspaceProps) {
  return <EndpointWorkspace {...props} mode="tunnel" />;
}

function Destinations(props: EndpointWorkspaceProps) {
  return <EndpointWorkspace {...props} mode="destination" />;
}

function EndpointWorkspace({
  agent,
  commands,
  pending,
  send,
  sendAndWait,
  mode,
}: EndpointWorkspaceProps & { mode: "tunnel" | "destination" }) {
  const destination = mode === "destination";
  const permissions = endpointPermissions(agent.policy);
  const canCreate =
    agent.status !== "revoked" &&
    (destination ? permissions.filesAllowed : permissions.kinds.length > 0);
  const [kind, setKind] = useState("http");
  const [target, setTarget] = useState("");
  const [isPublic, setPublic] = useState(false);
  const snapshot = latestResult(commands, "endpoint.list");
  const endpoints = arrayResult(snapshot?.endpoints).filter((endpoint) =>
    destination
      ? endpoint.direction === "destination"
      : endpoint.direction !== "destination",
  );
  const title = destination ? "Create destination" : "Create tunnel";
  return (
    <section className="min-w-0 overflow-hidden rounded-surface border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <h2 className="font-medium">
            {destination ? "Receive endpoints" : "Managed endpoints"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {snapshot
              ? `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} in the latest snapshot`
              : "Refresh to load the endpoints on this machine."}
          </p>
          <SnapshotFreshness commands={commands} operation="endpoint.list" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending}
            onClick={() => send("endpoint.list")}
            size="sm"
            variant="outline"
          >
            <RefreshCw className={cn("size-4", pending && "animate-spin")} />{" "}
            Refresh
          </Button>
          <AgentActionDialog
            title={title}
            description={
              destination
                ? "Choose a directory allowed by this agent’s file access policy."
                : "Choose a service on this machine to expose through a tunnel."
            }
            pending={pending || !canCreate}
            submitDisabled={
              !target.trim() ||
              (!destination && !permissions.kinds.includes(kind))
            }
            onOpen={() => {
              setKind(permissions.kinds[0] ?? "http");
              setTarget(destination ? "" : "127.0.0.1:3000");
              setPublic(false);
            }}
            onSubmit={() =>
              sendAndWait(
                destination ? "destination.create" : "tunnel.create",
                destination
                  ? {
                      directory: target.trim(),
                      public: isPublic && permissions.publicAllowed,
                    }
                  : {
                      kind,
                      target: target.trim(),
                      public: isPublic && permissions.publicAllowed,
                    },
              )
            }
          >
            {!destination ? (
              <Field label="Kind">
                <select
                  className={inputClass}
                  onChange={(event) => setKind(event.target.value)}
                  value={kind}
                >
                  {permissions.kinds.map((value) => (
                    <option key={value} value={value}>
                      {value === "webrtc" ? "WebRTC" : value.toUpperCase()}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label={destination ? "Directory" : "Target"}>
              <input
                autoFocus
                className={inputClass}
                onChange={(event) => setTarget(event.target.value)}
                placeholder={
                  destination ? "/srv/beam/incoming" : "127.0.0.1:3000"
                }
                required
                value={target}
              />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input
                className="mt-1"
                checked={isPublic}
                disabled={!permissions.publicAllowed}
                onChange={(event) => setPublic(event.target.checked)}
                type="checkbox"
              />
              <span>
                Request public access
                <span className="mt-1 block text-xs text-muted-foreground">
                  {permissions.publicAllowed
                    ? "The machine’s local policy must also allow public access."
                    : "Public access is disabled by Studio policy."}
                </span>
              </span>
            </label>
            <p className="text-xs text-muted-foreground">
              Studio restrictions are applied here. The machine’s local policy
              is checked when the command runs.
              {permissions.roots.length
                ? ` Allowed folders: ${permissions.roots.join(", ")}`
                : ""}
            </p>
          </AgentActionDialog>
        </div>
      </div>
      {!canCreate ? (
        <p className="border-b px-4 py-3 text-sm text-muted-foreground">
          {agent.status === "revoked"
            ? "Reconnect this agent to create endpoints."
            : "Creating this type of endpoint is disabled by Studio policy."}
        </p>
      ) : null}
      {endpoints.length ? (
        <div className="divide-y">
          {endpoints.map((endpoint, index) => (
            <EndpointRow
              endpoint={endpoint}
              key={String(endpoint.id ?? index)}
              pending={pending}
              onClose={() => sendAndWait("endpoint.close", { id: endpoint.id })}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          className="m-4"
          icon={destination ? FolderInput : Network}
          title={
            snapshot
              ? destination
                ? "No destinations yet"
                : "No endpoints yet"
              : "No snapshot yet"
          }
          description={
            snapshot
              ? destination
                ? "Create a destination to receive files on this machine."
                : "Create a tunnel to expose a local service."
              : "Refresh to request the current endpoints from this agent."
          }
        />
      )}
    </section>
  );
}

function EndpointRow({
  endpoint,
  pending,
  onClose,
}: {
  endpoint: Record<string, unknown>;
  pending: boolean;
  onClose(): Promise<void>;
}) {
  const active = ["starting", "active", "closing"].includes(
    String(endpoint.status),
  );
  const name = String(endpoint.public_url || endpoint.target || endpoint.id);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full bg-muted-foreground",
          endpoint.status === "active" && "bg-success",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={name}>
          {name}
        </p>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {String(endpoint.kind)} · {String(endpoint.direction)} ·{" "}
          {String(endpoint.status)}
        </p>
      </div>
      {active ? (
        <ConfirmationDialog
          title="Close this endpoint?"
          description={`This will stop connections to ${name}.`}
          confirmLabel="Close endpoint"
          onConfirm={onClose}
          trigger={
            <Button disabled={pending} size="sm" variant="ghost">
              <CircleStop className="size-4" /> Close
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

function AgentActionDialog({
  children,
  description,
  onOpen,
  onSubmit,
  pending,
  submitDisabled = false,
  title,
  triggerLabel,
  submitLabel,
  variant = "default",
}: {
  children: ReactNode;
  description: string;
  onOpen?(): void;
  onSubmit(): Promise<void>;
  pending: boolean;
  submitDisabled?: boolean;
  title: string;
  triggerLabel?: string;
  submitLabel?: string;
  variant?: "default" | "outline" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const busy = pending || submitting;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        setOpen(next);
        if (next) {
          setError("");
          onOpen?.();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={pending} size="sm" variant={variant}>
          {variant === "default" ? (
            <Plus className="size-4" />
          ) : (
            <Settings2 className="size-4" />
          )}
          {triggerLabel || title}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto rounded-surface">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setSubmitting(true);
            setError("");
            try {
              await onSubmit();
              setOpen(false);
            } catch (error) {
              setError(errorMessage(error));
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {children}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button
              disabled={submitting}
              onClick={() => setOpen(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button disabled={busy || submitDisabled} type="submit">
              {busy ? <RefreshCw className="size-4 animate-spin" /> : null}
              {busy ? "Sending…" : submitLabel || title}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DataDetailsDialog({
  title,
  description,
  value,
}: {
  title: string;
  description: string;
  value: unknown;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Code2 className="size-4" /> {title}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto rounded-surface">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[60svh] overflow-auto rounded-control bg-muted/50 p-4 text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function Rooms({
  agentId,
  pending,
  send,
  sendAndWait,
}: {
  agentId: string;
  pending: boolean;
  send(operation: string, payload?: Record<string, unknown>): void;
  sendAndWait(
    operation: string,
    payload?: Record<string, unknown>,
  ): Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [createTTL, setCreateTTL] = useState(60);
  const [joinTTL, setJoinTTL] = useState(60);
  const [joinRoomID, setJoinRoomID] = useState("");
  const [invitation, setInvitation] = useState("");
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [notice, setNotice] = useState("");
  // Starting a room is billable, so the create names the key that pays for it.
  const [apiKeyId, setApiKeyId] = useState("");
  const queryClient = useQueryClient();
  const {
    query: roomsQuery,
    refreshMutation,
    beamTemplate,
    roomControlAvailable,
  } = useRoomsData();
  const rooms = (roomsQuery.data?.rooms ?? []).filter(
    (room) => room.agent?.id === agentId,
  );
  const roomIDs = rooms.map((room) => room.id);

  async function createRoom() {
    if (creating) return;
    setCreating(true);
    setCreateError("");
    try {
      // Created on the organization's own delegated path rather than through
      // the agent: Studio holds the paying key and forwards it server-side, so
      // no key secret is sent over the agent connection.
      await runRoomCommand(
        null,
        "room.create",
        { lease_ttl_seconds: createTTL },
        apiKeyId,
      );
      await queryClient.invalidateQueries({ queryKey: roomsQueryKey });
      setCreateOpen(false);
      setApiKeyId("");
      setNotice(
        "Room created through the Coordinator. The agent will adopt it when connected.",
      );
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  function openJoinDialog() {
    setJoinError("");
    setJoinRoomID("");
    setInvitation("");
    setJoinTTL(60);
    setJoinOpen(true);
  }

  return (
    <div className="grid min-w-0 gap-5">
      <section className="overflow-hidden rounded-surface border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b p-4 sm:p-5">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-medium">Connected rooms</h2>
              <Badge variant="secondary">{rooms.length}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Rooms this agent currently belongs to.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                !roomControlAvailable || pending || refreshMutation.isPending
              }
              onClick={() => refreshMutation.mutate()}
              size="sm"
              variant="outline"
            >
              <RefreshCw
                className={cn(
                  "size-4",
                  refreshMutation.isPending && "animate-spin",
                )}
              />{" "}
              Refresh
            </Button>
            <Button
              disabled={pending || joining}
              onClick={openJoinDialog}
              size="sm"
              type="button"
              variant="secondary"
            >
              <LogIn className="size-4" /> Join room
            </Button>
            <Dialog
              open={createOpen}
              onOpenChange={(open) => {
                if (creating) return;
                setCreateOpen(open);
                if (open) {
                  setCreateError("");
                  setApiKeyId("");
                  setCreateTTL(60);
                }
              }}
            >
              <DialogTrigger asChild>
                <Button
                  disabled={!roomControlAvailable || creating || pending}
                  size="sm"
                  type="button"
                >
                  <Plus className="size-4" /> Create room
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto rounded-surface">
                <DialogHeader>
                  <DialogTitle>Create a room</DialogTitle>
                  <DialogDescription>
                    Create a private coordination room managed by the Beam
                    Coordinator.
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="grid gap-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createRoom();
                  }}
                >
                  <Field label="Lease TTL (seconds)">
                    <input
                      className={inputClass}
                      min={15}
                      onChange={(event) =>
                        setCreateTTL(Number(event.target.value))
                      }
                      required
                      type="number"
                      value={createTTL}
                    />
                  </Field>
                  <BillingKeySelect
                    beamTemplate={beamTemplate}
                    onChange={setApiKeyId}
                    value={apiKeyId}
                  />
                  {createError ? (
                    <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                      {createError}
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button
                      disabled={creating}
                      onClick={() => setCreateOpen(false)}
                      type="button"
                      variant="ghost"
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={
                        !roomControlAvailable ||
                        creating ||
                        createTTL < 15 ||
                        !apiKeyId
                      }
                      type="submit"
                    >
                      {creating ? (
                        <RefreshCw className="size-4 animate-spin" />
                      ) : (
                        <Plus className="size-4" />
                      )}{" "}
                      {creating ? "Creating…" : "Create room"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        {notice ? (
          <div className="flex items-center justify-between gap-3 border-b bg-success/10 px-4 py-3 text-sm text-success">
            <span>{notice}</span>
            <Button
              className="h-auto px-2 py-1"
              onClick={() => setNotice("")}
              type="button"
              variant="ghost"
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        {rooms.length ? (
          <div className="divide-y">
            {rooms.map((room) => {
              const roomID = room.id;
              const state = room.state;
              return (
                <div
                  className="grid gap-4 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:px-5"
                  key={roomID}
                >
                  <span className="grid size-10 place-items-center rounded-full bg-primary/10 text-primary">
                    <Users className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        className="truncate font-mono text-sm font-medium underline-offset-4 hover:underline"
                        title={roomDisplayName(room)}
                        to={`/rooms/${roomID}` as never}
                      >
                        {roomDisplayName(room)}
                      </Link>
                      <Badge
                        className={cn(
                          state === "active" &&
                            "border-success/30 text-success",
                        )}
                        variant="outline"
                      >
                        {state}
                      </Badge>
                    </div>
                    <p
                      className="mt-1 truncate font-mono text-xs text-muted-foreground"
                      title={roomID}
                    >
                      {roomID}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1 sm:justify-end">
                    <Button
                      disabled={!roomControlAvailable || pending || !roomID}
                      onClick={() => send("room.refresh", { room_id: roomID })}
                      size="sm"
                      variant="ghost"
                    >
                      <RefreshCw className="size-4" /> Refresh
                    </Button>
                    <Button
                      disabled={!roomControlAvailable || pending || !roomID}
                      onClick={() => send("room.leave", { room_id: roomID })}
                      size="sm"
                      variant="ghost"
                    >
                      <LogOut className="size-4" /> Leave
                    </Button>
                    <ConfirmationDialog
                      confirmLabel="Close room"
                      description={`Closing ${roomID} affects every member and cannot be reversed.`}
                      onConfirm={() =>
                        sendAndWait("room.close", { room_id: roomID })
                      }
                      title="Close this room?"
                      trigger={
                        <Button
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={!roomControlAvailable || pending || !roomID}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" /> Close
                        </Button>
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            action={
              <Button
                disabled={pending || joining}
                onClick={openJoinDialog}
                size="sm"
                variant="outline"
              >
                <LogIn className="size-4" /> Join a room
              </Button>
            }
            className="m-4"
            description="Join an existing room with an invitation, or create a new one."
            icon={Users}
            title="This agent has no rooms"
          />
        )}
        {roomsQuery.error ? <ErrorBlock error={roomsQuery.error} /> : null}
      </section>

      <RoomMetadataCommand
        pending={pending}
        roomIDs={roomIDs}
        send={sendAndWait}
      />

      <Dialog
        open={joinOpen}
        onOpenChange={(open) => {
          if (joining) return;
          setJoinOpen(open);
          if (!open) setInvitation("");
        }}
      >
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto rounded-surface">
          <DialogHeader>
            <DialogTitle>Join a room</DialogTitle>
            <DialogDescription>
              The invitation token is sent once and is never retained by this
              page.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-5"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending || joining) return;
              setJoining(true);
              setJoinError("");
              try {
                await sendAndWait("room.join", {
                  room_id: joinRoomID.trim(),
                  invitation_token: invitation,
                  lease_ttl_seconds: joinTTL,
                });
                setInvitation("");
                setJoinOpen(false);
              } catch (error) {
                setJoinError(errorMessage(error));
              } finally {
                setJoining(false);
              }
            }}
          >
            <Field label="Room ID">
              <input
                autoComplete="off"
                className={inputClass}
                onChange={(event) => setJoinRoomID(event.target.value)}
                placeholder="room_…"
                required
                value={joinRoomID}
              />
            </Field>
            <Field label="Invitation token">
              <input
                autoComplete="off"
                className={inputClass}
                onChange={(event) => setInvitation(event.target.value)}
                required
                type="password"
                value={invitation}
              />
            </Field>
            <Field label="Lease TTL (seconds)">
              <input
                className={inputClass}
                min={10}
                onChange={(event) => setJoinTTL(Number(event.target.value))}
                required
                type="number"
                value={joinTTL}
              />
            </Field>
            {joinError ? (
              <p className="text-sm text-destructive" role="alert">
                {joinError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                disabled={joining}
                onClick={() => {
                  setJoinOpen(false);
                  setInvitation("");
                }}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={
                  pending ||
                  joining ||
                  !joinRoomID.trim() ||
                  !invitation ||
                  joinTTL < 10
                }
                type="submit"
              >
                <LogIn className="size-4" />{" "}
                {joining ? "Joining…" : "Join room"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const roomMetadataOperationGroups = [
  {
    label: "Inspect",
    operations: [
      ["room.get", "Room details"],
      ["room.memberships.list", "Memberships"],
      ["room.roles.list", "Roles"],
      ["room.channels.list", "Channels"],
      ["room.grants.list", "Grants"],
    ],
  },
  {
    label: "Invitations",
    operations: [["room.invitation.create", "Create invitation"]],
  },
  {
    label: "Roles",
    operations: [
      ["room.role.create", "Create role"],
      ["room.role.assign", "Assign role"],
      ["room.role.revoke", "Revoke role"],
    ],
  },
  {
    label: "Channels",
    operations: [
      ["room.channel.create", "Create channel"],
      ["room.channel.activate", "Activate channel"],
      ["room.channel.update", "Update channel"],
      ["room.channel.close", "Close channel"],
    ],
  },
  {
    label: "Grants",
    operations: [
      ["room.grant.put", "Create or update grant"],
      ["room.grant.revoke", "Revoke grant"],
    ],
  },
] as const;

function RoomMetadataCommand({
  pending,
  roomIDs,
  send,
}: {
  pending: boolean;
  roomIDs: string[];
  send(operation: string, payload?: Record<string, unknown>): Promise<void>;
}) {
  const [operation, setOperation] = useState("room.memberships.list");
  const [roomID, setRoomID] = useState(roomIDs[0] ?? "");
  const [payload, setPayload] = useState(() =>
    roomMetadataPayload(roomIDs[0] ?? ""),
  );

  function selectRoom(nextRoomID: string) {
    setRoomID(nextRoomID);
    setPayload(roomMetadataPayload(nextRoomID));
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <div>
        <h2 className="text-sm font-medium">Advanced room controls</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Roles, channels, grants and invitations.
        </p>
      </div>
      <AgentActionDialog
        title="Advanced room controls"
        triggerLabel="Open controls"
        submitLabel="Run action"
        variant="outline"
        description="Send an advanced command to a room through this agent."
        pending={pending}
        submitDisabled={!roomID.trim()}
        onOpen={() => {
          setOperation("room.memberships.list");
          selectRoom(roomIDs[0] ?? "");
        }}
        onSubmit={async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            throw new Error("Payload must be a valid JSON object.");
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Payload must be a valid JSON object.");
          await send(operation, parsed as Record<string, unknown>);
        }}
      >
        <Field label="Room">
          {roomIDs.length ? (
            <select
              className={inputClass}
              onChange={(event) => selectRoom(event.target.value)}
              value={roomID}
            >
              {roomIDs.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={inputClass}
              onChange={(event) => selectRoom(event.target.value)}
              placeholder="room_…"
              required
              value={roomID}
            />
          )}
        </Field>
        <Field label="Action">
          <select
            className={inputClass}
            onChange={(event) => {
              setOperation(event.target.value);
              setPayload(roomMetadataPayload(roomID));
            }}
            value={operation}
          >
            {roomMetadataOperationGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.operations.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="JSON payload">
          <textarea
            className="min-h-36 rounded-control border bg-background p-3 font-mono text-xs font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setPayload(event.target.value)}
            spellCheck={false}
            value={payload}
          />
        </Field>
      </AgentActionDialog>
    </div>
  );
}

function Logs({
  commands,
  events,
  online,
  sessionGeneration,
  pending,
  send,
}: {
  commands: CommandRecord[];
  events: AgentEvent[];
  online: boolean;
  sessionGeneration?: number | null;
  pending: boolean;
  send(operation: string, payload?: Record<string, unknown>): void;
}) {
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("all");
  const [follow, setFollow] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const snapshot = latestResult(commands, "logs.snapshot")?.logs;
  useEffect(() => {
    setLogs((current) => mergeAgentLogs(current, snapshot, events));
  }, [snapshot, events]);
  const visibleLogs = logs.filter(
    (log) =>
      (level === "all" ||
        log.level === level ||
        (level === "warn" && log.level === "warning")) &&
      `${log.time} ${log.message}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  useEffect(() => {
    if (follow && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [logs, follow, search, level]);
  const subscription = commands.find(
    (command) =>
      command.state === "completed" &&
      command.sessionGeneration === sessionGeneration &&
      (command.operation === "logs.subscribe" ||
        command.operation === "logs.unsubscribe"),
  );
  const subscribed =
    subscription?.operation === "logs.subscribe" &&
    subscription.state === "completed";
  return (
    <section className="overflow-hidden rounded-surface border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <h2 className="font-medium">Agent logs</h2>
          <p className="text-sm text-muted-foreground">
            {subscribed && online
              ? "Following agent events · refreshed every 2.5 seconds."
              : "Load recent logs or start live updates."}{" "}
            Latest 1,000 entries; the agent may rate-limit live events.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={pending || !online}
            onClick={() => send("logs.snapshot")}
            size="sm"
            variant="outline"
          >
            <RefreshCw className="size-4" /> Snapshot
          </Button>
          <Button
            disabled={pending || !online}
            onClick={() =>
              send(subscribed ? "logs.unsubscribe" : "logs.subscribe")
            }
            size="sm"
            variant="secondary"
          >
            {subscribed ? "Stop live updates" : "Start live updates"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setFollow(!follow)}
            aria-pressed={!follow}
          >
            {follow ? "Pause scrolling" : "Follow latest"}
          </Button>
        </div>
      </div>
      <div className="border-b p-3">
        <FilterBar>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search logs…"
          />
          <FilterSelect
            label="Log level"
            value={level}
            onChange={setLevel}
            options={[
              ["all", "All levels"],
              ["debug", "Debug"],
              ["info", "Info"],
              ["warn", "Warning"],
              ["error", "Error"],
            ]}
          />
          <ResultCounter
            totalCount={logs.length}
            visibleCount={visibleLogs.length}
          />
        </FilterBar>
      </div>
      {visibleLogs.length ? (
        <div ref={viewport} className="max-h-[520px] divide-y overflow-auto">
          {visibleLogs.map((log) => (
            <div
              className="grid gap-2 p-3 font-mono text-xs sm:grid-cols-[150px_64px_minmax(0,1fr)]"
              key={log.key}
            >
              <span className="text-muted-foreground">
                {String(log.time || "")}
              </span>
              <span
                className={cn(
                  log.level === "error" && "text-destructive",
                  ["warn", "warning"].includes(log.level) && "text-warning",
                )}
              >
                {log.level}
              </span>
              <span className="break-words">{String(log.message || "")}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          className="m-4"
          icon={ScrollText}
          title={logs.length ? "No matching logs" : "No logs yet"}
          description={
            logs.length
              ? "Try another search or log level."
              : "Request a snapshot or start live updates when the agent is online."
          }
        />
      )}
    </section>
  );
}

function AgentSettings({
  agent,
  pending,
  onRevoke,
}: {
  agent: AgentRecord;
  pending: boolean;
  onRevoke(): Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(agent.name || agent.machineName || "");
  const rename = useMutation({
    mutationFn: () =>
      apiSend("PATCH", `/studio/agents/${agent.id}`, { name: name.trim() }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/studio/agents"] }),
        queryClient.invalidateQueries({
          queryKey: [`/studio/agents/${agent.id}`],
        }),
      ]);
    },
  });
  return (
    <div className="grid min-w-0 gap-5">
      <section className="min-w-0 rounded-surface border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Machine identity</h2>
          <AgentActionDialog
            title="Rename agent"
            description="Choose a recognizable name in Studio. This does not change the machine’s hostname."
            pending={rename.isPending}
            submitDisabled={!name.trim() || name.trim().length > 160}
            variant="outline"
            submitLabel="Save name"
            onOpen={() => setName(agent.name || agent.machineName || "")}
            onSubmit={async () => {
              await rename.mutateAsync();
            }}
          >
            <Field label="Agent name">
              <input
                className={inputClass}
                autoFocus
                required
                maxLength={160}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </AgentActionDialog>
        </div>
        <dl className="mt-4 grid min-w-0 gap-4 text-sm sm:grid-cols-2">
          <Meta label="Agent ID" value={agent.id} />
          <div className="flex items-center gap-2">
            <AgentCopyButton value={agent.id} />
            <span className="text-xs text-muted-foreground">Copy agent ID</span>
          </div>
          <Meta label="Machine ID" value={agent.machineId || "Not reported"} />
          <Meta
            label="Session generation"
            value={String(agent.sessionGeneration ?? 0)}
          />
          <Meta label="Worker" value={agent.workerId || "Standalone agent"} />
        </dl>
      </section>
      <section className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-surface border bg-card p-4 sm:p-5">
        <div>
          <h2 className="font-medium">Access policy</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Permissions are set on the machine. Studio can only restrict them.
          </p>
        </div>
        <DataDetailsDialog
          title="View policy"
          description="Studio restrictions. The machine’s local policy can restrict access further."
          value={agent.policy ?? {}}
        />
      </section>
      <section className="min-w-0 rounded-surface border bg-card p-4 sm:p-5">
        <h2 className="font-medium">Connection security</h2>
        <dl className="mt-4 grid min-w-0 gap-4 text-sm sm:grid-cols-2">
          <Meta label="Direction" value="Outbound agent → Studio" />
          <Meta label="Transport" value="WSS (TLS required outside loopback)" />
          <Meta label="Identity" value="Ed25519 proof of possession" />
          <Meta
            label="Credentials"
            value="Short-lived access tokens; private key remains local"
          />
        </dl>
      </section>
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-surface border border-destructive/30 p-4 sm:p-5">
        <div>
          <h2 className="font-medium">Revoke agent access</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Disconnect this machine from Studio. Re-enrollment is required to
            connect again.
          </p>
        </div>
        <ConfirmationDialog
          confirmLabel="Revoke agent"
          description="This disconnects the agent and revokes all of its Studio credentials. The agent must be enrolled again to reconnect."
          onConfirm={onRevoke}
          title="Revoke this agent?"
          trigger={
            <Button
              disabled={pending || agent.status === "revoked"}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              size="sm"
              variant="outline"
            >
              <Unplug className="size-4" /> Revoke access
            </Button>
          }
        />
      </section>
    </div>
  );
}

function ActivityTimeline({
  commands,
  events,
}: {
  commands: CommandRecord[];
  events: AgentEvent[];
}) {
  const [search, setSearch] = useState("");
  const [state, setState] = useState("all");
  const entries = useMemo(
    () =>
      [
        ...commands.map((command) => ({
          id: `command:${command.id}`,
          time: command.updatedAt || command.createdAt,
          title: command.operation,
          state: command.state,
          detail: command.error || command.result,
        })),
        ...events.map((event) => ({
          id: `event:${event.id}`,
          time: event.createdAt,
          title: event.type,
          state: "event",
          detail: event.payload,
        })),
      ].sort(
        (left, right) =>
          new Date(right.time || 0).getTime() -
          new Date(left.time || 0).getTime(),
      ),
    [commands, events],
  );
  const visible = entries.filter(
    (entry) =>
      (state === "all" ||
        entry.state === state ||
        (state === "pending" &&
          ["queued", "dispatched", "accepted", "running"].includes(
            entry.state,
          )) ||
        (state === "errors" &&
          ["failed", "expired", "cancelled"].includes(entry.state))) &&
      `${entry.title} ${JSON.stringify(entry.detail ?? {})}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <section className="overflow-hidden rounded-surface border bg-card">
      <div className="border-b p-4">
        <h2 className="font-medium">Recent activity</h2>
        <p className="text-sm text-muted-foreground">
          Commands and agent events, newest first.
        </p>
      </div>
      <div className="border-b p-3">
        <FilterBar>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search commands and results…"
          />
          <FilterSelect
            label="Activity result"
            value={state}
            onChange={setState}
            options={[
              ["all", "All activity"],
              ["pending", "In progress"],
              ["completed", "Succeeded"],
              ["errors", "Failed / expired / cancelled"],
              ["event", "Events"],
            ]}
          />
          <ResultCounter
            totalCount={entries.length}
            visibleCount={visible.length}
          />
        </FilterBar>
      </div>
      {visible.length ? (
        <div className="divide-y">
          {visible.map((entry) => (
            <div
              className="grid gap-3 p-4 sm:grid-cols-[24px_minmax(0,1fr)_auto]"
              key={entry.id}
            >
              <span className="mt-0.5 grid size-6 place-items-center rounded-full bg-muted">
                <Terminal className="size-3" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p
                    className="min-w-0 truncate font-mono text-sm font-medium"
                    title={entry.title}
                  >
                    {entry.title}
                  </p>
                  <CommandState state={entry.state} />
                </div>
                {entry.detail ? (
                  <div className="mt-2">
                    <DataDetailsDialog
                      title="View details"
                      description={entry.title}
                      value={entry.detail}
                    />
                  </div>
                ) : null}
              </div>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3 className="size-3" />
                {formatRelative(entry.time)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          className="m-4"
          icon={Activity}
          title={entries.length ? "No matching activity" : "No agent activity"}
        />
      )}
    </section>
  );
}

function CommandState({ state }: { state: string }) {
  const success = state === "completed";
  const failed = ["failed", "cancelled", "expired"].includes(state);
  return (
    <Badge
      className={cn(
        success && "border-success/30 text-success",
        failed && "border-destructive/40 text-destructive",
      )}
      variant="outline"
    >
      {state}
    </Badge>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold">{value}</dd>
    </div>
  );
}
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate" title={value}>
        {value}
      </dd>
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}
function ErrorBlock({ error }: { error: unknown }) {
  return (
    <div className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      {String(error)}
    </div>
  );
}

const inputClass =
  "h-10 rounded-control border bg-background px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring";

function latestResult(commands: CommandRecord[], operation: string) {
  return commands.find(
    (command) =>
      command.operation === operation && command.state === "completed",
  )?.result;
}
function SnapshotFreshness({
  commands,
  operation,
}: {
  commands: CommandRecord[];
  operation: string;
}) {
  const snapshot = commands.find(
    (command) =>
      command.operation === operation && command.state === "completed",
  );
  const time = snapshot?.updatedAt || snapshot?.createdAt;
  const latestRequest = commands.find(
    (command) => command.operation === operation,
  );
  return (
    <p
      className="mt-1 text-xs text-muted-foreground"
      title={time ? new Date(time).toLocaleString() : undefined}
    >
      {time
        ? `Snapshot from ${formatRelative(time)}`
        : "No snapshot received yet"}
      {latestRequest && !terminalCommandStates.has(latestRequest.state)
        ? " · refresh in progress"
        : ""}
      {latestRequest &&
      ["failed", "expired", "cancelled"].includes(latestRequest.state)
        ? ` · refresh ${latestRequest.state}`
        : ""}
    </p>
  );
}
function arrayResult(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object",
      )
    : [];
}
function metric(metrics: Record<string, unknown> | undefined, key: string) {
  const value = metrics?.[key];
  return typeof value === "number" ? String(value) : "—";
}
function roomMetadataPayload(roomID: string) {
  return JSON.stringify({ room_id: roomID }, null, 2);
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
