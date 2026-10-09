import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Download,
  PackageSearch,
  RefreshCw,
  Search,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Skeleton } from "@/components/data-page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  RegistryData,
  RegistryPackage,
} from "@/features/registry/registry-data";
import {
  mergeRegistryPackages,
  registryIdentityConflictMessage,
  registryInstallable,
  registryInstallBlockedReason,
  registryPackageStates,
  shortDate,
  titleCase,
} from "@/features/registry/registry-data";
import { RegistryPackageDetail } from "@/routes/registry_.$scope.$name";
import { ApiError } from "@/lib/api-errors";
import { apiGet, apiSend } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export const Route: any = createFileRoute("/registry")({
  component: RegistryRoute,
});

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isDesktop;
}

function RegistryRoute() {
  const registryQuery = useQuery({
    queryKey: ["/studio/registry"],
    queryFn: () => apiGet<RegistryData>("/studio/registry"),
  });
  const publicRegistryQuery = useQuery({
    queryKey: ["/studio/registry/public"],
    queryFn: () => apiGet<RegistryData>("/studio/registry/public"),
  });
  const isCheckingForUpdates =
    registryQuery.isFetching || publicRegistryQuery.isFetching;

  return (
    <AppShell
      contentClassName="h-full p-0"
      headerActions={
        <Button
          className="min-w-40"
          disabled={isCheckingForUpdates}
          onClick={() => {
            void Promise.all([
              registryQuery.refetch(),
              publicRegistryQuery.refetch(),
            ]);
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          <RefreshCw
            className={cn("size-4", isCheckingForUpdates && "animate-spin")}
          />
          {isCheckingForUpdates ? "Checking..." : "Check for updates"}
        </Button>
      }
    >
      <RegistryPage
        data={registryQuery.data}
        error={registryQuery.error}
        isPending={registryQuery.isPending}
        publicData={publicRegistryQuery.data}
        publicRegistryError={publicRegistryQuery.error}
      />
    </AppShell>
  );
}

function RegistryPage({
  data,
  error,
  isPending,
  publicData,
  publicRegistryError,
}: {
  data?: RegistryData;
  error: unknown;
  isPending: boolean;
  publicData?: RegistryData;
  publicRegistryError: unknown;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [permission, setPermission] = useState("all");
  const [trustLevel, setTrustLevel] = useState("all");
  const [status, setStatus] = useState("all");
  const packages = useMemo(
    () =>
      mergeRegistryPackages(data?.packages ?? [], publicData?.packages ?? []),
    [data?.packages, publicData?.packages],
  );
  const categories = useMemo(
    () =>
      distinct(
        packages.map((item) => item.categorySlug ?? "uncategorized"),
      ).map((slug) => ({
        id: slug,
        slug,
        name:
          packages.find((item) => item.categorySlug === slug)?.category ??
          titleCase(slug),
        packageCount: packages.filter((item) => item.categorySlug === slug)
          .length,
      })),
    [packages],
  );
  const trustLevels = useMemo(
    () => distinct(packages.map((item) => item.trustLevel)),
    [packages],
  );
  const permissions = useMemo(
    () => distinct(packages.flatMap((item) => item.permissions ?? [])),
    [packages],
  );
  const statuses = useMemo(
    () => distinct(packages.map((item) => item.status)),
    [packages],
  );
  const filteredPackages = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return packages.filter((item) => {
      const matchesQuery =
        !needle ||
        [
          item.packageName,
          item.displayName,
          item.description,
          item.category,
          ...(item.tags ?? []),
          ...(item.permissions ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle);
      return (
        matchesQuery &&
        (category === "all" ||
          (item.categorySlug ?? "uncategorized") === category) &&
        (permission === "all" ||
          (item.permissions ?? []).includes(permission)) &&
        (trustLevel === "all" || item.trustLevel === trustLevel) &&
        (status === "all" || item.status === status)
      );
    });
  }, [category, packages, permission, query, status, trustLevel]);
  const isDesktop = useIsDesktop();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selectedItem = useMemo(
    () => packages.find((item) => item.packageName === selectedName) ?? null,
    [packages, selectedName],
  );
  const hasFilters =
    Boolean(query) ||
    category !== "all" ||
    permission !== "all" ||
    trustLevel !== "all" ||
    status !== "all";

  useEffect(() => {
    const first = filteredPackages[0];
    if (isDesktop && !selectedItem && first) {
      setSelectedName(first.packageName);
    }
  }, [isDesktop, selectedItem, filteredPackages]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
        <label className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-10 w-full rounded-control border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actions"
            value={query}
          />
        </label>
        <FilterSelect
          allLabel="All categories"
          label="Category"
          options={categories.map((item) => ({
            label: `${item.name} (${item.packageCount})`,
            value: item.slug,
          }))}
          value={category}
          onChange={setCategory}
        />
        <FilterSelect
          allLabel="All permissions"
          label="Permission"
          options={permissions.map((item) => ({ label: item, value: item }))}
          value={permission}
          onChange={setPermission}
        />
        <FilterSelect
          allLabel="All trust levels"
          label="Trust"
          options={trustLevels.map((item) => ({
            label: titleCase(item),
            value: item,
          }))}
          value={trustLevel}
          onChange={setTrustLevel}
        />
        <FilterSelect
          allLabel="All statuses"
          label="Status"
          options={statuses.map((item) => ({
            label: titleCase(item),
            value: item,
          }))}
          value={status}
          onChange={setStatus}
        />
        {hasFilters ? (
          <Button
            onClick={() => {
              setQuery("");
              setCategory("all");
              setPermission("all");
              setTrustLevel("all");
              setStatus("all");
            }}
            type="button"
            variant="outline"
          >
            Reset
          </Button>
        ) : null}
      </div>
      {publicRegistryError ? (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Public Registry unavailable. Installed actions remain visible.{" "}
          {registryMutationError(publicRegistryError)}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "flex w-full flex-col lg:w-[400px] lg:shrink-0 lg:border-r",
            selectedItem && "max-lg:hidden",
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium uppercase tracking-wide">Actions</span>
            <span>
              {isPending
                ? "…"
                : `${filteredPackages.length} of ${packages.length}`}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ActionPackageList
              error={error}
              isPending={isPending}
              onSelect={setSelectedName}
              packages={filteredPackages}
              selectedName={selectedName}
            />
          </div>
        </aside>

        <section
          className={cn(
            "min-w-0 flex-1 overflow-y-auto",
            selectedItem ? "block" : "hidden lg:block",
          )}
        >
          {selectedItem ? (
            <RegistryPackageDetail
              item={selectedItem}
              key={selectedItem.packageName}
              layout="panel"
              onBack={() => setSelectedName(null)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full border bg-secondary text-muted-foreground">
                <PackageSearch className="h-6 w-6" />
              </span>
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  Select an action
                </p>
                <p className="mx-auto max-w-xs text-sm text-muted-foreground">
                  Choose a package from the list to inspect its manifest,
                  schema, and security details.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ActionPackageList({
  error,
  isPending,
  packages,
  selectedName,
  onSelect,
}: {
  error: unknown;
  isPending: boolean;
  packages: RegistryPackage[];
  selectedName: string | null;
  onSelect: (packageName: string) => void;
}) {
  if (error) {
    return (
      <div className="m-3 rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {registryMutationError(error)}
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="divide-y">
        {Array.from({ length: 8 }).map((_, index) => (
          <div className="flex items-start gap-3 px-3 py-3" key={index}>
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="h-3 w-52" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-8 w-16 shrink-0 rounded-control" />
          </div>
        ))}
      </div>
    );
  }

  if (!packages.length) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <PackageSearch className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">No actions match your filters</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Try clearing the search or switching category to see more.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y">
      {packages.map((item) => (
        <ActionPackageRow
          item={item}
          key={item.id}
          onSelect={onSelect}
          selected={item.packageName === selectedName}
        />
      ))}
    </div>
  );
}

function ActionPackageRow({
  item,
  selected,
  onSelect,
}: {
  item: RegistryPackage;
  selected: boolean;
  onSelect: (packageName: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const install = useMutation({
    mutationFn: () =>
      apiSend("POST", "/studio/registry/install", {
        packageName: item.packageName,
        range: "latest",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/studio/registry"] });
      await queryClient.invalidateQueries({
        queryKey: ["/studio/workflow-actions"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["/studio/registry/public"],
      });
      setConfirmingUpdate(false);
    },
  });
  const blockedReason = registryInstallBlockedReason(item);
  const conflictMessage = registryIdentityConflictMessage(item);
  const canInstall = registryInstallable(item);
  const installLabel =
    item.installState === "update-available" ? "Update" : "Install";
  const InstallIcon =
    item.installState === "update-available" ? RefreshCw : Download;
  const states = registryPackageStates(item);

  function requestInstall() {
    if (item.installState === "update-available") {
      setConfirmingUpdate(true);
      return;
    }
    install.mutate();
  }

  return (
    <>
      <div
        className={cn(
          "relative flex items-start gap-2 pl-3 pr-2 py-3 transition-colors hover:bg-secondary/60",
          selected &&
            "bg-secondary before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
        )}
      >
        <button
          aria-current={selected ? "true" : undefined}
          className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onSelect(item.packageName)}
          type="button"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">
              {item.displayName}
            </span>
            {states.map((state) => (
              <span
                className={cn(
                  "shrink-0 rounded-control-compact px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  state.tone === "success" && "bg-success/10 text-success",
                  state.tone === "warning" && "bg-amber-100 text-amber-900",
                  state.tone === "danger" && "bg-red-100 text-red-800",
                  state.tone === "neutral" && "bg-muted text-muted-foreground",
                )}
                key={state.id}
              >
                {state.label}
              </span>
            ))}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {item.packageName}@
            {item.publicLatestVersion ?? item.latestVersion ?? "unversioned"}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{titleCase(item.trustLevel)}</span>
            <span aria-hidden>·</span>
            <span>{item.versionCount} versions</span>
            <span aria-hidden>·</span>
            <span>{shortDate(item.updatedAt)}</span>
          </div>
          {install.error ? (
            <div className="mt-2 rounded-control-compact border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {registryMutationError(install.error)}
            </div>
          ) : null}
        </button>
        <Button
          className="shrink-0 gap-1.5"
          disabled={!canInstall || install.isPending}
          onClick={requestInstall}
          size="sm"
          type="button"
          variant={canInstall ? "default" : "outline"}
          title={blockedReason ?? conflictMessage ?? undefined}
        >
          <InstallIcon className="size-3.5" />
          {install.isPending
            ? "..."
            : blockedReason
              ? "Blocked"
              : canInstall
                ? installLabel
                : "Installed"}
        </Button>
      </div>
      <Dialog open={confirmingUpdate} onOpenChange={setConfirmingUpdate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install Registry update?</DialogTitle>
            <DialogDescription>
              This installs {item.packageName}@{item.publicLatestVersion}. It
              does not silently change existing workflow locks; Studio will ask
              for confirmation when a workflow save would adopt it.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid gap-2 rounded-surface border p-3 text-sm">
            <div className="grid grid-cols-[120px_1fr] gap-3">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono">
                {item.installedVersion} → {item.publicLatestVersion}
              </dd>
            </div>
            <div className="grid grid-cols-[120px_1fr] gap-3">
              <dt className="text-muted-foreground">Artifact</dt>
              <dd className="break-all font-mono text-xs">
                {item.availableIdentity?.artifactChecksum ?? "Not reported"}
              </dd>
            </div>
            <div className="grid grid-cols-[120px_1fr] gap-3">
              <dt className="text-muted-foreground">Trust</dt>
              <dd>
                {titleCase(
                  item.availableIdentity?.trustLevel ?? item.trustLevel,
                )}
              </dd>
            </div>
          </dl>
          <div className="flex justify-end gap-2">
            <Button
              disabled={install.isPending}
              onClick={() => setConfirmingUpdate(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={install.isPending}
              onClick={() => install.mutate()}
            >
              {install.isPending ? "Installing..." : "Install update"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FilterSelect({
  allLabel,
  label,
  options,
  value,
  onChange,
}: {
  allLabel: string;
  label: string;
  options: Array<{ label: string; value: string }>;
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
        <option value="all">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </label>
  );
}

function distinct(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function registryMutationError(error: unknown) {
  if (error instanceof ApiError) {
    return [error.message, error.action].filter(Boolean).join(" ");
  }
  return String(error);
}
