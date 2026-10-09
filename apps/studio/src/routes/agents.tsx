import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
} from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Circle,
  Copy,
  ExternalLink,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { AgentCopyButton } from "@/components/agent-copy-button";
import {
  FilterBar,
  FilterSelect,
  ResultCounter,
  SearchInput,
} from "@/components/data-page";
import { PageSectionHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Stepper } from "@/components/ui/stepper";
import { ApiError } from "@/lib/api-errors";
import { apiGet, apiSend } from "@/lib/api-client";
import { sortAgentsForInventory } from "@/lib/agent-inventory";
import { studioEnv } from "@/lib/env";
import { cn } from "@/lib/utils";

export type AgentRecord = {
  id: string;
  machineId?: string | null;
  machineName?: string | null;
  workerId?: string | null;
  name?: string | null;
  status: string;
  daemonVersion?: string | null;
  platform?: string | null;
  architecture?: string | null;
  capabilities?: unknown[];
  policy?: Record<string, unknown>;
  sessionGeneration?: number;
  heartbeatAt?: string | null;
  lastSeenAt?: string | null;
  enrolledAt?: string | null;
};

type AgentsPayload = { agents?: AgentRecord[] };
type Enrollment = {
  enrollmentId: string;
  code: string;
  expiresAt: string;
};
type EnrollmentStatus = {
  enrollmentId: string;
  status: string;
  consumedAt?: string | null;
  agentId?: string | null;
  agentStatus?: string | null;
};
type EnrollmentPermissions = {
  publicTunnels: boolean;
  file: boolean;
  http: boolean;
  stream: boolean;
  webrtc: boolean;
  tcp: boolean;
  rooms: boolean;
};
type EnrollmentStep = "machine" | "access" | "install" | "connect";
type EnrollmentProfile = "rooms" | "http" | "files" | "full" | "custom";
type CommandShell = "bash" | "powershell" | "container";
type EnrollmentConfig = {
  studioURL: string;
  fileRoot: string;
  networkTargets: string;
  permissions: EnrollmentPermissions;
  profile: EnrollmentProfile;
};
const inputClassName =
  "h-10 rounded-control border bg-background px-3 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const Route: any = createFileRoute("/agents")({
  component: AgentsRoute,
});

function AgentsRoute() {
  const location = useLocation();
  return location.pathname === "/agents" ? <AgentsPage /> : <Outlet />;
}

function AgentsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const query = useQuery({
    queryKey: ["/studio/agents"],
    queryFn: () => apiGet<AgentsPayload>("/studio/agents"),
    refetchInterval: 5_000,
  });
  const agents = query.data?.agents ?? [];
  const visibleAgents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sortAgentsForInventory(
      agents.filter(
        (agent) =>
          (statusFilter === "all" || agent.status === statusFilter) &&
          [
            agent.id,
            agent.name,
            agent.machineName,
            agent.status,
            agent.platform,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(needle),
      ),
    );
  }, [agents, search, statusFilter]);
  const online = agents.filter((agent) => agent.status === "online").length;
  const deleteMutation = useMutation({
    mutationFn: (agentId: string) =>
      apiSend("DELETE", `/studio/agents/${encodeURIComponent(agentId)}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/studio/agents"] }),
  });

  return (
    <AppShell
      contentClassName="px-3 py-4"
      headerActions={
        <Button asChild size="sm">
          <Link to="/agents/new">
            <Plus className="size-4" />
            Connect an agent
          </Link>
        </Button>
      }
    >
      <div className="grid min-w-0 gap-3">
        <FilterBar>
          <SearchInput
            onChange={setSearch}
            placeholder="Search agents and machines..."
            value={search}
          />
          <FilterSelect
            label="Agent status"
            onChange={setStatusFilter}
            options={[
              ["all", "All statuses"],
              ["online", `Online (${online})`],
              ["offline", "Offline"],
              ["stale", "Not responding"],
              ["connecting", "Connecting"],
              ["revoked", "Revoked"],
            ]}
            value={statusFilter}
          />
          <ResultCounter
            isPending={query.isPending}
            totalCount={agents.length}
            visibleCount={visibleAgents.length}
          />
        </FilterBar>

        {query.error ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-control border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
          >
            <span>
              {query.data
                ? "Connection interrupted — showing last known agents."
                : "Could not load agents."}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {query.dataUpdatedAt ? (
          <p
            className="text-xs text-muted-foreground"
            title={new Date(query.dataUpdatedAt).toLocaleString()}
          >
            Last synced{" "}
            {formatRelative(new Date(query.dataUpdatedAt).toISOString())}
          </p>
        ) : null}
        {deleteMutation.error ? (
          <ErrorBlock error={deleteMutation.error} />
        ) : null}
        {query.isPending ? (
          <div
            className="rounded-surface border bg-card px-4 py-8 text-center text-sm text-muted-foreground"
            role="status"
          >
            Loading agents...
          </div>
        ) : visibleAgents.length ? (
          <div className="overflow-hidden rounded-surface border bg-card">
            <table className="w-full table-fixed text-left text-sm">
              <caption className="sr-only">
                Online agents first, then sorted by name within each group
              </caption>
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th
                    aria-sort="other"
                    className="px-3 py-3 font-medium"
                    scope="col"
                    title="Online agents first, then by name"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      Agent <ArrowUp aria-hidden="true" className="size-3" />
                    </span>
                  </th>
                  <th className="w-28 px-3 py-3 font-medium" scope="col">
                    Status
                  </th>
                  <th
                    className="w-40 px-3 py-3 font-medium max-xl:hidden"
                    scope="col"
                  >
                    Runtime
                  </th>
                  <th
                    className="w-28 px-3 py-3 text-right font-medium max-lg:hidden"
                    scope="col"
                  >
                    Capabilities
                  </th>
                  <th
                    className="w-40 px-3 py-3 font-medium max-lg:hidden"
                    scope="col"
                  >
                    Last heartbeat
                  </th>
                  <th className="w-24 px-3 py-3" scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visibleAgents.map((agent) => (
                  <AgentRow
                    agent={agent}
                    deleting={
                      deleteMutation.isPending &&
                      deleteMutation.variables === agent.id
                    }
                    key={agent.id}
                    onDelete={() => deleteMutation.mutateAsync(agent.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : !query.error ? (
          <div className="rounded-surface border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            {agents.length
              ? "No matching agents."
              : "No connected machines. Connect an agent to get started."}
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

export function AgentEnrollmentFlow({ onCancel }: { onCancel(): void }) {
  const [dockerSetup, setDockerSetup] = useState(false);
  const queryClient = useQueryClient();
  const [step, setStep] = useState<EnrollmentStep>("machine");
  const [machineName, setMachineName] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [installShell, setInstallShell] = useState<CommandShell>("bash");
  const [now, setNow] = useState(Date.now);
  const [config, setConfig] = useState<EnrollmentConfig>(
    defaultEnrollmentConfig,
  );
  const createEnrollment = useMutation({
    mutationFn: () =>
      apiSend<Enrollment>("POST", "/studio/agents/enrollments", {
        machineName: machineName.trim(),
      }),
    onSuccess: (result) => {
      setEnrollment(result);
      setStep("install");
      void queryClient.invalidateQueries({ queryKey: ["/studio/agents"] });
    },
  });
  const statusQuery = useQuery({
    enabled: Boolean(enrollment),
    queryKey: ["/studio/agents/enrollments", enrollment?.enrollmentId],
    queryFn: () => {
      if (!enrollment) throw new Error("Enrollment is not ready.");
      return apiGet<EnrollmentStatus>(
        `/studio/agents/enrollments/${encodeURIComponent(enrollment.enrollmentId)}`,
      );
    },
    refetchInterval: (status) => {
      if (!enrollment) return false;
      const current = status.state.data as EnrollmentStatus | undefined;
      const expired = Date.now() >= new Date(enrollment.expiresAt).getTime();
      return current?.agentStatus === "online" ||
        current?.status === "expired" ||
        expired
        ? false
        : 1_000;
    },
  });
  const enrollmentStatus = statusQuery.data;
  const enrollmentExpired = Boolean(
    enrollment &&
    (enrollmentStatus?.status === "expired" ||
      now >= new Date(enrollment.expiresAt).getTime()),
  );

  useEffect(() => {
    if (!enrollment) return;
    setNow(Date.now());
    const delay = Math.max(
      0,
      new Date(enrollment.expiresAt).getTime() - Date.now(),
    );
    const timeout = window.setTimeout(() => setNow(Date.now()), delay + 25);
    return () => window.clearTimeout(timeout);
  }, [enrollment]);

  useEffect(() => {
    if (
      enrollment &&
      (enrollmentExpired ||
        enrollmentStatus?.status === "consumed" ||
        enrollmentStatus?.agentStatus === "online")
    ) {
      setStep("connect");
    }
  }, [
    enrollment,
    enrollmentExpired,
    enrollmentStatus?.agentStatus,
    enrollmentStatus?.status,
  ]);

  if (dockerSetup)
    return (
      <DockerAgentSetup
        onBack={() => setDockerSetup(false)}
        onCancel={onCancel}
      />
    );

  return (
    <section className="grid min-h-[calc(100svh-56px)] grid-rows-[auto_1fr] lg:grid-cols-[220px_minmax(0,1fr)] lg:grid-rows-1 xl:h-[calc(100svh-56px)] xl:min-h-0 xl:grid-cols-[240px_minmax(0,1fr)] xl:overflow-hidden">
      <aside className="flex min-w-0 flex-col border-b bg-muted/20 lg:border-b-0 lg:border-r xl:min-h-0 xl:overflow-y-auto">
        <div className="border-b p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Server className="size-4 text-muted-foreground" /> Agent setup
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Connect your machine to Studio in four simple steps.
          </p>
          {!enrollment ? (
            <Button
              className="mt-3 h-auto whitespace-normal text-left"
              size="sm"
              variant="outline"
              onClick={() => setDockerSetup(true)}
            >
              Set up with Docker instead
            </Button>
          ) : null}
        </div>
        <nav className="p-2" aria-label="Agent setup steps">
          <Stepper
            current={step}
            orientation="vertical"
            steps={[
              {
                id: "machine",
                label: "Name your agent",
                hint: "Make it easy to recognize",
                enabled: !enrollment && !createEnrollment.isPending,
              },
              {
                id: "access",
                label: "Choose access",
                hint: "Set what it can do",
                enabled:
                  Boolean(machineName.trim()) &&
                  !createEnrollment.isPending &&
                  enrollmentStatus?.agentStatus !== "online" &&
                  enrollmentStatus?.status !== "consumed" &&
                  !enrollmentExpired,
              },
              {
                id: "install",
                label: "Run the command",
                hint: "On your machine",
                enabled:
                  Boolean(enrollment) &&
                  enrollmentStatus?.agentStatus !== "online" &&
                  enrollmentStatus?.status !== "consumed" &&
                  !enrollmentExpired,
              },
              {
                id: "connect",
                label: "Confirm connection",
                hint: "Ready to use",
                enabled: Boolean(enrollment),
              },
            ]}
            onStepChange={setStep}
          />
        </nav>
        <div className="mt-auto hidden border-t p-4 lg:block">
          <ShieldCheck className="mb-2 size-4 text-primary" />
          <p className="text-xs leading-5 text-muted-foreground">
            You choose what your Beam agent can access. The connection to Studio
            is encrypted.
          </p>
        </div>
      </aside>
      <div className="min-w-0 p-4 sm:p-6 xl:min-h-0 xl:overflow-y-auto">
        <div className="flex min-h-full flex-col gap-6">
          <PageSectionHeader className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                Connect your Beam agent
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Name your agent, choose its access, and connect your machine.
              </p>
            </div>
            <Button
              disabled={createEnrollment.isPending}
              onClick={onCancel}
              size="sm"
              variant="ghost"
            >
              All agents
            </Button>
          </PageSectionHeader>
          <div className="flex min-w-0 flex-1 flex-col [&>div]:flex-1 [&>form]:flex-1">
            {step === "machine" ? (
              <MachineStep
                machineName={machineName}
                onCancel={onCancel}
                onChange={setMachineName}
                onContinue={() => setStep("access")}
              />
            ) : null}

            {step === "access" ? (
              <AccessStep
                config={config}
                enrollmentExists={Boolean(enrollment)}
                error={createEnrollment.error}
                pending={createEnrollment.isPending}
                onBack={() => setStep(enrollment ? "install" : "machine")}
                onChange={setConfig}
                onContinue={() =>
                  enrollment ? setStep("install") : createEnrollment.mutate()
                }
              />
            ) : null}

            {step === "install" && enrollment ? (
              <InstallationStep
                config={config}
                enrollment={enrollment}
                machineName={machineName}
                shell={installShell}
                statusError={statusQuery.error}
                onContinue={() => {
                  setStep("connect");
                }}
                onEditAccess={() => setStep("access")}
                onRetryStatus={() => void statusQuery.refetch()}
                onShellChange={setInstallShell}
              />
            ) : null}

            {step === "connect" && enrollment ? (
              <ConnectionStep
                creationError={createEnrollment.error}
                expired={enrollmentExpired}
                machineName={machineName}
                pending={createEnrollment.isPending}
                studioURL={config.studioURL}
                status={enrollmentStatus}
                statusError={statusQuery.error}
                onBack={() => setStep("install")}
                onRenew={() => createEnrollment.mutate()}
                onRetryStatus={() => void statusQuery.refetch()}
              />
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function MachineStep({
  machineName,
  onCancel,
  onChange,
  onContinue,
}: {
  machineName: string;
  onCancel(): void;
  onChange(value: string): void;
  onContinue(): void;
}) {
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (machineName.trim()) onContinue();
      }}
    >
      <div className="grid gap-1">
        <h2 className="text-base font-semibold">Give your agent a name</h2>
        <p className="text-sm text-muted-foreground">
          Choose a name you’ll recognize when switching between machines.
        </p>
      </div>
      <label className="grid gap-2 text-sm font-medium">
        Agent name
        <input
          autoFocus
          autoComplete="off"
          className={cn(inputClassName, "w-full")}
          maxLength={160}
          onChange={(event) => onChange(event.target.value)}
          placeholder="e.g. My MacBook or Paris server"
          required
          value={machineName}
        />
        <span className="text-xs font-normal text-muted-foreground">
          This is how your machine will appear in Studio.
        </span>
      </label>
      <div className="flex items-start gap-3 rounded-control bg-muted/40 p-4">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-sm text-muted-foreground">
          Next, you’ll choose what your Beam agent can access. You’ll need a
          terminal on the machine you want to connect.
        </p>
      </div>
      <div className="mt-auto flex flex-wrap justify-between gap-2 border-t pt-4">
        <Button onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={!machineName.trim()} type="submit">
          Choose access <ArrowRight className="size-4" />
        </Button>
      </div>
    </form>
  );
}

function AccessStep({
  config,
  enrollmentExists,
  error,
  pending,
  onBack,
  onChange,
  onContinue,
}: {
  config: EnrollmentConfig;
  enrollmentExists: boolean;
  error: unknown;
  pending: boolean;
  onBack(): void;
  onChange(config: EnrollmentConfig): void;
  onContinue(): void;
}) {
  const validation = validateEnrollmentConfig(config);
  function selectProfile(profile: EnrollmentProfile) {
    onChange({
      ...config,
      profile,
      permissions: permissionsForProfile(profile, config.permissions),
    });
  }
  function toggle(permission: keyof EnrollmentPermissions) {
    onChange({
      ...config,
      profile: "custom",
      permissions: {
        ...config.permissions,
        [permission]: !config.permissions[permission],
      },
    });
  }
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold">
          What will you use your agent for?
        </h2>
        <p className="text-sm text-muted-foreground">
          Choose a starting point. You can adjust individual permissions before
          connecting.
        </p>
      </div>
      {studioEnv.tunnelsEnabled ? (
        <div className="grid gap-3 xl:grid-cols-3">
          <ProfileCard
            active={config.profile === "http"}
            description="Connect to web services on your machine."
            label="Web services"
            onClick={() => selectProfile("http")}
          />
          <ProfileCard
            active={config.profile === "files"}
            description="Send and receive files in a folder you choose."
            label="File transfer"
            onClick={() => selectProfile("files")}
          />
          <ProfileCard
            active={config.profile === "full"}
            description="Work with files, services and rooms."
            label="Full control"
            onClick={() => selectProfile("full")}
          />
        </div>
      ) : null}
      <div className="grid gap-4 rounded-surface border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Access on your machine</h3>
            {studioEnv.tunnelsEnabled ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {config.permissions.publicTunnels
                  ? "Public access is enabled for allowed services."
                  : "Public access is off."}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {config.profile === "custom" ? (
              <Badge variant="secondary">Custom</Badge>
            ) : null}
            <Dialog>
              <DialogTrigger asChild>
                <Button disabled={pending} size="sm" variant="outline">
                  Customize permissions
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto rounded-surface">
                <DialogHeader>
                  <DialogTitle>Customize permissions</DialogTitle>
                  <DialogDescription>
                    Choose exactly what your Beam agent can access on this
                    machine.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid min-w-0 gap-4">
                  <section className="grid min-w-0 content-start gap-2 rounded-surface border p-3">
                    <div className="mb-1">
                      <p className="text-sm font-medium">
                        Machine capabilities
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {studioEnv.tunnelsEnabled
                          ? "Files, shared rooms, and public access."
                          : "Files and shared rooms."}
                      </p>
                    </div>
                    <PermissionSwitch
                      checked={config.permissions.file}
                      description="Read and write inside the folder you choose."
                      label="File access"
                      onChange={() => toggle("file")}
                    />
                    <PermissionSwitch
                      checked={config.permissions.rooms}
                      description="Create and manage shared rooms."
                      label="Room control"
                      onChange={() => toggle("rooms")}
                    />
                    {studioEnv.tunnelsEnabled ? (
                      <PermissionSwitch
                        checked={config.permissions.publicTunnels}
                        description="Make allowed services publicly accessible."
                        label="Public tunnels"
                        onChange={() => toggle("publicTunnels")}
                      />
                    ) : null}
                  </section>
                  {studioEnv.tunnelsEnabled ? (
                    <section className="grid min-w-0 content-start gap-2 rounded-surface border p-3">
                      <div className="mb-1">
                        <p className="text-sm font-medium">Tunnel kinds</p>
                        <p className="text-xs text-muted-foreground">
                          Choose the services your agent can connect to.
                        </p>
                      </div>
                      <PermissionSwitch
                        checked={config.permissions.http}
                        description="Reach an allowed local HTTP service."
                        label="HTTP tunnels"
                        onChange={() => toggle("http")}
                      />
                      <PermissionSwitch
                        checked={config.permissions.stream}
                        description="Reach an allowed local streaming service."
                        label="Stream tunnels"
                        onChange={() => toggle("stream")}
                      />
                      <PermissionSwitch
                        checked={config.permissions.webrtc}
                        description="Reach an allowed local WebRTC service."
                        label="WebRTC tunnels"
                        onChange={() => toggle("webrtc")}
                      />
                      <PermissionSwitch
                        checked={config.permissions.tcp}
                        description="Reach an allowed local TCP service."
                        label="TCP tunnels"
                        onChange={() => toggle("tcp")}
                      />
                    </section>
                  ) : null}
                </div>

                <div className="flex justify-end border-t pt-4">
                  <DialogClose asChild>
                    <Button type="button">Done</Button>
                  </DialogClose>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        {config.permissions.file ? (
          <label className="grid gap-2 text-sm font-medium">
            Shared folder
            <input
              className={cn(inputClassName, "min-w-0 w-full font-mono text-sm")}
              onChange={(event) =>
                onChange({ ...config, fileRoot: event.target.value })
              }
              placeholder="/absolute/path/to/share"
              spellCheck={false}
              value={config.fileRoot}
            />
            <span className="text-xs font-normal text-muted-foreground">
              Your agent can access this folder and its contents. Use the full
              path on the machine you’re connecting.
            </span>
          </label>
        ) : null}
        {hasNetworkPermission(config.permissions) ? (
          <label className="grid gap-2 text-sm font-medium">
            Allowed hosts
            <input
              className={cn(inputClassName, "min-w-0 w-full font-mono text-sm")}
              onChange={(event) =>
                onChange({ ...config, networkTargets: event.target.value })
              }
              spellCheck={false}
              value={config.networkTargets}
            />
            <span className="text-xs font-normal text-muted-foreground">
              Keep 127.0.0.1 for services on this machine, or add hosts
              separated by commas.
            </span>
          </label>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Studio can restrict these permissions later. Adding more access
          requires a change on the machine.
        </p>
        <Dialog>
          <DialogTrigger asChild>
            <Button disabled={pending} size="sm" variant="ghost">
              Connection settings
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto rounded-surface">
            <DialogHeader>
              <DialogTitle>Connection settings</DialogTitle>
              <DialogDescription>
                Change this only if your Beam agent needs a different address to
                reach Studio.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-2 text-sm font-medium">
              Studio connection URL
              <input
                className={cn(
                  inputClassName,
                  "min-w-0 w-full font-mono text-sm",
                )}
                onChange={(event) =>
                  onChange({ ...config, studioURL: event.target.value })
                }
                spellCheck={false}
                value={config.studioURL}
              />
              <span className="text-xs font-normal text-muted-foreground">
                Use HTTPS unless Studio is running on localhost.
              </span>
            </label>
            <div className="flex justify-end border-t pt-4">
              <DialogClose asChild>
                <Button type="button">Done</Button>
              </DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      {validation ? (
        <p
          className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          {validation}
        </p>
      ) : null}
      {error ? <ErrorBlock error={error} /> : null}
      <div className="mt-auto flex flex-wrap justify-between gap-2 border-t pt-4">
        <Button
          disabled={pending}
          onClick={onBack}
          type="button"
          variant="ghost"
        >
          Back
        </Button>
        <Button
          disabled={Boolean(validation) || pending}
          onClick={onContinue}
          type="button"
        >
          {pending
            ? "Preparing your command…"
            : enrollmentExists
              ? "Update command"
              : "Get connection command"}
          {!pending ? (
            <ArrowRight className="size-4" />
          ) : (
            <LoaderCircle className="size-4 animate-spin" />
          )}
        </Button>
      </div>
    </div>
  );
}

function ProfileCard({
  active,
  description,
  label,
  onClick,
}: {
  active: boolean;
  description: string;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "min-w-0 rounded-control border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "border-primary bg-primary/5 ring-1 ring-primary",
      )}
      onClick={onClick}
      type="button"
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {active ? (
          <CheckCircle2 className="size-4 text-primary" />
        ) : (
          <span className="size-4 rounded-full border" />
        )}
        {label}
      </span>
      <span className="mt-1 block text-xs text-muted-foreground">
        {description}
      </span>
    </button>
  );
}

function InstallationStep({
  config,
  enrollment,
  machineName,
  shell,
  statusError,
  onContinue,
  onEditAccess,
  onRetryStatus,
  onShellChange,
}: {
  config: EnrollmentConfig;
  enrollment: Enrollment;
  machineName: string;
  shell: CommandShell;
  statusError: unknown;
  onContinue(): void;
  onEditAccess(): void;
  onRetryStatus(): void;
  onShellChange(shell: CommandShell): void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const command = buildEnrollmentCommand(
    { ...config, code: enrollment.code, machineName },
    shell,
  );

  useEffect(() => setCopyState("idle"), [command]);

  async function copyCommand() {
    try {
      await copyText(command);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1_500);
    } catch {
      setCopyState("error");
    }
  }

  return (
    <div className="flex min-h-full flex-col gap-5">
      <div className="rounded-control border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
        {`This command includes a private, one-time connection code. It expires ${formatRelative(enrollment.expiresAt)}.`}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Connect from your machine</h2>
          <p className="text-sm text-muted-foreground">
            Open a terminal on the machine you named, then paste and run the
            command below.
          </p>
        </div>
        <div className="flex rounded-control border bg-muted/30 p-1">
          <ShellButton
            active={shell === "bash"}
            label="macOS / Linux"
            onClick={() => onShellChange("bash")}
          />
          <ShellButton
            active={shell === "powershell"}
            label="PowerShell"
            onClick={() => onShellChange("powershell")}
          />
        </div>
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <Button className="self-start" variant="outline" type="button">
            First time? Install Beam
          </Button>
        </DialogTrigger>
        <DialogContent className="rounded-surface">
          <DialogHeader>
            <DialogTitle>Install your Beam agent</DialogTitle>
            <DialogDescription>
              The official installer includes the Beam CLI and its matching
              agent. Run this on the machine you want to connect.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            {shell === "powershell"
              ? "In PowerShell:"
              : "In a macOS or Linux terminal:"}
          </p>
          <code className="block whitespace-pre-wrap break-all rounded-control bg-muted p-3 text-sm">
            {shell === "powershell"
              ? "irm https://cdn.b1m.ai/cli/install.ps1 | iex"
              : "curl -fsSL https://cdn.b1m.ai/cli/install.sh | sh"}
          </code>
          <AgentCopyButton
            label="installation command"
            value={
              shell === "powershell"
                ? "irm https://cdn.b1m.ai/cli/install.ps1 | iex"
                : "curl -fsSL https://cdn.b1m.ai/cli/install.sh | sh"
            }
          />
          <p className="text-sm text-muted-foreground">
            If the installer opens setup, choose to configure later. Check{" "}
            <code>beam --version</code>, then run the connection command on this
            page. If your code expires, renew it from the connection step.
          </p>
          <DialogClose asChild>
            <Button type="button">Ready to connect</Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
      <div className="min-w-0 overflow-hidden rounded-surface border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate" title={machineName}>
              {machineName}
            </span>
          </p>
          <Button
            onClick={copyCommand}
            size="sm"
            type="button"
            variant="secondary"
          >
            {copyState === "copied" ? (
              <CheckCircle2 className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
            {copyState === "copied" ? "Command copied" : "Copy command"}
          </Button>
        </div>
        <code className="block whitespace-pre-wrap break-all bg-muted/20 p-4 font-mono text-sm leading-6">
          {command}
        </code>
      </div>
      {copyState === "error" ? (
        <p className="text-xs text-destructive">
          Clipboard access was blocked. Select and copy the command manually.
        </p>
      ) : null}
      {statusError ? (
        <StatusError error={statusError} onRetry={onRetryStatus} />
      ) : null}
      <div className="mt-auto flex justify-between gap-2 border-t pt-4">
        <Button onClick={onEditAccess} type="button" variant="ghost">
          Edit access
        </Button>
        <Button onClick={onContinue} type="button">
          I ran the command <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function ShellButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "rounded-control-compact px-2.5 py-1 text-xs font-medium",
        active ? "bg-background shadow-sm" : "text-muted-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function ConnectionStep({
  creationError,
  expired,
  machineName,
  pending,
  status,
  statusError,
  studioURL,
  onBack,
  onRenew,
  onRetryStatus,
}: {
  creationError: unknown;
  expired: boolean;
  machineName: string;
  pending: boolean;
  status?: EnrollmentStatus;
  statusError: unknown;
  studioURL: string;
  onBack(): void;
  onRenew(): void;
  onRetryStatus(): void;
}) {
  const [diagnosticsReady, setDiagnosticsReady] = useState(false);
  const online = status?.agentStatus === "online" && Boolean(status.agentId);
  const consumed = status?.status === "consumed";
  const consumedAt = status?.consumedAt
    ? new Date(status.consumedAt).getTime()
    : NaN;

  useEffect(() => {
    if (!consumed || !Number.isFinite(consumedAt)) {
      setDiagnosticsReady(false);
      return;
    }
    const delay = Math.max(0, consumedAt + 15_000 - Date.now());
    const timeout = window.setTimeout(() => setDiagnosticsReady(true), delay);
    return () => window.clearTimeout(timeout);
  }, [consumed, consumedAt]);

  if (online && status?.agentId) {
    return (
      <div className="grid min-h-full content-center justify-items-center gap-4 py-5 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-success/10 text-success">
          <CheckCircle2 className="size-6" />
        </span>
        <div className="grid gap-1">
          <h2 className="text-xl font-semibold">Agent connected</h2>
          <p className="text-sm text-muted-foreground">
            Your Beam agent on {machineName} is online and ready to use.
          </p>
        </div>
        <Button asChild>
          <Link params={{ id: status.agentId }} to="/agents/$id">
            Open agent <ExternalLink className="size-4" />
          </Link>
        </Button>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="grid min-h-full content-center justify-items-center gap-4 py-5 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-amber-500/10 text-warning">
          <AlertTriangle className="size-6" />
        </span>
        <div className="grid gap-1">
          <h2 className="text-xl font-semibold">Connection code expired</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Create a fresh one-time code without losing the machine name or
            access settings.
          </p>
        </div>
        {creationError ? <ErrorBlock error={creationError} /> : null}
        <Button disabled={pending} onClick={onRenew} type="button">
          <RefreshCw className={cn("size-4", pending && "animate-spin")} />
          {pending ? "Renewing…" : "Renew code"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-5">
      <div className="grid justify-items-center gap-3 py-2 text-center">
        <LoaderCircle className="size-8 animate-spin text-primary" />
        <div className="grid gap-1">
          <h2 className="text-xl font-semibold">
            {consumed
              ? "Securing the connection"
              : "Waiting for your Beam agent"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {consumed
              ? `Your code was accepted. ${machineName} is securely connecting to Studio…`
              : "Run the command on your machine. This page will update automatically when your agent connects."}
          </p>
        </div>
      </div>
      <div className="overflow-hidden rounded-control border">
        <ConnectionCheck complete={consumed} label="One-time code accepted" />
        <ConnectionCheck complete={consumed} label="Your agent is registered" />
        <ConnectionCheck
          complete={false}
          label="Secure connection to Studio"
          pending={consumed}
        />
      </div>
      {diagnosticsReady ? <Troubleshooting studioURL={studioURL} /> : null}
      {statusError ? (
        <StatusError error={statusError} onRetry={onRetryStatus} />
      ) : null}
      <div className="mt-auto flex justify-between gap-2 border-t pt-4">
        <Button
          disabled={consumed}
          onClick={onBack}
          type="button"
          variant="ghost"
        >
          Back to command
        </Button>
        <Button onClick={onRetryStatus} type="button" variant="outline">
          <RefreshCw className="size-4" />
          Check again
        </Button>
      </div>
    </div>
  );
}

function ConnectionCheck({
  complete,
  label,
  pending = false,
}: {
  complete: boolean;
  label: string;
  pending?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
      {complete ? (
        <CheckCircle2 className="size-5 text-success" />
      ) : pending ? (
        <LoaderCircle className="size-5 animate-spin text-primary" />
      ) : (
        <span className="ml-0.5 size-4 rounded-full border" />
      )}
      <span
        className={cn(
          "text-sm",
          !complete && !pending && "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </div>
  );
}

function Troubleshooting({ studioURL }: { studioURL: string }) {
  return (
    <div className="rounded-control border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
        <div>
          <p className="font-medium">
            The secure connection is taking longer than expected
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
            <li>
              Keep your Beam agent running and check the terminal for errors.
            </li>
            <li>
              Make sure your machine can reach {studioURL} over HTTPS and
              WebSocket connections.
            </li>
            <li>Check that your machine’s date and time are correct.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function StatusError({ error, onRetry }: { error: unknown; onRetry(): void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <div>
        <p className="font-medium">Connection status unavailable</p>
        <p className="mt-0.5 text-xs opacity-90">{friendlyError(error)}</p>
      </div>
      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        Retry
      </Button>
    </div>
  );
}

function PermissionSwitch({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-control px-1 py-1.5">
      <button
        aria-checked={checked}
        aria-label={label}
        className={cn(
          "relative h-6 w-10 shrink-0 rounded-full bg-input transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          checked && "bg-primary",
        )}
        onClick={onChange}
        role="switch"
        type="button"
      >
        <span
          className={cn(
            "absolute left-1 top-1 size-4 rounded-full bg-background shadow-sm transition-transform",
            checked && "translate-x-4",
          )}
        />
      </button>
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function buildEnrollmentCommand(
  input: {
    code: string;
    fileRoot: string;
    machineName: string;
    networkTargets: string;
    permissions: EnrollmentPermissions;
    studioURL: string;
  },
  shell: CommandShell,
) {
  if (shell === "container") {
    return [
      "docker run -d --name beam-studio-consumer --restart unless-stopped",
      "-v beam-studio-consumer:/var/lib/beam",
      `-e BEAM_STUDIO_URL=${shellQuote(input.studioURL.trim())}`,
      '-e BEAM_STUDIO_SHARED_SECRET="${BEAM_STUDIO_SHARED_SECRET:?set BEAM_STUDIO_SHARED_SECRET}"',
      `-e BEAM_STUDIO_MACHINE_NAME=${shellQuote(input.machineName)}`,
      '"${BEAM_STUDIO_CONSUMER_IMAGE:?set BEAM_STUDIO_CONSUMER_IMAGE}"',
    ].join(" ");
  }
  const quote = shell === "powershell" ? powershellQuote : shellQuote;
  const tokens = [
    "beam",
    "studio",
    "connect",
    quote(input.studioURL.trim()),
    "--code",
    quote(input.code),
    "--name",
    quote(input.machineName),
  ];
  for (const kind of ["file", "http", "stream", "webrtc", "tcp"] as const)
    if (input.permissions[kind]) tokens.push("--allow-kind", kind);
  if (input.permissions.file && input.fileRoot.trim())
    tokens.push("--allow-root", quote(input.fileRoot.trim()));
  if (hasNetworkPermission(input.permissions)) {
    for (const target of networkTargets(input.networkTargets))
      tokens.push("--allow-target", quote(target));
  }
  if (input.permissions.publicTunnels) tokens.push("--allow-public");
  tokens.push(`--rooms=${input.permissions.rooms}`);
  return tokens.join(" ");
}

function DockerAgentSetup({
  onBack,
  onCancel,
}: {
  onBack(): void;
  onCancel(): void;
}) {
  const [machineName, setMachineName] = useState("Studio room consumer");
  const [studioURL, setStudioURL] = useState(
    defaultEnrollmentConfig().studioURL,
  );
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(machineName);
  const [draftURL, setDraftURL] = useState(studioURL);
  const command = buildEnrollmentCommand(
    { ...defaultEnrollmentConfig(), machineName, studioURL, code: "" },
    "container",
  );
  return (
    <section className="grid min-h-[calc(100svh-56px)] lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="border-b bg-muted/20 p-4 lg:border-b-0 lg:border-r">
        <h2 className="text-sm font-semibold">Docker setup</h2>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          For teams deploying a managed Room agent. This setup uses your
          administrator’s image and shared secret, not a one-time connection
          code.
        </p>
        <Button onClick={onBack} variant="outline" size="sm" className="mt-4">
          Use terminal setup
        </Button>
      </aside>
      <div className="grid min-w-0 content-start gap-5 p-4 sm:p-6 xl:max-h-[calc(100svh-56px)] xl:overflow-auto">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Connect with Docker</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Prepare your runtime, configure the container, then check its
              connection.
            </p>
          </div>
          <Button onClick={onCancel} variant="ghost" size="sm">
            All agents
          </Button>
        </header>
        <section className="rounded-surface border p-4">
          <h2 className="font-medium">1. Prepare the runtime</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Install Docker and ask your administrator for the approved Beam
            container image and Studio bootstrap shared secret. Set{" "}
            <code>BEAM_STUDIO_CONSUMER_IMAGE</code> and{" "}
            <code>BEAM_STUDIO_SHARED_SECRET</code> in your terminal or secret
            manager. Never commit the secret to a file in your repository.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            The container configures its own permissions. Terminal access
            profiles do not apply to this deployment.
          </p>
        </section>
        <section className="min-w-0 overflow-hidden rounded-surface border">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
            <div>
              <h2 className="font-medium">2. Start your Beam agent</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Run in a macOS or Linux shell. The command requires both
                environment variables.
              </p>
            </div>
            <Dialog
              open={open}
              onOpenChange={(next) => {
                setOpen(next);
                if (next) {
                  setDraftName(machineName);
                  setDraftURL(studioURL);
                }
              }}
            >
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  Configure deployment
                </Button>
              </DialogTrigger>
              <DialogContent className="rounded-surface">
                <DialogHeader>
                  <DialogTitle>Docker deployment</DialogTitle>
                  <DialogDescription>
                    Configure the identity and Studio URL. Your shared secret
                    stays outside this page.
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!draftName.trim() || studioURLError(draftURL.trim()))
                      return;
                    setMachineName(draftName.trim());
                    setStudioURL(draftURL.trim());
                    setOpen(false);
                  }}
                >
                  <label className="grid gap-2 text-sm">
                    Agent name
                    <input
                      className="h-10 rounded-control border bg-background px-3"
                      required
                      maxLength={160}
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                    />
                  </label>
                  {studioURLError(draftURL.trim()) ? (
                    <p className="text-sm text-destructive" role="alert">
                      {studioURLError(draftURL.trim())}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Use an address reachable from the container. Inside Docker,
                    localhost refers to the container itself.
                  </p>
                  <label className="grid gap-2 text-sm">
                    Studio URL
                    <input
                      className="h-10 rounded-control border bg-background px-3"
                      required
                      type="url"
                      value={draftURL}
                      onChange={(event) => setDraftURL(event.target.value)}
                    />
                  </label>
                  <div className="flex justify-end gap-2">
                    <DialogClose asChild>
                      <Button type="button" variant="ghost">
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button
                      disabled={
                        !draftName.trim() ||
                        Boolean(studioURLError(draftURL.trim()))
                      }
                      type="submit"
                    >
                      Save configuration
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
            <AgentCopyButton label="Docker command" value={command} />
          </div>
          <code className="block whitespace-pre-wrap break-all bg-muted/20 p-4 text-sm leading-6">
            {command}
          </code>
        </section>
        <section className="rounded-surface border p-4">
          <h2 className="font-medium">3. Check the connection</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Open All agents and look for “{machineName}”. If it does not appear,
            inspect <code>docker logs beam-studio-consumer</code> and verify the
            Studio URL, image and secret. There is no enrollment code to renew
            for this setup.
          </p>
          <Button onClick={onCancel} className="mt-4">
            View agents <ArrowRight className="size-4" />
          </Button>
        </section>
      </div>
    </section>
  );
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function powershellQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
function defaultEnrollmentConfig(): EnrollmentConfig {
  return {
    studioURL: defaultAgentControlURL(),
    fileRoot: "",
    networkTargets: "127.0.0.1",
    permissions: permissionsForProfile(defaultEnrollmentProfile()),
    profile: defaultEnrollmentProfile(),
  };
}
function defaultEnrollmentProfile(): EnrollmentProfile {
  return studioEnv.tunnelsEnabled ? "http" : "rooms";
}
function permissionsForProfile(
  profile: EnrollmentProfile,
  current?: EnrollmentPermissions,
): EnrollmentPermissions {
  if (profile === "custom" && current) return current;
  if (profile === "rooms")
    return {
      publicTunnels: false,
      file: false,
      http: false,
      stream: false,
      webrtc: false,
      tcp: false,
      rooms: true,
    };
  if (profile === "files")
    return {
      publicTunnels: false,
      file: true,
      http: false,
      stream: false,
      webrtc: false,
      tcp: false,
      rooms: false,
    };
  if (profile === "full")
    return {
      publicTunnels: false,
      file: true,
      http: true,
      stream: true,
      webrtc: true,
      tcp: true,
      rooms: true,
    };
  return {
    publicTunnels: false,
    file: false,
    http: true,
    stream: false,
    webrtc: false,
    tcp: false,
    rooms: false,
  };
}
function validateEnrollmentConfig(config: EnrollmentConfig) {
  if (config.permissions.file && !isAbsolutePath(config.fileRoot.trim()))
    return "File access requires an absolute filesystem path.";
  if (
    hasNetworkPermission(config.permissions) &&
    networkTargets(config.networkTargets).length === 0
  )
    return "Add at least one allowed host for network tunnels.";
  if (!hasAgentCapability(config.permissions))
    return "Enable at least one agent capability.";
  return studioURLError(config.studioURL);
}
function hasAgentCapability(permissions: EnrollmentPermissions) {
  return (
    permissions.rooms ||
    (["file", "http", "stream", "webrtc", "tcp"] as const).some(
      (kind) => permissions[kind],
    )
  );
}
function hasNetworkPermission(permissions: EnrollmentPermissions) {
  return (
    permissions.http ||
    permissions.stream ||
    permissions.webrtc ||
    permissions.tcp
  );
}
function networkTargets(value: string) {
  return value
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
}
function defaultAgentControlURL() {
  const configured = studioEnv.apiUrl.trim();
  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/$/, "");
  return typeof window === "undefined"
    ? "https://studio.example"
    : window.location.origin;
}
function studioURLError(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "Enter a valid HTTP or HTTPS Studio API URL.";
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname))
      return "Use HTTPS for every Studio API URL outside localhost.";
    return null;
  } catch {
    return "Enter a valid Studio API URL.";
  }
}
function isAbsolutePath(value: string) {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  );
}
function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "host.docker.internal" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    /* Fall through for HTTP development origins. */
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard unavailable");
}

function AgentRow({
  agent,
  deleting,
  onDelete,
}: {
  agent: AgentRecord;
  deleting: boolean;
  onDelete(): Promise<unknown>;
}) {
  const online = agent.status === "online";
  const revoked = agent.status === "revoked";
  const name = agent.name || agent.machineName || agent.id;
  const runtime =
    [agent.platform, agent.architecture].filter(Boolean).join(" / ") ||
    "Unknown";
  const heartbeat = agent.heartbeatAt || agent.lastSeenAt;
  return (
    <tr className="h-14 transition-colors hover:bg-secondary/60 focus-within:bg-secondary/60">
      <td className="px-3 py-3">
        <Link
          className="flex min-w-0 items-center gap-3 rounded-control-compact outline-none focus-visible:ring-2 focus-visible:ring-ring"
          params={{ id: agent.id }}
          to="/agents/$id"
        >
          <Server
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground max-sm:hidden"
          />
          <div className="min-w-0">
            <div className="truncate font-medium" title={name}>
              {name}
            </div>
            <div
              className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
              title={agent.id}
            >
              {agent.id}
            </div>
            <div
              className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
              title={agent.daemonVersion || "Unknown"}
            >
              <span className="font-sans">Daemon </span>
              {agent.daemonVersion || "Unknown"}
            </div>
          </div>
        </Link>
      </td>
      <td className="px-3 py-3">
        <span className="flex min-w-0 items-center gap-2" title={agent.status}>
          <Circle
            aria-hidden="true"
            className={cn(
              "size-2.5 shrink-0 fill-current",
              online
                ? "text-success"
                : revoked || agent.status === "offline"
                  ? "text-muted-foreground"
                  : "text-warning",
            )}
          />
          <span className="truncate capitalize">{agent.status}</span>
        </span>
      </td>
      <td className="px-3 py-3 max-xl:hidden">
        <div className="truncate text-muted-foreground" title={runtime}>
          {runtime}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {agent.workerId ? "Worker + agent" : "Standalone agent"}
        </div>
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground max-lg:hidden">
        {agent.capabilities?.length ?? 0}
      </td>
      <td className="px-3 py-3 max-lg:hidden">
        <div
          className="truncate text-muted-foreground"
          title={heartbeat || "Never"}
        >
          {formatRelative(heartbeat)}
        </div>
      </td>
      <td className="px-3 py-3 text-right">
        <AgentCopyButton value={agent.id} />
        {revoked ? (
          <ConfirmationDialog
            confirmLabel="Delete agent"
            description={`This permanently deletes ${agent.name || agent.machineName || agent.id}, including its command and event history. This action cannot be undone.`}
            onConfirm={onDelete}
            title="Delete revoked agent?"
            trigger={
              <Button
                aria-label={`Delete ${name}`}
                className="size-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={deleting}
                size="icon"
                type="button"
                variant="ghost"
              >
                {deleting ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
              </Button>
            }
          />
        ) : (
          <Button asChild className="size-8" size="icon" variant="ghost">
            <Link
              aria-label={`Open ${name}`}
              params={{ id: agent.id }}
              to="/agents/$id"
            >
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        )}
      </td>
    </tr>
  );
}

function ErrorBlock({ error }: { error: unknown }) {
  return (
    <div className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      {friendlyError(error)}
    </div>
  );
}

function friendlyError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.statusCode === 401 || error.statusCode === 403)
      return "Your Studio session can no longer create or inspect enrollments. Sign in again and retry.";
    if (error.statusCode >= 500)
      return "The Studio API could not complete the request. Retry in a moment.";
    return error.action || error.message;
  }
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

export function formatRelative(value?: string | null) {
  if (!value) return "Never";
  const milliseconds = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(milliseconds)) return "Unknown";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const absolute = Math.abs(milliseconds);
  if (absolute < 60_000)
    return formatter.format(Math.round(milliseconds / 1_000), "second");
  if (absolute < 3_600_000)
    return formatter.format(Math.round(milliseconds / 60_000), "minute");
  if (absolute < 86_400_000)
    return formatter.format(Math.round(milliseconds / 3_600_000), "hour");
  return formatter.format(Math.round(milliseconds / 86_400_000), "day");
}
