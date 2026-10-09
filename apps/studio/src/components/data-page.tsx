import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  Circle,
  ExternalLink,
  GitBranch,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type {
  AssistantModelOption,
  AssistantProviderOption,
  AssistantProviderSettings,
  AssistantProviderSummary,
  BeamEnvironmentTemplate,
} from "@beam-studio/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AppShell } from "@/components/app-shell";
import { AssistantModelSelector } from "@/components/assistant-model-selector";
import { PageSectionHeader } from "@/components/header-primitives";
import { EmptyState } from "@/components/ui/empty-state";
import { apiGet, apiSend } from "@/lib/api-client";
import { StudioUpdatePanel } from "@/features/settings/studio-update-panel";
import { runSummaryHint } from "@/features/settings/run-summary";
import { cn } from "@/lib/utils";

export { EmptyState };

const emptyAssistantProviderCatalog: AssistantProviderOption[] = [];

type Field = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "checkbox" | "json";
  placeholder?: string;
  defaultValue?: unknown;
};

type RowAction = {
  label: string;
  method: "POST" | "DELETE";
  path: (row: Record<string, unknown>) => string;
  confirm?: string;
};

type DataColumn = {
  key: string;
  label?: string;
  render?: (value: unknown, row: Record<string, unknown>) => ReactNode;
};

type ResourcePageProps = {
  title: string;
  description?: string;
  headerContent?: ReactNode;
  headerActions?: HeaderAction[];
  endpoint: string;
  collectionKey: string;
  quickCreate?: {
    label: string;
    endpoint: string;
    payload: Record<string, unknown>;
    redirectTo: (result: Record<string, unknown>) => string;
  };
  columns?: DataColumn[];
  detailPath?: (row: Record<string, unknown>) => string;
  renderRows?: (input: { rows: Record<string, unknown>[] }) => ReactNode;
  create?: {
    title: string;
    endpoint: string;
    fields: Field[];
    redirectTo?: (result: Record<string, unknown>) => string;
    onCreated?: (result: Record<string, unknown>) => void;
  };
  actions?: RowAction[];
  createDialogOpen?: boolean;
  hidePageHeader?: boolean;
  hidePageHeaderActions?: boolean;
  onCreateDialogOpenChange?: (open: boolean) => void;
};

export type HeaderAction = {
  label: string;
  icon: LucideIcon;
  to?: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "secondary" | "ghost" | "outline";
};

export function ResourceAppPage(props: ResourcePageProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const hasHeaderActions = Boolean(
    props.create ||
    props.quickCreate ||
    props.headerActions?.length ||
    props.headerContent,
  );
  const quickCreateMutation = useMutation({
    mutationFn: () =>
      apiSend<Record<string, unknown>>(
        "POST",
        props.quickCreate?.endpoint ?? props.endpoint,
        props.quickCreate?.payload ?? {},
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [props.endpoint] });
      const next = props.quickCreate?.redirectTo(result);
      if (next) {
        navigate({ to: next as never });
      }
    },
  });

  return (
    <AppShell
      contentClassName="px-3 py-4"
      headerActions={
        hasHeaderActions ? (
          <>
            {props.create ? (
              <Button
                onClick={() => setCreateDialogOpen(true)}
                size="sm"
                type="button"
                variant="default"
              >
                <Plus className="h-4 w-4" />
                {props.create.title}
              </Button>
            ) : null}
            {props.quickCreate ? (
              <Button
                disabled={quickCreateMutation.isPending}
                onClick={() => quickCreateMutation.mutate()}
                size="sm"
                type="button"
                variant={props.create ? "secondary" : "default"}
              >
                <Plus className="h-4 w-4" />
                {props.quickCreate.label}
              </Button>
            ) : null}
            {props.headerActions?.map((action) => (
              <HeaderActionButton action={action} key={actionKey(action)} />
            ))}
            {props.headerContent}
          </>
        ) : undefined
      }
    >
      <ResourcePage
        {...props}
        createDialogOpen={createDialogOpen}
        hidePageHeader={props.hidePageHeader}
        hidePageHeaderActions
        onCreateDialogOpenChange={setCreateDialogOpen}
      />
    </AppShell>
  );
}

