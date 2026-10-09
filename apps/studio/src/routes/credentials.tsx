import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { ChevronDown, Plus, Search } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import {
  CredentialGrid,
  credentialProviderMetadata,
  type CredentialRecord,
} from "@/features/credentials/credential-grid";
import { apiGet } from "@/lib/api-client";

type CredentialsPayload = {
  credentials?: CredentialRecord[];
};

export const Route: any = createFileRoute("/credentials")({
  component: CredentialsRoute,
});

function CredentialsRoute() {
  const location = useLocation();
  if (location.pathname !== "/credentials") {
    return <Outlet />;
  }

  return <CredentialsPage />;
}

function CredentialsPage() {
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const { data, isPending, error } = useQuery({
    queryKey: ["/studio/credentials"],
    queryFn: () => apiGet<CredentialsPayload>("/studio/credentials"),
  });
  const credentials = data?.credentials ?? [];
  const providerOptions = useMemo(() => {
    const providers = Array.from(
      new Set(credentials.map((credential) => credential.kind).filter(Boolean)),
    ) as string[];

    return providers
      .map((provider) => [
        provider,
        credentialProviderMetadata(provider).name,
      ] as [string, string])
      .sort((left, right) => left[1].localeCompare(right[1]));
  }, [credentials]);
  const filteredCredentials = useMemo(
    () =>
      credentials.filter((credential) => {
        const haystack = [
          credential.name,
          credential.kind,
          credential.payloadPreview,
          credential.id,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const matchesSearch = haystack.includes(search.trim().toLowerCase());
        const matchesProvider =
          providerFilter === "all" || credential.kind === providerFilter;

        return matchesSearch && matchesProvider;
      }),
    [credentials, providerFilter, search],
  );

  return (
    <AppShell
      contentClassName="px-3 py-4"
      headerActions={
        <Button asChild size="sm">
          <Link to="/credentials/new">
            <Plus size={16} />
            New credentials
          </Link>
        </Button>
      }
    >
      <div className="grid gap-3">
        <CredentialFilters
          providerFilter={providerFilter}
          providerOptions={providerOptions}
          search={search}
          totalCount={credentials.length}
          visibleCount={filteredCredentials.length}
          onProviderFilterChange={setProviderFilter}
          onSearchChange={setSearch}
        />
        <CredentialGrid
          error={error}
          isPending={isPending}
          rows={filteredCredentials}
        />
      </div>
    </AppShell>
  );
}

function CredentialFilters({
  providerFilter,
  providerOptions,
  search,
  totalCount,
  visibleCount,
  onProviderFilterChange,
  onSearchChange,
}: {
  providerFilter: string;
  providerOptions: Array<[string, string]>;
  search: string;
  totalCount: number;
  visibleCount: number;
  onProviderFilterChange(value: string): void;
  onSearchChange(value: string): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative min-w-64 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          className="h-10 w-full rounded-control border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="All credentials..."
          value={search}
        />
      </label>
      <FilterSelect
        label="Provider"
        value={providerFilter}
        onChange={onProviderFilterChange}
        options={[["all", "All Providers"], ...providerOptions]}
      />
      <div className="flex h-10 items-center gap-2 rounded-control border bg-background px-3 text-sm">
        <span className="text-muted-foreground">Showing</span>
        <span className="font-medium">
          {visibleCount}/{totalCount}
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
