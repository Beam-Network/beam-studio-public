import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Circle,
  Cpu,
  Gauge,
  MemoryStick,
  MoreHorizontal,
  Network,
  Search,
  Server,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Skeleton } from "@/components/data-page";
import { PageSectionHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api-client";
import { formatBytes } from "@/lib/format-bytes";
import { cn } from "@/lib/utils";

type OrchestrationData = {
  orchestrators?: OrchestratorRecord[];
  workers?: WorkerRecord[];
};

export type OrchestratorRecord = {
  id: string;
  name?: string;
  endpoint?: string;
  status?: string;
  service?: string;
  health?: string;
  readiness?: string;
  load?: {
    activeWorkerCount?: number;
    activeTaskCount?: number;
    averageLoadScore?: number;
  } | null;
};

export type WorkerRecord = {
  id: string;
  hostname?: string;
  pid?: number;
  status?: string;
  source?: "legacy" | "runtime";
  startedAt?: string | null;
  heartbeatAt?: string;
  stoppedAt?: string | null;
  networkIdentity?: string;
  reachability?: string;
  accessibleEndpoints?: string[];
  capabilities?: string[];
  cpuLoad?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  bandwidthMbps?: number;
  activeTaskCount?: number;
  loadScore?: number;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export const Route: any = createFileRoute("/orchestration")({
  component: OrchestrationRoute,
});

function OrchestrationRoute() {
  const location = useLocation();
  if (location.pathname !== "/orchestration") {
    return <Outlet />;
  }

  return <OrchestrationOverviewPage />;
}

export function useOrchestrationData() {
  const query = useQuery({
    queryKey: ["/studio/workers"],
    queryFn: () => apiGet<OrchestrationData>("/studio/workers"),
    refetchInterval: 5_000,
  });

  return {
    ...query,
    orchestrators: query.data?.orchestrators ?? [],
    workers: query.data?.workers ?? [],
  };
}

function OrchestrationOverviewPage() {
  const { orchestrators, workers, isPending, error } = useOrchestrationData();
  const activeWorkers = workers.filter((w) => w.status === "active");
  const staleWorkers = workers.filter((w) => w.status === "stale");
  const activeTaskCount = workers.reduce((s, w) => s + (w.activeTaskCount ?? 0), 0);
  const totalMemory = workers.reduce((s, w) => s + (w.memoryTotalBytes ?? 0), 0);
  const usedMemory = workers.reduce((s, w) => s + (w.memoryUsedBytes ?? 0), 0);
  const averageLoad = workers.length
    ? workers.reduce((s, w) => s + (w.loadScore ?? 0), 0) / workers.length
    : 0;

  return (
    <AppShell contentClassName="px-3 py-4">
      <div className="mx-auto grid w-full max-w-5xl gap-4">
        <OrchestrationHeader
          activeCount={activeWorkers.length}
          orchestratorCount={orchestrators.length}
          workerCount={workers.length}
        />
        {error ? <ErrorBlock error={error} /> : null}
        <div className="overflow-hidden rounded-surface border bg-card">
          <dl className="grid sm:grid-cols-2 lg:grid-cols-4">
            <StatCell
              hint="registered"
              label="Orchestrators"
              tone={orchestrators.length ? "success" : undefined}
              value={isPending ? "—" : String(orchestrators.length)}
            />
            <StatCell
              hint="of total"
              label="Active workers"
              tone={activeWorkers.length ? "success" : undefined}
              value={isPending ? "—" : String(activeWorkers.length)}
            />
            <StatCell
              hint="heartbeat stale"
              label="Stale workers"
              tone={staleWorkers.length ? "warning" : undefined}
              value={isPending ? "—" : String(staleWorkers.length)}
            />
            <StatCell
              hint="running now"
              label="Active tasks"
              value={isPending ? "—" : String(activeTaskCount)}
            />
          </dl>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Worker load">
            <MetricRow icon={Gauge} label="Average load" value={formatLoad(averageLoad)} />
            <MetricRow
              icon={MemoryStick}
              label="Memory"
              value={totalMemory ? `${Math.round((usedMemory / totalMemory) * 100)}% used` : "n/a"}
            />
            <MetricRow
              icon={Cpu}
              label="Capabilities"
              value={distinct(workers.flatMap((w) => w.capabilities ?? [])).length}
            />
          </Panel>
          <Panel title="Runtime topology">
            <MetricRow
              icon={Server}
              label="Runtime workers"
              value={workers.filter((w) => w.source === "runtime").length}
            />
            <MetricRow
              icon={Server}
              label="Legacy workers"
              value={workers.filter((w) => w.source === "legacy").length}
            />
            <MetricRow
              icon={Network}
              label="Reachable endpoints"
              value={distinct(workers.flatMap((w) => w.accessibleEndpoints ?? [])).length}
            />
          </Panel>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            action={
              orchestrators.length > 5 ? (
                <Button asChild size="sm" type="button" variant="outline">
                  <Link to="/orchestration/orchestrators">View all</Link>
                </Button>
              ) : undefined
            }
            title="Orchestrators"
          >
            {orchestrators.length ? (
              <div className="overflow-hidden rounded-control border">
                <div className="divide-y">
                  {orchestrators.slice(0, 5).map((o) => (
                    <Link
                      className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-secondary/60"
                      key={o.id}
                      to={`/orchestration/orchestrators/${encodeURIComponent(o.id)}` as never}
                    >
                      <StatusCell status={o.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {o.name || o.id}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {o.readiness ?? "unknown"}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No orchestrators found.</p>
            )}
          </Panel>
          <Panel
            action={
              workers.length > 5 ? (
                <Button asChild size="sm" type="button" variant="outline">
                  <Link to="/orchestration/workers">View all</Link>
                </Button>
              ) : undefined
            }
            title="Workers"
          >
            {workers.length ? (
              <div className="overflow-hidden rounded-control border">
                <div className="divide-y">
                  {workers.slice(0, 5).map((w) => (
                    <Link
                      className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-secondary/60"
                      key={w.id}
                      to={`/orchestration/workers/${encodeURIComponent(w.id)}` as never}
                    >
                      <StatusCell status={w.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{w.id}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {w.activeTaskCount ?? 0} tasks · {w.source ?? "unknown"}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No workers found.</p>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}

export function OrchestratorsPage() {
  const { orchestrators, isPending, error } = useOrchestrationData();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const statuses = useMemo(
    () => distinct(orchestrators.map((item) => item.status ?? "unknown")),
    [orchestrators],
  );
  const filteredOrchestrators = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return orchestrators.filter((orchestrator) => {
      const matchesStatus =
        statusFilter === "all" ||
        (orchestrator.status ?? "unknown") === statusFilter;
      const haystack = [
        orchestrator.id,
        orchestrator.name,
        orchestrator.endpoint,
        orchestrator.service,
        orchestrator.health,
        orchestrator.readiness,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return matchesStatus && (!needle || haystack.includes(needle));
    });
  }, [orchestrators, search, statusFilter]);

  return (
    <AppShell contentClassName="px-3 py-4">
      <div className="grid gap-3">
        <RuntimeFilters
          countLabel="orchestrators"
          isPending={isPending}
          search={search}
          statusFilter={statusFilter}
          statuses={statuses}
          totalCount={orchestrators.length}
          visibleCount={filteredOrchestrators.length}
          onSearchChange={setSearch}
          onStatusChange={setStatusFilter}
        />
        <OrchestratorList
          error={error}
          isPending={isPending}
          orchestrators={filteredOrchestrators}
        />
      </div>
    </AppShell>
  );
}

export function OrchestratorDetailPage({ id }: { id: string }) {
  const { orchestrators, isPending, error } = useOrchestrationData();
  const orchestrator =
    orchestrators.find((item) => item.id === id) ??
    orchestrators.find((item) => decodeURIComponent(id) === item.id) ??
    null;

  return (
    <AppShell
      contentClassName="px-3 py-4"
      headerActions={<BackButton to="/orchestration/orchestrators" />}
    >
      <div className="mx-auto grid w-full max-w-5xl gap-4">
        {error ? <ErrorBlock error={error} /> : null}
        {isPending ? (
          <LoadingBlock label="Loading orchestrator..." />
        ) : orchestrator ? (
          <>
            <DetailHeader
              icon={Server}
              status={orchestrator.status}
              subtitle={[orchestrator.service, orchestrator.endpoint]
                .filter(Boolean)
                .join(" · ")}
              title={orchestrator.name || orchestrator.id}
            />
            <Panel description="Runtime state and load for this orchestrator." title="Details">
              <FactList
                facts={[
                  ["Service", orchestrator.service ?? "n/a"],
                  ["Endpoint", orchestrator.endpoint ?? "n/a"],
                  ["Health", orchestrator.health ?? "unknown"],
                  ["Readiness", orchestrator.readiness ?? "unknown"],
                  ["Active workers", orchestrator.load?.activeWorkerCount ?? 0],
                  ["Active tasks", orchestrator.load?.activeTaskCount ?? 0],
                  ["Average load", formatLoad(orchestrator.load?.averageLoadScore)],
                ]}
              />
            </Panel>
          </>
        ) : (
          <EmptyBlock label="No orchestrator found." />
        )}
      </div>
    </AppShell>
  );
}

export function WorkersPage() {
  const { workers, isPending, error } = useOrchestrationData();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const statuses = useMemo(
    () => distinct(workers.map((item) => item.status ?? "unknown")),
    [workers],
  );
  const sources = useMemo(
    () => distinct(workers.map((item) => item.source ?? "unknown")),
    [workers],
  );
  const filteredWorkers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return workers.filter((worker) => {
      const status = worker.status ?? "unknown";
      const source = worker.source ?? "unknown";
      const matchesStatus = statusFilter === "all" || status === statusFilter;
      const matchesSource = sourceFilter === "all" || source === sourceFilter;
      const haystack = [
        worker.id,
        worker.hostname,
        worker.networkIdentity,
        worker.reachability,
        ...(worker.capabilities ?? []),
        ...(worker.accessibleEndpoints ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        matchesStatus && matchesSource && (!needle || haystack.includes(needle))
      );
    });
  }, [search, sourceFilter, statusFilter, workers]);

  return (
    <AppShell contentClassName="px-3 py-4">
      <div className="grid gap-3">
        <RuntimeFilters
          countLabel="workers"
          isPending={isPending}
          search={search}
          sourceFilter={sourceFilter}
          sources={sources}
          statusFilter={statusFilter}
          statuses={statuses}
          totalCount={workers.length}
          visibleCount={filteredWorkers.length}
          onSearchChange={setSearch}
          onSourceChange={setSourceFilter}
          onStatusChange={setStatusFilter}
        />
        <WorkerList
          error={error}
          isPending={isPending}
          workers={filteredWorkers}
        />
      </div>
    </AppShell>
  );
}

export function WorkerDetailPage({ id }: { id: string }) {
  const { workers, isPending, error } = useOrchestrationData();
  const worker =
    workers.find((item) => item.id === id) ??
    workers.find((item) => decodeURIComponent(id) === item.id) ??
    null;

  return (
    <AppShell
      contentClassName="px-3 py-4"
      headerActions={<BackButton to="/orchestration/workers" />}
    >
      <div className="mx-auto grid w-full max-w-5xl gap-4">
        {error ? <ErrorBlock error={error} /> : null}
        {isPending ? (
          <LoadingBlock label="Loading worker..." />
        ) : worker ? (
          <>
            <DetailHeader
              icon={Cpu}
              status={worker.status}
              subtitle={[
                worker.networkIdentity || worker.hostname,
                worker.source,
              ]
                .filter(Boolean)
                .join(" · ")}
              title={worker.id}
            />
            <Panel description="Runtime state, load, and network identity for this worker." title="Details">
              <FactList facts={workerFacts(worker)} />
            </Panel>
            <CapabilityPanel worker={worker} />
          </>
        ) : (
          <EmptyBlock label="No worker found." />
        )}
      </div>
    </AppShell>
  );
}

function RuntimeFilters({
  countLabel,
  isPending,
  search,
  sourceFilter,
  sources = [],
  statusFilter,
  statuses,
  totalCount,
  visibleCount,
  onSearchChange,
  onSourceChange,
  onStatusChange,
}: {
  countLabel: string;
  isPending: boolean;
  search: string;
  sourceFilter?: string;
  sources?: string[];
  statusFilter: string;
  statuses: string[];
  totalCount: number;
  visibleCount: number;
  onSearchChange(value: string): void;
  onSourceChange?: (value: string) => void;
  onStatusChange(value: string): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative min-w-64 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          className="h-10 w-full rounded-control border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={`Search ${countLabel}...`}
          value={search}
        />
      </label>
      <FilterSelect
        label="Status"
        options={statuses.map((status) => [status, titleCase(status)])}
        value={statusFilter}
        onChange={onStatusChange}
      />
      {onSourceChange ? (
        <FilterSelect
          label="Source"
          options={sources.map((source) => [source, titleCase(source)])}
          value={sourceFilter ?? "all"}
          onChange={onSourceChange}
        />
      ) : null}
      <div className="flex h-10 items-center gap-2 rounded-control border bg-background px-3 text-sm">
        <span className="text-muted-foreground">Showing</span>
        <span className="font-medium">
          {isPending ? "..." : `${visibleCount}/${totalCount}`}
        </span>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<[string, string]>;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        className="h-10 min-w-40 appearance-none rounded-control border bg-background px-3 pr-9 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="all">All {label}s</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </label>
  );
}

function OrchestratorList({
  error,
  isPending,
  orchestrators,
}: {
  error: unknown;
  isPending: boolean;
  orchestrators: OrchestratorRecord[];
}) {
  if (error) {
    return <ErrorBlock error={error} />;
  }
  if (isPending) {
    return <LoadingBlock label="Loading orchestrators..." />;
  }
  if (!orchestrators.length) {
    return <EmptyBlock label="No orchestrators found." />;
  }

  return (
    <div className="overflow-hidden rounded-control border bg-card">
      <div className="divide-y">
        {orchestrators.map((orchestrator) => (
          <Link
            className="grid min-h-14 grid-cols-[minmax(220px,1fr)_120px_120px_120px_140px_32px] items-center gap-4 px-3 py-3 text-sm transition-colors hover:bg-secondary/60 max-xl:grid-cols-[minmax(220px,1fr)_120px_120px_140px_32px] max-lg:grid-cols-[minmax(0,1fr)_100px_32px]"
            key={orchestrator.id}
            to={
              `/orchestration/orchestrators/${encodeURIComponent(orchestrator.id)}` as never
            }
          >
            <div className="min-w-0">
              <div className="truncate font-medium">
                {orchestrator.name || orchestrator.id}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {orchestrator.endpoint ?? "No endpoint"}
              </div>
            </div>
            <StatusCell status={orchestrator.status} />
            <span className="truncate text-muted-foreground max-lg:hidden">
              {orchestrator.readiness ?? "unknown"}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground max-xl:hidden">
              {orchestrator.load?.activeWorkerCount ?? 0} workers
            </span>
            <span className="truncate text-muted-foreground max-lg:hidden">
              {formatLoad(orchestrator.load?.averageLoadScore)}
            </span>
            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  );
}

function WorkerList({
  error,
  isPending,
  workers,
}: {
  error: unknown;
  isPending: boolean;
  workers: WorkerRecord[];
}) {
  if (error) {
    return <ErrorBlock error={error} />;
  }
  if (isPending) {
    return <LoadingBlock label="Loading workers..." />;
  }
  if (!workers.length) {
    return <EmptyBlock label="No workers found." />;
  }

  return (
    <div className="overflow-hidden rounded-control border bg-card">
      <div className="divide-y">
        {workers.map((worker) => (
          <Link
            className="grid min-h-14 grid-cols-[minmax(220px,1fr)_120px_100px_120px_140px_32px] items-center gap-4 px-3 py-3 text-sm transition-colors hover:bg-secondary/60 max-xl:grid-cols-[minmax(220px,1fr)_120px_120px_140px_32px] max-lg:grid-cols-[minmax(0,1fr)_100px_32px]"
            key={worker.id}
            to={
              `/orchestration/workers/${encodeURIComponent(worker.id)}` as never
            }
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{worker.id}</div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {worker.networkIdentity || worker.hostname || "Unknown host"}
              </div>
            </div>
            <StatusCell status={worker.status} />
            <span className="truncate font-mono text-xs text-muted-foreground max-lg:hidden">
              {worker.activeTaskCount ?? 0} tasks
            </span>
            <span className="truncate text-muted-foreground max-xl:hidden">
              {worker.source ?? "unknown"}
            </span>
            <span className="truncate text-muted-foreground max-lg:hidden">
              {formatRelativeDate(worker.heartbeatAt)}
            </span>
            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  );
}

function StatusCell({ status }: { status?: string }) {
  const normalized = status ?? "unknown";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Circle
        className={cn("h-2.5 w-2.5 fill-current", statusColor(normalized))}
      />
      <span className="truncate">{titleCase(normalized)}</span>
    </span>
  );
}


function CapabilityPanel({ worker }: { worker: WorkerRecord }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Capabilities">
        {worker.capabilities?.length ? (
          <div className="flex flex-wrap gap-2">
            {worker.capabilities.map((cap) => (
              <span
                className="rounded-control border bg-muted/40 px-2 py-1 text-xs"
                key={cap}
              >
                {cap}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No capabilities registered.</p>
        )}
      </Panel>
      <Panel title="Endpoints">
        {worker.accessibleEndpoints?.length ? (
          <div className="flex flex-wrap gap-2">
            {worker.accessibleEndpoints.map((ep) => (
              <span
                className="rounded-control border bg-muted/40 px-2 py-1 font-mono text-xs"
                key={ep}
              >
                {ep}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No endpoints registered.</p>
        )}
      </Panel>
    </div>
  );
}

function BackButton({ to }: { to: string }) {
  return (
    <Button asChild size="sm" type="button" variant="outline">
      <Link to={to as never}>
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>
    </Button>
  );
}

function OrchestrationHeader({
  activeCount,
  orchestratorCount,
  workerCount,
}: {
  activeCount: number;
  orchestratorCount: number;
  workerCount: number;
}) {
  const hasActive = activeCount > 0;

  return (
    <PageSectionHeader>
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <Network className="h-5 w-5 shrink-0 text-muted-foreground" />
        <h1 className="truncate text-xl font-semibold tracking-tight">
          Orchestration
        </h1>
        <Badge
          className={cn(
            "gap-1.5",
            hasActive
              ? "border-success/30 bg-success/10 text-success"
              : "text-muted-foreground",
          )}
          variant="outline"
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              hasActive ? "bg-success" : "bg-muted-foreground",
            )}
          />
          {hasActive ? `${activeCount} active` : "No active workers"}
        </Badge>
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
        <span>
          {orchestratorCount} orchestrator{orchestratorCount !== 1 ? "s" : ""}
        </span>
        <span aria-hidden>·</span>
        <span>
          {workerCount} worker{workerCount !== 1 ? "s" : ""}
        </span>
      </p>
    </PageSectionHeader>
  );
}

function DetailHeader({
  icon: Icon,
  status,
  subtitle,
  title,
}: {
  icon: React.ElementType;
  status?: string;
  subtitle?: string;
  title: string;
}) {
  return (
    <PageSectionHeader>
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {status ? <StatusBadge status={status} /> : null}
      </div>
      {subtitle ? (
        <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </PageSectionHeader>
  );
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const isActive = normalized === "active" || normalized === "healthy";
  const isError = normalized === "failed" || normalized === "error";

  return (
    <Badge
      className={cn(
        "gap-1.5",
        isActive && "border-success/30 bg-success/10 text-success",
        isError && "border-destructive/30 bg-destructive/10 text-destructive",
        !isActive && !isError && "text-muted-foreground",
      )}
      variant="outline"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          isActive && "bg-success",
          isError && "bg-destructive",
          !isActive && !isError && "bg-muted-foreground",
        )}
      />
      {titleCase(normalized)}
    </Badge>
  );
}

function StatCell({
  hint,
  label,
  tone,
  value,
}: {
  hint?: string;
  label: string;
  tone?: "success" | "warning" | "destructive";
  value: string;
}) {
  return (
    <div className="min-w-0 border-b px-4 py-3 last:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 truncate text-sm font-medium tabular-nums",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "destructive" && "text-destructive",
        )}
      >
        {value}
      </dd>
      <dd className="truncate text-xs text-muted-foreground">{hint ?? " "}</dd>
    </div>
  );
}

function Panel({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="rounded-surface border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function MetricRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Gauge;
  label: string;
  value: number | string;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 border-b py-2 last:border-b-0">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {label}
      </span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

function FactList({
  facts,
}: {
  facts: Array<[string, React.ReactNode]>;
}) {
  return (
    <dl className="divide-y">
      {facts.map(([label, value]) => (
        <div className="flex min-h-10 items-center gap-6 py-2" key={label}>
          <dt className="w-36 shrink-0 text-xs text-muted-foreground">{label}</dt>
          <dd className="min-w-0 flex-1 text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="rounded-control border bg-card p-4" role="status" aria-label={label}>
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div className="flex items-center gap-3" key={index}>
            <Skeleton className="h-8 w-8 shrink-0 rounded-control" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyBlock({ label }: { label: string }) {
  return <EmptyState icon={Server} title={label} />;
}

function ErrorBlock({ error }: { error: unknown }) {
  return (
    <div className="rounded-surface border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      {String(error)}
    </div>
  );
}

function workerFacts(worker: WorkerRecord): Array<[string, React.ReactNode]> {
  const metadataEntries = Object.entries(worker.metadata ?? {}).filter(
    ([key]) =>
      ![
        "workerId",
        "networkIdentity",
        "capabilities",
        "accessibleEndpoints",
        "reachability",
      ].includes(key),
  );

  return [
    ["Status", <StatusCell key="status" status={worker.status} />],
    ["Source", worker.source ?? "unknown"],
    ["Host", worker.networkIdentity || worker.hostname || "n/a"],
    ["PID", worker.pid ?? "n/a"],
    ["Reachability", worker.reachability ?? "n/a"],
    ["Active tasks", worker.activeTaskCount ?? 0],
    ["Load", formatLoad(worker.loadScore)],
    ["CPU load", formatLoad(worker.cpuLoad)],
    ["Memory", workerMemoryLabel(worker)],
    ["Bandwidth", formatBandwidth(worker.bandwidthMbps)],
    ["Heartbeat", formatDate(worker.heartbeatAt)],
    ["Updated", formatDate(worker.updatedAt)],
    ...(worker.startedAt
      ? ([["Started", formatDate(worker.startedAt)]] as Array<
          [string, React.ReactNode]
        >)
      : []),
    ...(worker.stoppedAt
      ? ([["Stopped", formatDate(worker.stoppedAt)]] as Array<
          [string, React.ReactNode]
        >)
      : []),
    ...metadataEntries.map(([key, value]): [string, React.ReactNode] => [
      metadataLabel(key),
      metadataValue(value),
    ]),
  ];
}

function workerMemoryLabel(worker: WorkerRecord) {
  if (!worker.memoryUsedBytes || !worker.memoryTotalBytes) {
    return "n/a";
  }
  const percent = Math.round(
    (worker.memoryUsedBytes / worker.memoryTotalBytes) * 100,
  );
  return `${percent}% (${formatBytes(worker.memoryUsedBytes)})`;
}

function statusColor(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "active" || normalized === "healthy") {
    return "text-success";
  }
  if (normalized === "stale" || normalized === "offline") {
    return "text-muted-foreground";
  }
  if (normalized === "failed" || normalized === "error") {
    return "text-destructive";
  }
  return "text-warning";
}

function distinct(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function metadataLabel(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function metadataValue(value: unknown) {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatRelativeDate(value: string | null | undefined) {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatLoad(value: number | undefined) {
  return typeof value === "number" ? value.toFixed(2) : "n/a";
}

function formatBandwidth(value: number | undefined) {
  return typeof value === "number" ? `${value} Mbps` : "n/a";
}