export function ResourcePage(props: ResourcePageProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [internalCreateDialogOpen, setInternalCreateDialogOpen] =
    useState(false);
  const createDialogOpen = props.createDialogOpen ?? internalCreateDialogOpen;
  const setCreateDialogOpen =
    props.onCreateDialogOpenChange ?? setInternalCreateDialogOpen;
  const { data, isPending, error } = useQuery({
    queryKey: [props.endpoint],
    queryFn: () => apiGet<Record<string, unknown>>(props.endpoint),
  });
  const rows = asRecords(data?.[props.collectionKey]);
  const [filter, setFilter] = useState("");
  const filteredRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) {
      return rows;
    }
    return rows.filter((row) =>
      JSON.stringify(row).toLowerCase().includes(needle),
    );
  }, [filter, rows]);

  const rowMutation = useMutation({
    mutationFn: (input: { action: RowAction; row: Record<string, unknown> }) =>
      apiSend(input.action.method, input.action.path(input.row)),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [props.endpoint] }),
  });
  const quickCreateMutation = useMutation({
    mutationFn: () =>
      apiSend<Record<string, unknown>>(
        "POST",
        props.quickCreate?.endpoint ?? props.endpoint,
        props.quickCreate?.payload ?? {},
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [props.endpoint] });
      const next = props.quickCreate?.redirectTo(result);
      if (next) {
        navigate({ to: next as never });
      }
    },
  });
  const headerActions = [
    ...(props.create
      ? [
          {
            label: props.create.title,
            icon: Plus,
            onClick: () => setCreateDialogOpen(true),
          },
        ]
      : []),
    ...(props.quickCreate
      ? [
          {
            label: props.quickCreate.label,
            icon: Plus,
            onClick: () => quickCreateMutation.mutate(),
            disabled: quickCreateMutation.isPending,
          },
        ]
      : []),
    ...(props.headerActions ?? []),
  ];

  return (
    <div className="grid gap-3">
      {props.hidePageHeader ? null : (
        <PageHeader
          title={props.title}
          description={props.description}
          actions={props.hidePageHeaderActions ? [] : headerActions}
        >
          {props.hidePageHeaderActions ? null : props.headerContent}
        </PageHeader>
      )}
      {props.create ? (
        <CreateDialog
          config={props.create}
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          onCreated={(result) => {
            queryClient.invalidateQueries({ queryKey: [props.endpoint] });
            setCreateDialogOpen(false);
            props.create?.onCreated?.(result);
            const next = props.create?.redirectTo?.(result);
            if (next) {
              navigate({ to: next as never });
            }
          }}
        />
      ) : null}
      <ResourceFilters
        filter={filter}
        isPending={isPending}
        totalCount={rows.length}
        visibleCount={filteredRows.length}
        onFilterChange={setFilter}
      />
      {error ? (
        <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {String(error)}
        </div>
      ) : rowMutation.error ? (
        <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {String(rowMutation.error)}
        </div>
      ) : isPending ? (
        <TableSkeleton />
      ) : !filteredRows.length ? (
        <EmptyState
          description={
            filter
              ? `No results match “${filter}”. Try a different search.`
              : `Nothing here yet. New ${props.title.toLowerCase()} will show up in this list.`
          }
          title={
            filter
              ? `No ${props.title.toLowerCase()} match your search`
              : `No ${props.title.toLowerCase()} yet`
          }
        />
      ) : props.renderRows ? (
        props.renderRows({ rows: filteredRows })
      ) : (
        <DataTable
          actionPending={rowMutation.isPending}
          actions={props.actions ?? []}
          columns={props.columns}
          detailPath={props.detailPath}
          onAction={(action, row) => rowMutation.mutateAsync({ action, row })}
          rows={filteredRows}
        />
      )}
    </div>
  );
}

