import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { latestActionPackagesByName } from "@beam-studio/core/workflows/action-versions";
import {
  ArrowRight,
  Boxes,
  ChevronDown,
  Download,
  Filter,
  PackageCheck,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  RegistryData,
  RegistryPackage,
} from "@/features/registry/registry-data";
import {
  mergeRegistryPackages,
  registryInstallBlockedReason,
  registryPackageStates,
  titleCase,
} from "@/features/registry/registry-data";
import { ApiError } from "@/lib/api-errors";
import { apiGet, apiSend } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type {
  ActionPackage,
  ActionSort,
  JsonObject,
} from "./workflow-graph-types";

type MarketplaceTab = "installed" | "public" | "builtin";
type MarketplaceItem = {
  action: ActionPackage | null;
  category: string;
  categorySlug: string;
  description: string;
  displayName: string;
  installState: RegistryPackage["installState"];
  item: RegistryPackage | null;
  maturity: string;
  packageName: string;
  permissions: string[];
  placements: string[];
  source: MarketplaceTab;
  tags: string[];
  trustLevel: string;
  version: string;
};

export function ActionCatalogDialog({
  actions,
  open,
  search,
  sort,
  totalCount,
  onActionInstalled,
  onActionSelect,
  onOpenChange,
  onSearchChange,
  onSortChange,
}: {
  actions: ActionPackage[];
  open: boolean;
  search: string;
  sort: ActionSort;
  totalCount: number;
  onActionInstalled(action: ActionPackage): void;
  onActionSelect(action: ActionPackage): void;
  onOpenChange(open: boolean): void;
  onSearchChange(value: string): void;
  onSortChange(value: ActionSort): void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<MarketplaceTab>("installed");
  const [category, setCategory] = useState("all");
  const [trustLevel, setTrustLevel] = useState("all");
  const [permission, setPermission] = useState("all");
  const [selectedPackageName, setSelectedPackageName] = useState<string | null>(
    null,
  );
  const [pendingUpdateItem, setPendingUpdateItem] =
    useState<MarketplaceItem | null>(null);
  const localRegistry = useQuery({
    enabled: open,
    queryKey: ["/studio/registry"],
    queryFn: () => apiGet<RegistryData>("/studio/registry"),
  });
  const publicRegistry = useQuery({
    enabled: open,
    queryKey: ["/studio/registry/public"],
    queryFn: () => apiGet<RegistryData>("/studio/registry/public"),
  });
  const marketplaceItems = useMemo(
    () =>
      createMarketplaceItems(
        actions,
        localRegistry.data?.packages ?? [],
        publicRegistry.data?.packages ?? [],
      ),
    [actions, localRegistry.data?.packages, publicRegistry.data?.packages],
  );
  const visibleItems = useMemo(
    () =>
      sortMarketplaceItems(
        marketplaceItems.filter((item) => {
          const matchesTab =
            tab === "installed"
              ? Boolean(item.action)
              : tab === "public"
                ? item.source === "public" ||
                  item.installState === "not-installed"
                : item.source === "builtin";
          const needle = search.trim().toLowerCase();
          const matchesSearch =
            !needle ||
            [
              item.packageName,
              item.displayName,
              item.description,
              item.category,
              item.trustLevel,
              item.maturity,
              ...item.permissions,
              ...item.placements,
              ...item.tags,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(needle);
          return (
            matchesTab &&
            matchesSearch &&
            (category === "all" || item.categorySlug === category) &&
            (permission === "all" || item.permissions.includes(permission)) &&
            (trustLevel === "all" || item.trustLevel === trustLevel)
          );
        }),
        sort,
      ),
    [category, marketplaceItems, permission, search, sort, tab, trustLevel],
  );
  const selectedItem =
    visibleItems.find((item) => item.packageName === selectedPackageName) ??
    visibleItems[0] ??
    null;
  const categories = useMemo(
    () =>
      distinct(
        marketplaceItems.map((item) => item.categorySlug).filter(Boolean),
      ).map((slug) => ({
        label:
          marketplaceItems.find((item) => item.categorySlug === slug)
            ?.category ?? titleCase(slug),
        value: slug,
      })),
    [marketplaceItems],
  );
  const trustLevels = useMemo(
    () => distinct(marketplaceItems.map((item) => item.trustLevel)),
    [marketplaceItems],
  );
  const permissions = useMemo(
    () => distinct(marketplaceItems.flatMap((item) => item.permissions)),
    [marketplaceItems],
  );
  const install = useMutation({
    mutationFn: (item: MarketplaceItem) =>
      apiSend("POST", "/studio/registry/install", {
        packageName: item.packageName,
        range: "latest",
      }),
    onSuccess: async (_result, item) => {
      await queryClient.invalidateQueries({ queryKey: ["/studio/registry"] });
      await queryClient.invalidateQueries({
        queryKey: ["/studio/workflow-actions"],
      });
      const latest = await queryClient.fetchQuery({
        queryKey: ["/studio/workflow-actions"],
        queryFn: () =>
          apiGet<{ actions: ActionPackage[] }>("/studio/workflow-actions"),
      });
      const installed = latest.actions.find(
        (action) => action.name === item.packageName,
      );
      if (installed) {
        onActionInstalled(installed);
      }
    },
  });
  const registryPending = localRegistry.isPending;
  const registryError = localRegistry.error;
  const shownCount = registryPending ? actions.length : visibleItems.length;

  function requestInstall(item: MarketplaceItem) {
    if (registryInstallBlockedReason(item.item ?? registryFallback(item))) {
      return;
    }
    if (item.installState === "update-available") {
      setPendingUpdateItem(item);
      return;
    }
    install.mutate(item);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(860px,calc(100vh-32px))] w-[min(1180px,calc(100vw-24px))] grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4 pr-12">
          <DialogTitle>Action marketplace</DialogTitle>
          <DialogDescription>
            {shownCount} of {Math.max(totalCount, marketplaceItems.length)}{" "}
            action(s)
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 border-b bg-muted/25 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-72 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className="h-10 w-full rounded-control border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search by action, provider, tag, permission"
                value={search}
              />
            </label>
            <FilterSelect
              allLabel="All categories"
              label="Category"
              options={categories}
              value={category}
              onChange={setCategory}
            />
            <FilterSelect
              allLabel="All trust"
              label="Trust"
              options={trustLevels.map((item) => ({
                label: titleCase(item),
                value: item,
              }))}
              value={trustLevel}
              onChange={setTrustLevel}
            />
            <FilterSelect
              allLabel="All permissions"
              label="Permission"
              options={permissions.map((item) => ({
                label: item,
                value: item,
              }))}
              value={permission}
              onChange={setPermission}
            />
            <label className="relative">
              <span className="sr-only">Sort actions</span>
              <select
                aria-label="Sort actions"
                className="h-10 min-w-36 appearance-none rounded-control border bg-background px-3 pr-9 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) =>
                  onSortChange(event.target.value as ActionSort)
                }
                value={sort}
              >
                <option value="name">Name</option>
                <option value="version">Version</option>
                <option value="maturity">Maturity</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <MarketplaceTabButton
              active={tab === "installed"}
              count={marketplaceItems.filter((item) => item.action).length}
              icon={PackageCheck}
              label="Installed"
              onClick={() => setTab("installed")}
            />
            <MarketplaceTabButton
              active={tab === "public"}
              count={
                marketplaceItems.filter(
                  (item) =>
                    item.source === "public" ||
                    item.installState === "not-installed",
                ).length
              }
              icon={Sparkles}
              label="Public registry"
              onClick={() => setTab("public")}
            />
            <MarketplaceTabButton
              active={tab === "builtin"}
              count={
                marketplaceItems.filter((item) => item.source === "builtin")
                  .length
              }
              icon={Boxes}
              label="Builtin"
              onClick={() => setTab("builtin")}
            />
            <Button
              className="ml-auto gap-1.5"
              disabled={
                !search &&
                category === "all" &&
                trustLevel === "all" &&
                permission === "all"
              }
              onClick={() => {
                onSearchChange("");
                setCategory("all");
                setTrustLevel("all");
                setPermission("all");
              }}
              type="button"
              variant="outline"
            >
              <Filter className="size-3.5" />
              Reset
            </Button>
          </div>
        </div>
        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_360px] max-lg:grid-cols-1">
          <div className="min-h-0 overflow-auto p-4">
            {publicRegistry.error ? (
              <div className="mb-3 rounded-control border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                Public Registry unavailable. Installed actions remain usable.{" "}
                {registryMutationError(publicRegistry.error)}
              </div>
            ) : null}
            {install.error ? (
              <div className="mb-3 rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {registryMutationError(install.error)}
              </div>
            ) : null}
            {registryError ? (
              <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {registryMutationError(registryError)}
              </div>
            ) : registryPending ? (
              <div className="rounded-control border bg-card p-4 text-sm text-muted-foreground">
                Loading marketplace actions...
              </div>
            ) : visibleItems.length ? (
              <div className="grid grid-cols-1 gap-0 overflow-hidden rounded-control border bg-card">
                {visibleItems.map((item) => (
                  <MarketplaceActionCard
                    active={selectedItem?.packageName === item.packageName}
                    item={item}
                    key={item.packageName}
                    pending={
                      install.isPending &&
                      install.variables?.packageName === item.packageName
                    }
                    onInstall={() => requestInstall(item)}
                    onSelect={() => setSelectedPackageName(item.packageName)}
                    onUse={() => {
                      if (
                        item.action &&
                        item.installState !== "update-available"
                      ) {
                        onActionSelect(item.action);
                      } else {
                        requestInstall(item);
                      }
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-control border border-dashed p-8 text-center text-sm text-muted-foreground">
                No actions match the current filters.
              </div>
            )}
          </div>
          <ActionDetailPanel
            installPending={
              install.isPending &&
              install.variables?.packageName === selectedItem?.packageName
            }
            item={selectedItem}
            onInstall={() => {
              if (selectedItem) {
                requestInstall(selectedItem);
              }
            }}
            onUse={() => {
              if (!selectedItem) {
                return;
              }
              if (
                selectedItem.action &&
                selectedItem.installState !== "update-available"
              ) {
                onActionSelect(selectedItem.action);
              } else {
                requestInstall(selectedItem);
              }
            }}
          />
        </div>
        {pendingUpdateItem ? (
          <div className="absolute inset-0 z-20 grid place-items-center bg-background/80 p-4 backdrop-blur-sm">
            <section
              aria-labelledby="registry-update-title"
              aria-modal="true"
              className="grid w-full max-w-lg gap-4 rounded-surface border bg-background p-5 shadow-xl"
              role="alertdialog"
            >
              <div>
                <h3
                  className="text-lg font-semibold"
                  id="registry-update-title"
                >
                  Install action update?
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Install {pendingUpdateItem.packageName}@
                  {pendingUpdateItem.item?.publicLatestVersion}. Existing
                  workflow locks will remain unchanged until you review and
                  confirm a workflow save.
                </p>
              </div>
              <div className="grid gap-2 rounded-control border p-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Version: </span>
                  <code>
                    {pendingUpdateItem.item?.installedVersion} →{" "}
                    {pendingUpdateItem.item?.publicLatestVersion}
                  </code>
                </div>
                <div className="break-all text-xs">
                  <span className="text-muted-foreground">
                    Artifact checksum:{" "}
                  </span>
                  <code>
                    {pendingUpdateItem.item?.availableIdentity
                      ?.artifactChecksum ?? "Not reported"}
                  </code>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  disabled={install.isPending}
                  onClick={() => setPendingUpdateItem(null)}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  disabled={install.isPending}
                  onClick={() => {
                    install.mutate(pendingUpdateItem, {
                      onSuccess: () => setPendingUpdateItem(null),
                    });
                  }}
                >
                  {install.isPending ? "Installing..." : "Install update"}
                </Button>
              </div>
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MarketplaceActionCard({
  active,
  item,
  pending,
  onInstall,
  onSelect,
  onUse,
}: {
  active: boolean;
  item: MarketplaceItem;
  pending: boolean;
  onInstall(): void;
  onSelect(): void;
  onUse(): void;
}) {
  const shouldInstall =
    !item.action || item.installState === "update-available";
  const blockedReason = registryInstallBlockedReason(
    item.item ?? registryFallback(item),
  );
  const actionLabel = item.action
    ? item.installState === "update-available"
      ? "Update & add"
      : "Add"
    : "Install & add";
  const ActionIcon = shouldInstall ? Download : ArrowRight;
  return (
    <button
      className={cn(
        "grid min-h-36 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 border-b bg-card p-4 text-left transition-colors last:border-b-0 hover:bg-secondary/70 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring",
        active && "border-ring bg-secondary/60",
      )}
      onClick={onSelect}
      onDoubleClick={onUse}
      type="button"
    >
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <strong className="line-clamp-2 text-sm leading-5">
            {item.displayName}
          </strong>
          <InstallStateBadge item={item} />
        </div>
        <code className="mt-1 block truncate text-xs text-muted-foreground">
          {item.packageName}
        </code>
      </div>
      <p className="line-clamp-4 overflow-hidden text-sm leading-5 text-muted-foreground">
        {item.description || "No description."}
      </p>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          <Badge variant="secondary">v{item.version}</Badge>
          <Badge variant="outline">{titleCase(item.trustLevel)}</Badge>
          {item.maturity ? (
            <Badge variant="outline">{item.maturity}</Badge>
          ) : null}
        </div>
        <Button
          className="h-8 gap-1.5 px-2.5"
          disabled={pending || Boolean(blockedReason)}
          onClick={(event) => {
            event.stopPropagation();
            if (shouldInstall) {
              onInstall();
            } else {
              onUse();
            }
          }}
          size="sm"
          type="button"
          title={blockedReason ?? undefined}
        >
          <ActionIcon className="size-3.5" />
          {pending ? "..." : actionLabel}
        </Button>
      </div>
    </button>
  );
}

function ActionDetailPanel({
  installPending,
  item,
  onInstall,
  onUse,
}: {
  installPending: boolean;
  item: MarketplaceItem | null;
  onInstall(): void;
  onUse(): void;
}) {
  if (!item) {
    return (
      <aside className="hidden border-l bg-muted/15 p-5 text-sm text-muted-foreground lg:block">
        Select an action to inspect its install state, permissions, and runtime.
      </aside>
    );
  }

  const actionLabel = item.action
    ? item.installState === "update-available"
      ? "Update & add"
      : "Add to workflow"
    : "Install & add";
  const blockedReason = registryInstallBlockedReason(
    item.item ?? registryFallback(item),
  );
  return (
    <aside className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] border-l bg-muted/15 max-lg:hidden">
      <div className="border-b p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="line-clamp-2 text-base font-semibold leading-6">
              {item.displayName}
            </h3>
            <code className="mt-1 block truncate text-xs text-muted-foreground">
              {item.packageName}@{item.version}
            </code>
          </div>
          <InstallStateBadge item={item} />
        </div>
      </div>
      <div className="min-h-0 space-y-5 overflow-auto p-5 text-sm">
        <p className="leading-6 text-muted-foreground">
          {item.description || "No description."}
        </p>
        <DetailSection label="Source">
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{sourceLabel(item.source)}</Badge>
            <Badge variant="outline">{titleCase(item.trustLevel)}</Badge>
            {item.item?.latestValidationStatus ? (
              <Badge variant="outline">
                <ShieldCheck className="mr-1 size-3" />
                {titleCase(item.item.latestValidationStatus)}
              </Badge>
            ) : null}
          </div>
        </DetailSection>
        <DetailSection label="Runtime">
          <BadgeList
            emptyLabel="No placement declared"
            values={item.placements}
          />
        </DetailSection>
        <DetailSection label="Permissions">
          <BadgeList
            emptyLabel="No permission declared"
            values={item.permissions}
          />
        </DetailSection>
        <DetailSection label="Tags">
          <BadgeList emptyLabel="No tags" values={item.tags} />
        </DetailSection>
        {item.item?.latestArtifactChecksum ? (
          <DetailSection label="Artifact checksum">
            <code className="block break-all rounded-control border bg-background p-2 text-xs text-muted-foreground">
              {item.item.latestArtifactChecksum}
            </code>
          </DetailSection>
        ) : null}
        {item.item?.latestArtifactReference ? (
          <DetailSection label="Artifact reference">
            <code className="block break-all rounded-control border bg-background p-2 text-xs text-muted-foreground">
              {item.item.latestArtifactReference}
            </code>
          </DetailSection>
        ) : null}
        {blockedReason ? (
          <div className="rounded-control border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {blockedReason}
          </div>
        ) : null}
      </div>
      <div className="flex gap-2 border-t p-4">
        <Button
          className="flex-1 gap-1.5"
          disabled={installPending || Boolean(blockedReason)}
          onClick={onUse}
          type="button"
        >
          {!item.action || item.installState === "update-available" ? (
            <Download className="size-4" />
          ) : (
            <ArrowRight className="size-4" />
          )}
          {installPending ? "..." : actionLabel}
        </Button>
      </div>
    </aside>
  );
}

function DetailSection({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <section className="grid gap-2">
      <h4 className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </h4>
      {children}
    </section>
  );
}

function BadgeList({
  emptyLabel,
  values,
}: {
  emptyLabel: string;
  values: string[];
}) {
  if (!values.length) {
    return <span className="text-sm text-muted-foreground">{emptyLabel}</span>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {values.map((value) => (
        <Badge key={value} variant="outline">
          {value}
        </Badge>
      ))}
    </div>
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

function MarketplaceTabButton({
  active,
  count,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  icon: LucideIcon;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      className={cn(
        "flex h-9 items-center gap-2 rounded-control border px-3 text-sm transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring",
        active
          ? "border-ring bg-secondary text-secondary-foreground"
          : "bg-background",
      )}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-4" />
      <span>{label}</span>
      <Badge variant="outline">{count}</Badge>
    </button>
  );
}

function InstallStateBadge({ item }: { item: MarketplaceItem }) {
  const states = registryPackageStates(item.item ?? registryFallback(item));
  const important = states.find(
    (state) => state.id === "blocked" || state.id === "vulnerable",
  );
  if (important) {
    return (
      <Badge
        className="border-red-300 bg-red-50 text-red-800"
        variant="outline"
      >
        {important.label}
      </Badge>
    );
  }
  if (item.action && item.installState !== "update-available") {
    return <Badge variant="secondary">Installed</Badge>;
  }
  if (item.installState === "update-available") {
    return (
      <Badge variant="outline">
        <RefreshCw className="mr-1 size-3" />
        Update
      </Badge>
    );
  }
  return <Badge variant="outline">Public</Badge>;
}

function createMarketplaceItems(
  actions: ActionPackage[],
  localPackages: RegistryPackage[],
  publicPackages: RegistryPackage[],
) {
  const actionsByName = latestActionPackagesByName(actions);
  const registryByName = new Map(
    mergeRegistryPackages(localPackages, publicPackages).map((item) => [
      item.packageName,
      item,
    ]),
  );
  const names = new Set([...actionsByName.keys(), ...registryByName.keys()]);
  const items: MarketplaceItem[] = [];
  for (const packageName of names) {
    const action = actionsByName.get(packageName) ?? null;
    const registryItem = registryByName.get(packageName) ?? null;
    const manifest = (action?.manifest ??
      registryItem?.latestManifest ??
      {}) as JsonObject;
    const catalog = objectValue(manifest.catalog);
    const installedVersion =
      registryItem?.installedVersion ?? action?.version ?? null;
    const publicLatestVersion = registryItem?.publicLatestVersion ?? null;
    const installState: RegistryPackage["installState"] =
      registryItem?.installState ??
      (installedVersion ? "installed" : "not-installed");
    const trustLevel = String(
      registryItem?.trustLevel ?? manifest.trustLevel ?? "external",
    );
    items.push({
      action,
      category: String(
        registryItem?.category ?? catalog.category ?? "Workflow",
      ),
      categorySlug: String(
        registryItem?.categorySlug ?? catalog.category ?? "workflow",
      ),
      description: String(
        registryItem?.description ?? manifest.description ?? "",
      ),
      displayName: String(
        registryItem?.displayName ?? manifest.displayName ?? packageName,
      ),
      installState,
      item: registryItem,
      maturity: String(catalog.maturity ?? "experimental"),
      packageName,
      permissions: normalizeStringList(
        registryItem?.permissions ?? manifest.permissions,
      ),
      placements: normalizeStringList(
        registryItem?.placements ?? manifest.placements,
      ),
      source:
        trustLevel === "builtin"
          ? "builtin"
          : publicLatestVersion
            ? "public"
            : "installed",
      tags: normalizeStringList(registryItem?.tags ?? catalog.tags),
      trustLevel,
      version: String(
        installState === "update-available"
          ? (publicLatestVersion ?? installedVersion ?? "latest")
          : (installedVersion ??
              publicLatestVersion ??
              registryItem?.latestVersion ??
              "latest"),
      ),
    });
  }
  return items.sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function sortMarketplaceItems(items: MarketplaceItem[], sort: ActionSort) {
  return [...items].sort((left, right) => {
    if (sort === "version") {
      return (
        left.version.localeCompare(right.version) ||
        left.displayName.localeCompare(right.displayName)
      );
    }
    if (sort === "maturity") {
      return (
        left.maturity.localeCompare(right.maturity) ||
        left.displayName.localeCompare(right.displayName)
      );
    }
    return left.displayName.localeCompare(right.displayName);
  });
}

function distinct(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function normalizeStringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function sourceLabel(source: MarketplaceTab) {
  if (source === "public") {
    return "Public registry";
  }
  if (source === "builtin") {
    return "Builtin";
  }
  return "Installed";
}

function registryFallback(item: MarketplaceItem): RegistryPackage {
  return {
    id: item.packageName,
    packageName: item.packageName,
    scope: item.packageName.split("/")[0] ?? "@unknown",
    name: item.packageName.split("/")[1] ?? item.packageName,
    displayName: item.displayName,
    description: item.description,
    category: item.category,
    categorySlug: item.categorySlug,
    visibility: "public",
    status: "active",
    trustLevel: item.trustLevel,
    latestVersion: item.version,
    versionCount: 1,
    installState: item.installState,
    permissions: item.permissions,
    placements: item.placements,
    tags: item.tags,
    updatedAt: new Date(0).toISOString(),
  };
}

function registryMutationError(error: unknown) {
  return error instanceof ApiError
    ? [error.message, error.action].filter(Boolean).join(" ")
    : String(error);
}