export function DetailPage({
  title,
  endpoint,
  headerActions,
  actions,
}: {
  title: string;
  endpoint: string;
  headerActions?: HeaderAction[];
  actions?: RowAction[];
}) {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: [endpoint],
    queryFn: () => apiGet<Record<string, unknown>>(endpoint),
  });
  const mutation = useMutation({
    mutationFn: (action: RowAction) =>
      apiSend(action.method, action.path(data ?? {})),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [endpoint] }),
  });

  return (
    <div className="grid gap-6">
      <PageHeader
        title={title}
        description={endpoint}
        actions={headerActions}
      />
      {actions?.length ? (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action.label}
              onClick={() => mutation.mutate(action)}
              type="button"
              variant="secondary"
            >
              <Send className="h-4 w-4" />
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          {isPending ? (
            "Loading..."
          ) : error ? (
            String(error)
          ) : (
            <JsonBlock value={data} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const { data, error, isFetching, isPending, refetch } = useQuery({
    queryKey: ["/studio/settings"],
    queryFn: () => apiGet<SettingsPayload>("/studio/settings"),
  });
  const summary = data?.summary ?? {};
  const dataStore = data?.dataStore;
  const beam = data?.beam ?? {};
  const runtime = data?.runtime ?? {};
  const assistantProviders = data?.assistant?.providers ?? [];
  const dataStoreStatus = textValue(dataStore?.status) || "unknown";
  const statusConnected = dataStoreStatus === "connected";

  const dataStoreItems: SettingsItem[] = [
    {
      label: "Status",
      value: dataStoreStatus,
      badgeTone: statusConnected ? "success" : "destructive",
    },
    { label: "Engine", value: dataStore?.engine },
    { label: "Mode", value: dataStore?.mode },
    { label: "Config source", value: dataStore?.source, code: true },
    { label: "Connection", value: dataStore?.connectionUrl, code: true },
    { label: "Host", value: dataStore?.host, code: true },
    { label: "Port", value: dataStore?.port },
    {
      label: "Database",
      value: dataStore?.currentDatabase ?? dataStore?.database,
    },
    { label: "User", value: dataStore?.currentUser ?? dataStore?.user },
    { label: "Server version", value: dataStore?.serverVersion },
    ...(dataStore?.error
      ? [
          {
            label: "Error",
            value: dataStore.error,
            badgeTone: "destructive" as const,
          },
        ]
      : []),
  ];
  const beamItems: SettingsItem[] = [
    {
      label: "Default Beam",
      value: beam.defaultBaseUrl,
      href: beam.defaultBaseUrl,
    },
    {
      label: "Coordinator",
      value: beam.defaultCoordinatorUrl,
      href: beam.defaultCoordinatorUrl,
    },
    { label: "NATS", value: beam.defaultNatsUrl, code: true },
    { label: "Auth", value: beam.authUrl, href: beam.authUrl },
    { label: "Console", value: beam.consoleUrl, href: beam.consoleUrl },
    { label: "Admin", value: beam.adminUrl, href: beam.adminUrl },
    { label: "Studio", value: beam.studioUrl, href: beam.studioUrl },
    { label: "API", value: beam.apiUrl, href: beam.apiUrl },
    {
      label: "Beam servers",
      value: beam.serverOptions?.length
        ? beam.serverOptions.join(", ")
        : undefined,
      code: true,
    },
  ];
  const runtimeItems: SettingsItem[] = [
    { label: "App", value: data?.appName },
    { label: "Organization", value: data?.organizationId, code: true },
    { label: "Auth portal", value: runtime.authPortal },
    {
      label: "Secure cookies",
      value: runtime.secureCookies,
      badgeTone: runtime.secureCookies ? "success" : "muted",
    },
  ];

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <SettingsHeader
        appName={data?.appName}
        dataStore={dataStore}
        isFetching={isFetching}
        onRefresh={() => void refetch()}
        statusConnected={statusConnected}
        statusLabel={dataStoreStatus}
      />
      <StudioUpdatePanel />
      {error ? (
        <div className="rounded-surface border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {String(error)}
        </div>
      ) : (
        <>
          <SettingsStatsBar isPending={isPending} summary={summary} />
          <SettingsPanel
            description="PostgreSQL connection used by this API process."
            title="Data store"
          >
            <ItemList isPending={isPending} items={dataStoreItems} />
          </SettingsPanel>
          <SettingsPanel
            description="External services this Studio instance opens or calls."
            title="Beam services"
          >
            <ItemList isPending={isPending} items={beamItems} />
          </SettingsPanel>
          <BeamEnvironmentTemplatesPanel
            isPending={isPending}
            settings={beam.environments}
          />
          <AssistantPanel
            catalog={data?.assistant?.catalog ?? emptyAssistantProviderCatalog}
            isPending={isPending}
            providers={assistantProviders}
            settings={data?.assistant?.settings ?? null}
          />
          <SettingsPanel
            description="Authentication, organization, and browser-facing runtime flags."
            title="Runtime"
          >
            <ItemList isPending={isPending} items={runtimeItems} />
          </SettingsPanel>
        </>
      )}
    </div>
  );
}

function SettingsHeader({
  appName,
  dataStore,
  isFetching,
  onRefresh,
  statusConnected,
  statusLabel,
}: {
  appName?: string;
  dataStore?: SettingsDataStore;
  isFetching: boolean;
  onRefresh: () => void;
  statusConnected: boolean;
  statusLabel: string;
}) {
  return (
    <PageSectionHeader>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <Settings className="h-5 w-5 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-xl font-semibold tracking-tight">
            Settings
          </h1>
          <Badge
            className={cn(
              "gap-1.5",
              statusConnected
                ? "border-success/30 bg-success/10 text-success"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
            variant="outline"
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                statusConnected ? "bg-success" : "bg-destructive",
              )}
            />
            {statusConnected ? "Connected" : statusLabel}
          </Badge>
        </div>
        <Button
          disabled={isFetching}
          onClick={onRefresh}
          size="sm"
          type="button"
          variant="secondary"
        >
          <RefreshCw className="h-4 w-4" />
          {isFetching ? "Refreshing" : "Refresh"}
        </Button>
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
        {appName ? (
          <span className="font-medium text-foreground">{appName}</span>
        ) : null}
        {appName && dataStore?.engine ? <span aria-hidden>·</span> : null}
        {dataStore?.engine ? <span>{dataStore.engine}</span> : null}
        {(appName || dataStore?.engine) && dataStore?.host ? (
          <span aria-hidden>·</span>
        ) : null}
        {dataStore?.host ? <span>{dataStore.host}</span> : null}
      </p>
    </PageSectionHeader>
  );
}

function SettingsStatsBar({
  isPending,
  summary,
}: {
  isPending: boolean;
  summary: Record<string, unknown>;
}) {
  const failedCount = numberValue(summary.failedRunCount);
  const runHint = runSummaryHint({
    runCount: numberValue(summary.runCount),
    completedRunCount: numberValue(summary.completedRunCount),
    failedRunCount: failedCount,
  });

  return (
    <div className="overflow-hidden rounded-surface border bg-card">
      <dl className="grid sm:grid-cols-3 lg:grid-cols-5">
        <StatCell
          hint="total"
          isPending={isPending}
          label="Workflows"
          value={String(numberValue(summary.workflowCount))}
        />
        <StatCell
          hint="of total"
          isPending={isPending}
          label="Enabled"
          value={String(numberValue(summary.enabledWorkflowCount))}
        />
        <StatCell
          hint="active triggers"
          isPending={isPending}
          label="Schedules"
          value={String(numberValue(summary.activeScheduleCount))}
        />
        <StatCell
          hint={runHint}
          isPending={isPending}
          label="Runs"
          tone={failedCount ? "destructive" : undefined}
          value={String(numberValue(summary.runCount))}
        />
        <StatCell
          hint="last 20 runs"
          isPending={isPending}
          label="Success rate"
          value={`${numberValue(summary.successRate)}%`}
        />
      </dl>
    </div>
  );
}

function StatCell({
  hint,
  isPending,
  label,
  tone,
  value,
}: {
  hint?: string;
  isPending: boolean;
  label: string;
  tone?: "destructive";
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
          tone === "destructive" && "text-destructive",
        )}
      >
        {isPending ? "—" : value}
      </dd>
      <dd className="truncate text-xs text-muted-foreground">{hint ?? " "}</dd>
    </div>
  );
}

function SettingsPanel({
  action,
  children,
  description,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="rounded-surface border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      <div className="px-4 py-1">{children}</div>
    </section>
  );
}

function ItemList({
  isPending,
  items,
}: {
  isPending: boolean;
  items: SettingsItem[];
}) {
  return (
    <dl className="divide-y">
      {items.map((item) => (
        <div className="flex min-h-10 items-center gap-6 py-2" key={item.label}>
          <dt className="w-36 shrink-0 text-xs text-muted-foreground">
            {item.label}
          </dt>
          <dd className="min-w-0 flex-1 text-sm">
            {isPending ? (
              <span className="text-muted-foreground">—</span>
            ) : item.badgeTone ? (
              <Badge
                className={cn("gap-1.5", badgeTone(item.badgeTone))}
                variant="outline"
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    dotTone(item.badgeTone),
                  )}
                />
                {formatValue(item.value)}
              </Badge>
            ) : item.href ? (
              <a
                className="inline-flex max-w-full items-center gap-1.5 underline-offset-4 hover:underline"
                href={item.href}
                rel="noreferrer"
                target="_blank"
              >
                <span className="truncate font-mono text-xs">
                  {formatValue(item.value)}
                </span>
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
              </a>
            ) : item.code ? (
              <code className="rounded-control-compact bg-muted/70 px-1.5 py-0.5 text-xs">
                {formatValue(item.value)}
              </code>
            ) : (
              <span className="break-words">{formatValue(item.value)}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function BeamEnvironmentTemplatesPanel({
  isPending,
  settings,
}: {
  isPending: boolean;
  settings?: BeamEnvironmentSettingsPayload;
}) {
  const queryClient = useQueryClient();
  const templates = settings?.templates ?? [];
  const [editing, setEditing] = useState<BeamTemplateFormState | null>(null);
  const defaultMutation = useMutation({
    mutationFn: (defaultTemplateKey: string) =>
      apiSend("PATCH", "/studio/beam-environment-settings", {
        defaultTemplateKey,
      }),
    onSuccess: () => invalidateSettings(queryClient),
  });
  const saveMutation = useMutation({
    mutationFn: (template: BeamTemplateFormState) =>
      apiSend(
        "PUT",
        `/studio/beam-environment-templates/${encodeURIComponent(template.key)}`,
        template,
      ),
    onSuccess: () => {
      setEditing(null);
      invalidateSettings(queryClient);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (templateKey: string) =>
      apiSend(
        "DELETE",
        `/studio/beam-environment-templates/${encodeURIComponent(templateKey)}`,
      ),
    onSuccess: () => invalidateSettings(queryClient),
  });

  if (!settings?.devSettingsEnabled) return null;

  return (
    <SettingsPanel
      action={
        <Button
          size="sm"
          type="button"
          variant="outline"
          onClick={() => setEditing(emptyBeamTemplateForm())}
        >
          <Plus className="h-4 w-4" />
          Add template
        </Button>
      }
      description="Controls for the Beam environment used by room browsing, room creation, and room-transfer action configs."
      title="Beam environment templates"
    >
      <div className="grid gap-4 py-3">
        <label className="grid gap-2 text-sm font-medium">
          Default template
          <select
            className={settingsInputClass}
            disabled={isPending || defaultMutation.isPending}
            value={settings.defaultTemplateKey}
            onChange={(event) => defaultMutation.mutate(event.target.value)}
          >
            {templates.map((template) => (
              <option key={template.key} value={template.key}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-2">
          {templates.map((template) => (
            <div
              className="grid gap-3 rounded-control border bg-background p-3 text-sm"
              key={template.key}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{template.name}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  {template.key !== "prod" ? (
                    <Button
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => setEditing(templateToForm(template))}
                    >
                      Edit
                    </Button>
                  ) : null}
                  {template.key !== "prod" ? (
                    <Button
                      disabled={deleteMutation.isPending}
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => deleteMutation.mutate(template.key)}
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
        {editing ? (
          <BeamTemplateForm
            error={saveMutation.error}
            isPending={saveMutation.isPending}
            template={editing}
            onCancel={() => setEditing(null)}
            onChange={setEditing}
            onSave={() => saveMutation.mutate(editing)}
          />
        ) : null}
        {defaultMutation.error || deleteMutation.error ? (
          <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {String(defaultMutation.error ?? deleteMutation.error)}
          </p>
        ) : null}
      </div>
    </SettingsPanel>
  );
}

function BeamTemplateForm({
  error,
  isPending,
  onCancel,
  onChange,
  onSave,
  template,
}: {
  error: unknown;
  isPending: boolean;
  onCancel: () => void;
  onChange: (template: BeamTemplateFormState) => void;
  onSave: () => void;
  template: BeamTemplateFormState;
}) {
  const patch = (key: keyof BeamTemplateFormState, value: string) =>
    onChange({ ...template, [key]: value });
  return (
    <div className="grid gap-3 rounded-control border bg-muted/30 p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <SettingsInput
          disabled={isPending}
          label="Key"
          value={template.key}
          onChange={(value) => patch("key", value)}
        />
        <SettingsInput
          disabled={isPending}
          label="Name"
          value={template.name}
          onChange={(value) => patch("name", value)}
        />
        <SettingsInput
          disabled={isPending}
          label="BeamCore / runtime URL"
          value={template.baseUrl}
          onChange={(value) => patch("baseUrl", value)}
        />
        <SettingsInput
          disabled={isPending}
          label="Coordinator URL"
          value={template.coordinatorUrl}
          onChange={(value) => patch("coordinatorUrl", value)}
        />
        <SettingsInput
          disabled={isPending}
          label="NATS URL"
          value={template.natsUrl}
          onChange={(value) => patch("natsUrl", value)}
        />
        <SettingsInput
          disabled={isPending}
          label="Auth URL"
          value={template.authUrl}
          onChange={(value) => patch("authUrl", value)}
        />
        <SettingsInput
          disabled={isPending}
          label="API URL"
          value={template.apiUrl}
          onChange={(value) => patch("apiUrl", value)}
        />
        <SettingsInput
          disabled={isPending}
          label="Registry URL"
          value={template.registryUrl}
          onChange={(value) => patch("registryUrl", value)}
        />
      </div>
      {error ? (
        <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {String(error)}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          disabled={isPending}
          type="button"
          variant="outline"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button disabled={isPending} type="button" onClick={onSave}>
          {isPending ? "Saving…" : "Save template"}
        </Button>
      </div>
    </div>
  );
}

function SettingsInput({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      <input
        className={settingsInputClass}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function invalidateSettings(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["/studio/settings"] });
  void queryClient.invalidateQueries({
    queryKey: ["/studio/beam-environment-settings"],
  });
  void queryClient.invalidateQueries({ queryKey: ["/studio/rooms"] });
}

type BeamEnvironmentSettingsPayload = {
  devSettingsEnabled: boolean;
  defaultTemplateKey: string;
  templates: BeamEnvironmentTemplate[];
};

type BeamTemplateFormState = {
  key: string;
  name: string;
  baseUrl: string;
  coordinatorUrl: string;
  natsUrl: string;
  authUrl: string;
  apiUrl: string;
  registryUrl: string;
};

function templateToForm(
  template: BeamEnvironmentTemplate,
): BeamTemplateFormState {
  return {
    key: template.key,
    name: template.name,
    baseUrl: template.baseUrl,
    coordinatorUrl: template.coordinatorUrl,
    natsUrl: template.natsUrl,
    authUrl: template.authUrl,
    apiUrl: template.apiUrl,
    registryUrl: template.registryUrl,
  };
}

function emptyBeamTemplateForm(): BeamTemplateFormState {
  return {
    key: "",
    name: "",
    baseUrl: "https://beamcore.b1m.ai",
    coordinatorUrl: "https://coordinator.b1m.ai",
    natsUrl: "tls://orch-gateway.b1m.ai:4222",
    authUrl: "https://auth.b1m.ai",
    apiUrl: "https://api.b1m.ai",
    registryUrl: "https://api.b1m.ai/registry",
  };
}

const settingsInputClass =
  "h-10 w-full rounded-control border bg-background px-3 text-sm font-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

export function AssistantPanel({
  catalog,
  isPending,
  providers,
  settings,
}: {
  catalog: AssistantProviderOption[];
  isPending: boolean;
  providers: AssistantProviderSummary[];
  settings: AssistantProviderSettings | null;
}) {
  const queryClient = useQueryClient();
  const provider = providers[0] ?? null;
  const providerId = catalog[0]?.id ?? "beam-ai";
  const [model, setModel] = useState(settings?.model ?? "");
  useEffect(() => {
    setModel(settings?.model ?? "");
  }, [settings?.model]);
  const selectedOption =
    catalog.find((option) => option.id === providerId) ?? null;
  const hasStoredSettings = providerId === settings?.providerId;
  const modelsQuery = useQuery({
    queryKey: ["/studio/ai/models", providerId, settings?.providerId],
    queryFn: () =>
      apiGet<{ models: AssistantModelOption[] }>("/studio/ai/models"),
    enabled: hasStoredSettings,
    retry: false,
    staleTime: Infinity,
  });
  const discoverModelsMutation = useMutation({
    mutationFn: () =>
      hasStoredSettings
        ? apiSend<{ models: AssistantModelOption[] }>(
            "POST",
            "/studio/ai/models/refresh",
            {},
          )
        : apiSend<{ models: AssistantModelOption[] }>(
            "POST",
            "/studio/ai/models/discover",
            {},
          ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/studio/ai/models"] }),
  });
  useEffect(() => {
    discoverModelsMutation.reset();
  }, [settings?.baseUrl, settings?.model, settings?.providerId]);
  const saveMutation = useMutation({
    mutationFn: () =>
      apiSend("PATCH", "/studio/ai/settings", {
        model,
        models: discoverModelsMutation.data?.models ?? modelsQuery.data?.models,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/studio/settings"] }),
        queryClient.invalidateQueries({ queryKey: ["/studio/ai/providers"] }),
        queryClient.invalidateQueries({ queryKey: ["/studio/ai/models"] }),
      ]);
    },
  });
  const testMutation = useMutation({
    mutationFn: () =>
      apiSend<Record<string, unknown>>("POST", "/studio/ai/providers/test", {
        model,
      }),
  });
  const status = provider?.status ?? "missing_model";
  const testResult = testMutation.data;
  const testOk = testResult?.ok === true;
  const modelOptions =
    discoverModelsMutation.data?.models ?? modelsQuery.data?.models ?? [];
  const selectableModels =
    model && !modelOptions.some((option) => option.id === model)
      ? [{ id: model, name: model }, ...modelOptions]
      : modelOptions;
  const settingsDirty =
    providerId !== settings?.providerId || model !== settings?.model;

  return (
    <SettingsPanel
      action={
        <div className="flex items-center gap-2">
          {testMutation.error ? (
            <span className="text-xs text-destructive">
              {String(testMutation.error)}
            </span>
          ) : testResult ? (
            <Badge
              className={badgeTone(testOk ? "success" : "warning")}
              variant="outline"
            >
              {testOk ? "Connection OK" : formatValue(testResult.error)}
            </Badge>
          ) : null}
          <Button
            disabled={
              isPending ||
              testMutation.isPending ||
              saveMutation.isPending ||
              settingsDirty ||
              status !== "ready"
            }
            onClick={() => testMutation.mutate()}
            size="sm"
            type="button"
            variant="secondary"
          >
            <Send className="h-4 w-4" />
            {testMutation.isPending ? "Testing" : "Test"}
          </Button>
        </div>
      }
      description="Choose a model from BEAM AI. Access is authenticated with your Beam session and billed to the selected organization."
      title="BEAM AI"
    >
      {isPending ? (
        <ItemList isPending items={[]} />
      ) : (
        <div className="grid gap-4">
          {selectedOption?.description ? (
            <p className="text-sm text-muted-foreground">
              {selectedOption.description}
            </p>
          ) : null}

          <label className="grid gap-1.5 text-sm">
            <span className="flex items-center justify-between gap-3">
              <span className="font-medium">Model</span>
              <Button
                disabled={discoverModelsMutation.isPending}
                onClick={() => discoverModelsMutation.mutate()}
                size="sm"
                type="button"
                variant="secondary"
              >
                {discoverModelsMutation.isPending
                  ? "Loading…"
                  : hasStoredSettings
                    ? "Refresh models"
                    : "Load models"}
              </Button>
            </span>
            <AssistantModelSelector
              disabled={!selectableModels.length}
              emptyLabel="Load models to choose one"
              models={selectableModels}
              onChange={setModel}
              placeholder={
                modelsQuery.isPending || discoverModelsMutation.isPending
                  ? "Loading models…"
                  : "Load models, then choose one"
              }
              providerId={providerId}
              value={model}
            />
            <span className="text-xs text-muted-foreground">
              This model is used everywhere: chat, copilot, and operation plans.
            </span>
          </label>

          {modelsQuery.isError || discoverModelsMutation.error ? (
            <p className="text-xs text-muted-foreground">
              Could not load the BEAM AI model catalog. Check your Beam session
              and selected organization.
            </p>
          ) : null}
          {saveMutation.error ? (
            <p className="text-sm text-destructive">
              {String(saveMutation.error)}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3 border-t pt-4">
            <Badge
              className={badgeTone(status === "ready" ? "success" : "warning")}
              variant="outline"
            >
              {status}
            </Badge>
            <Button
              disabled={saveMutation.isPending || !providerId || !model}
              onClick={() => saveMutation.mutate()}
              type="button"
            >
              {saveMutation.isPending ? "Saving…" : "Save BEAM AI settings"}
            </Button>
          </div>
        </div>
      )}
    </SettingsPanel>
  );
}

type SettingsPayload = {
  appName?: string;
  organizationId?: string;
  dataStore?: SettingsDataStore;
  beam?: SettingsBeam;
  assistant?: SettingsAssistant;
  runtime?: SettingsRuntime;
  summary?: Record<string, unknown>;
};

type SettingsDataStore = {
  engine?: string;
  mode?: string;
  status?: string;
  source?: string;
  connectionUrl?: string | null;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  user?: string | null;
  currentDatabase?: string | null;
  currentUser?: string | null;
  serverAddress?: string | null;
  serverPort?: number | null;
  serverVersion?: string | null;
  error?: string | null;
};

type SettingsBeam = {
  defaultBaseUrl?: string;
  defaultCoordinatorUrl?: string;
  defaultNatsUrl?: string;
  authUrl?: string;
  consoleUrl?: string;
  adminUrl?: string;
  apiUrl?: string;
  studioUrl?: string;
  serverOptions?: string[];
  environments?: BeamEnvironmentSettingsPayload;
};

type SettingsRuntime = {
  authPortal?: string;
  secureCookies?: boolean;
  devSettingsEnabled?: boolean;
};

type SettingsAssistant = {
  catalog?: AssistantProviderOption[];
  providers?: AssistantProviderSummary[];
  settings?: AssistantProviderSettings | null;
};

type SettingsItem = {
  label: string;
  value: unknown;
  code?: boolean;
  href?: string;
  badgeTone?: "success" | "warning" | "destructive" | "muted";
};

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: HeaderAction[];
  children?: ReactNode;
}) {
  const hasActions = Boolean(actions?.length || children);

  return (
    <PageSectionHeader className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {hasActions ? (
        <div className="flex flex-wrap justify-end gap-2">
          {actions?.map((action) => {
            const Icon = action.icon;
            return action.to ? (
              <Button
                asChild
                disabled={action.disabled}
                key={`${action.to}:${action.label}`}
                size="sm"
                type="button"
                variant={action.variant ?? "secondary"}
              >
                <Link to={action.to as never}>
                  <Icon className="h-4 w-4" />
                  {action.label}
                </Link>
              </Button>
            ) : (
              <Button
                disabled={action.disabled}
                key={action.label}
                onClick={action.onClick}
                size="sm"
                type="button"
                variant={action.variant ?? "secondary"}
              >
                <Icon className="h-4 w-4" />
                {action.label}
              </Button>
            );
          })}
          {children}
        </div>
      ) : null}
    </PageSectionHeader>
  );
}

function HeaderActionButton({ action }: { action: HeaderAction }) {
  const Icon = action.icon;

  return action.to ? (
    <Button
      asChild
      disabled={action.disabled}
      size="sm"
      type="button"
      variant={action.variant ?? "secondary"}
    >
      <Link to={action.to as never}>
        <Icon className="h-4 w-4" />
        {action.label}
      </Link>
    </Button>
  ) : (
    <Button
      disabled={action.disabled}
      onClick={action.onClick}
      size="sm"
      type="button"
      variant={action.variant ?? "secondary"}
    >
      <Icon className="h-4 w-4" />
      {action.label}
    </Button>
  );
}

function actionKey(action: HeaderAction) {
  return `${action.to ?? action.label}:${action.label}`;
}

export const manageWorkflowsHeaderAction: HeaderAction = {
  label: "Manage workflows",
  to: "/workflows",
  icon: GitBranch,
  variant: "secondary",
};

export const manageCredentialsHeaderAction: HeaderAction = {
  label: "Manage credentials",
  to: "/credentials",
  icon: ShieldCheck,
  variant: "outline",
};

function ResourceFilters({
  filter,
  isPending,
  totalCount,
  visibleCount,
  onFilterChange,
}: {
  filter: string;
  isPending: boolean;
  totalCount: number;
  visibleCount: number;
  onFilterChange(value: string): void;
}) {
  return (
    <FilterBar>
      <SearchInput
        placeholder="Search records..."
        value={filter}
        onChange={onFilterChange}
      />
      <ResultCounter
        isPending={isPending}
        totalCount={totalCount}
        visibleCount={visibleCount}
      />
    </FilterBar>
  );
}

/**
 * Filter-bar primitives shared by every table page, per
 * docs/studio-table-pages-standard.md: search first, then selects, then the
 * visible/total counter.
 */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function SearchInput({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label className="relative min-w-64 flex-1">
      <span className="sr-only">{placeholder}</span>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        className="h-10 w-full rounded-control border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

export function FilterSelect({
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

export function ResultCounter({
  isPending,
  totalCount,
  visibleCount,
}: {
  isPending?: boolean;
  totalCount: number;
  visibleCount: number;
}) {
  return (
    <div className="flex h-10 items-center gap-2 rounded-control border bg-background px-3 text-sm">
      <span className="text-muted-foreground">Showing</span>
      <span className="font-medium tabular-nums">
        {isPending ? "..." : `${visibleCount}/${totalCount}`}
      </span>
    </div>
  );
}

function CreateDialog({
  config,
  open,
  onCreated,
  onOpenChange,
}: {
  config: NonNullable<ResourcePageProps["create"]>;
  open: boolean;
  onCreated(result: Record<string, unknown>): void;
  onOpenChange(open: boolean): void;
}) {
  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiSend<Record<string, unknown>>("POST", config.endpoint, data),
    gcTime: 0,
    onSuccess: (result) => {
      onCreated(result);
      mutation.reset();
    },
  });
  const defaults = Object.fromEntries(
    config.fields.map((field) => [field.name, field.defaultValue ?? ""]),
  );
  const form = useForm({
    defaultValues: defaults,
    onSubmit: ({ value }) => mutation.mutate(value),
  });

  useEffect(() => {
    if (open) {
      form.reset();
    }
  }, [form, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>
            Fill in the required fields, then save the record.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <div className="grid gap-4 md:grid-cols-2">
            {config.fields.map((field) => (
              <form.Field key={field.name} name={field.name}>
                {(fieldApi) => (
                  <label className="grid gap-2 text-sm">
                    {field.label}
                    {field.type === "checkbox" ? (
                      <input
                        checked={Boolean(fieldApi.state.value)}
                        className="h-5 w-5"
                        onChange={(event) =>
                          fieldApi.handleChange(event.target.checked)
                        }
                        type="checkbox"
                      />
                    ) : field.type === "textarea" || field.type === "json" ? (
                      <textarea
                        className="min-h-24 rounded-control border bg-background px-3 py-2 font-mono text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring md:col-span-2"
                        onChange={(event) => {
                          const value = event.target.value;
                          fieldApi.handleChange(
                            field.type === "json" ? parseJson(value) : value,
                          );
                        }}
                        placeholder={field.placeholder}
                        value={
                          typeof fieldApi.state.value === "string"
                            ? fieldApi.state.value
                            : JSON.stringify(
                                fieldApi.state.value ?? {},
                                null,
                                2,
                              )
                        }
                      />
                    ) : (
                      <input
                        className="h-10 rounded-control border bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        onChange={(event) =>
                          fieldApi.handleChange(event.target.value)
                        }
                        placeholder={field.placeholder}
                        value={String(fieldApi.state.value ?? "")}
                      />
                    )}
                  </label>
                )}
              </form.Field>
            ))}
          </div>
          {mutation.error ? (
            <p className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {String(mutation.error)}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={mutation.isPending} type="submit">
              <Send className="h-4 w-4" />
              {mutation.isPending ? "Saving" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DataTable({
  rows,
  columns,
  detailPath,
  actions,
  actionPending,
  onAction,
}: {
  rows: Record<string, unknown>[];
  columns?: DataColumn[];
  detailPath?: (row: Record<string, unknown>) => string;
  actions: RowAction[];
  actionPending?: boolean;
  onAction?: (
    action: RowAction,
    row: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
}) {
  const tableColumns: DataColumn[] = columns?.length
    ? columns
    : defaultColumns(rows);

  if (!rows.length) {
    return (
      <EmptyState description="No records to display." title="No records" />
    );
  }

  return (
    <div className="overflow-hidden rounded-control border bg-card">
      <div className="divide-y">
        {rows.map((row, index) => (
          <DataListRow
            actionPending={actionPending}
            actions={actions}
            columns={tableColumns}
            detailPath={detailPath}
            key={String(row.id ?? row.runId ?? row.name ?? index)}
            row={row}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

function DataListRow({
  actionPending,
  actions,
  columns,
  detailPath,
  row,
  onAction,
}: {
  actionPending?: boolean;
  actions: RowAction[];
  columns: DataColumn[];
  detailPath?: (row: Record<string, unknown>) => string;
  row: Record<string, unknown>;
  onAction?: (
    action: RowAction,
    row: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
}) {
  const identityColumn = identityColumnFor(row, columns);
  const secondaryColumns = columns
    .filter((column) => column.key !== identityColumn.key)
    .slice(0, 3);
  const description = rowDescription(row, identityColumn.key);

  return (
    <div className="grid min-h-14 grid-cols-[minmax(220px,1fr)_160px_140px_140px_140px] items-center gap-4 px-3 py-3 text-sm transition-colors hover:bg-secondary/60 max-xl:grid-cols-[minmax(220px,1fr)_150px_130px_140px] max-lg:grid-cols-[minmax(0,1fr)_110px_96px]">
      <div className="min-w-0">
        <div className="truncate font-medium">
          {renderColumn(identityColumn, row)}
        </div>
        {description ? (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      <DataCell column={secondaryColumns[0]} row={row} />
      <DataCell
        className="max-lg:hidden"
        column={secondaryColumns[1]}
        row={row}
      />
      <DataCell
        className="max-xl:hidden"
        column={secondaryColumns[2]}
        row={row}
      />
      <div className="flex items-center justify-end gap-2">
        {detailPath ? (
          <Button
            asChild
            size="icon"
            title="Open"
            type="button"
            variant="outline"
          >
            <Link aria-label="Open record" to={detailPath(row) as never}>
              <ExternalLink className="h-4 w-4" />
            </Link>
          </Button>
        ) : null}
        {actions.map((action) => {
          const destructive = action.method === "DELETE";
          const Icon = destructive ? Trash2 : RefreshCw;

          const actionButton = (
            <Button
              aria-label={action.label}
              disabled={actionPending}
              size="icon"
              title={action.label}
              type="button"
              variant={destructive ? "outline" : "secondary"}
            >
              <Icon className="h-4 w-4" />
            </Button>
          );

          return action.confirm ? (
            <ConfirmationDialog
              confirmLabel={action.label}
              description={action.confirm}
              key={action.label}
              onConfirm={() => onAction?.(action, row)}
              title={`${action.label}?`}
              trigger={actionButton}
            />
          ) : (
            <Button
              aria-label={action.label}
              disabled={actionPending}
              key={action.label}
              onClick={() => onAction?.(action, row)}
              size="icon"
              title={action.label}
              type="button"
              variant={destructive ? "outline" : "secondary"}
            >
              <Icon className="h-4 w-4" />
            </Button>
          );
        })}
        {!detailPath && !actions.length ? (
          <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
        ) : null}
      </div>
    </div>
  );
}

function DataCell({
  className,
  column,
  row,
}: {
  className?: string;
  column?: DataColumn;
  row: Record<string, unknown>;
}) {
  if (!column) {
    return <span className={cn("truncate text-muted-foreground", className)} />;
  }

  const value = row[column.key];
  const status = isStatusColumn(column.key);

  return (
    <span className={cn("min-w-0 truncate text-muted-foreground", className)}>
      {status ? (
        <span className="flex min-w-0 items-center gap-2 text-foreground">
          <Circle
            className={cn(
              "h-2.5 w-2.5 shrink-0 fill-current",
              statusColor(value),
            )}
          />
          <span className="truncate">{statusLabel(value)}</span>
        </span>
      ) : (
        renderColumn(column, row)
      )}
    </span>
  );
}

function badgeTone(tone: SettingsItem["badgeTone"]) {
  switch (tone) {
    case "success":
      return "border-success/30 bg-success/10 text-success";
    case "warning":
      return "border-warning/30 bg-warning/10 text-warning";
    case "destructive":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

function dotTone(tone: SettingsItem["badgeTone"]) {
  switch (tone) {
    case "success":
      return "bg-success";
    case "warning":
      return "bg-warning";
    case "destructive":
      return "bg-destructive";
    default:
      return "bg-muted-foreground";
  }
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-control bg-muted", className)} />
  );
}

/**
 * Status dot for table rows, per docs/studio-table-pages-standard.md: green for
 * a successful terminal state, grey for never-run/inactive, amber for pending or
 * in-flight, destructive only for real failures.
 */
const runningStatuses = [
  "running",
  "in_progress",
  "in-progress",
  "processing",
  "started",
  "starting",
  "queued",
];

export function StatusDot({ status }: { status: string }) {
  const normalized = status.trim().toLowerCase();
  const running = runningStatuses.includes(normalized);
  const tone =
    normalized === "completed" || normalized === "success"
      ? "text-success"
      : ["failed", "dead_letter", "error"].includes(normalized)
        ? "text-destructive"
        : [
              "never",
              "",
              "cancelled",
              "skipped",
              "disabled",
              "inactive",
            ].includes(normalized)
          ? "text-muted-foreground"
          : running
            ? "text-running"
            : "text-warning";
  const label =
    normalized === "never" || !normalized ? "Never run" : titleCase(normalized);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Circle
        className={cn(
          "h-2.5 w-2.5 shrink-0 fill-current",
          tone,
          running && "status-live",
        )}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-control border bg-card">
      <div className="divide-y">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            className="flex min-h-14 items-center gap-4 px-3 py-3"
            key={index}
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-3.5 w-20 max-lg:hidden" />
            <Skeleton className="h-3.5 w-16 max-lg:hidden" />
            <Skeleton className="h-8 w-8 shrink-0 rounded-control" />
          </div>
        ))}
      </div>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[70vh] overflow-auto rounded-control bg-muted p-4 text-xs">
      {JSON.stringify(value ?? {}, null, 2)}
    </pre>
  );
}

function numberValue(value: unknown) {
  const numeric = Number(value ?? 0);

  return Number.isFinite(numeric) ? numeric : 0;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
}

function defaultColumns(rows: Record<string, unknown>[]) {
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const visibleKeys = keys
    .filter((key) => !hiddenByDefaultKeys.has(key))
    .sort((left, right) => columnPriority(left) - columnPriority(right))
    .slice(0, 5);

  return visibleKeys.map((key) => ({ key }));
}

function identityColumnFor(
  row: Record<string, unknown>,
  columns: DataColumn[],
) {
  const identityKey = [
    "name",
    "displayName",
    "title",
    "transferName",
    "packageName",
    "id",
    "runId",
  ].find((key) => key in row);

  return (
    columns.find((column) => column.key === identityKey) ??
    columns[0] ?? { key: "id" }
  );
}

function rowDescription(row: Record<string, unknown>, identityKey: string) {
  const descriptionKey = [
    "description",
    "id",
    "runId",
    "target",
    "error",
    "reason",
  ].find((key) => key !== identityKey && textValue(row[key]));

  return descriptionKey ? textValue(row[descriptionKey]) : "";
}

function renderColumn(column: DataColumn, row: Record<string, unknown>) {
  return column.render
    ? column.render(row[column.key], row)
    : formatValue(row[column.key]);
}

const hiddenByDefaultKeys = new Set([
  "organizationId",
  "organizationName",
  "description",
  "encryptedPayload",
  "payload",
  "headersJson",
]);

function columnPriority(key: string) {
  const priority = [
    "name",
    "displayName",
    "title",
    "transferName",
    "packageName",
    "status",
    "state",
    "enabled",
    "kind",
    "source",
    "frequency",
    "attempts",
    "runCount",
    "updatedAt",
    "createdAt",
  ];
  const index = priority.indexOf(key);

  return index === -1 ? priority.length : index;
}

function isStatusColumn(key: string) {
  return ["status", "state", "enabled", "revokedAt"].includes(key);
}

function statusColor(value: unknown) {
  const normalized = String(value ?? "").toLowerCase();
  if (
    normalized === "true" ||
    normalized === "active" ||
    normalized === "completed" ||
    normalized === "success" ||
    normalized === "verified"
  ) {
    return "text-success";
  }
  if (
    normalized === "false" ||
    normalized === "inactive" ||
    normalized === "paused" ||
    normalized === "never" ||
    normalized === ""
  ) {
    return "text-muted-foreground";
  }
  if (
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "error" ||
    normalized === "revoked"
  ) {
    return "text-destructive";
  }
  if (runningStatuses.includes(normalized)) {
    return "text-running";
  }

  return "text-warning";
}

function statusLabel(value: unknown) {
  if (typeof value === "boolean") {
    return value ? "Enabled" : "Disabled";
  }

  return titleCase(String(value ?? "Inactive"));
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "string" && isIsoDate(value)) {
    return formatDate(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) || /^\d{4}-\d{2}-\d{2} /.test(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(date);
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
