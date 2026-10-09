import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  Boxes,
  Braces,
  Check,
  Clipboard,
  Code2,
  FileText,
  GitBranch,
  History,
  PackageSearch,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/data-page";
import { PageSectionHeader } from "@/components/header-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { actionReadmes } from "@/features/registry/action-readmes";
import { MarkdownContent } from "@/features/registry/markdown";
import type {
  RegistryData,
  RegistryPackage,
} from "@/features/registry/registry-data";
import {
  compareRegistryManifests,
  mergeRegistryPackages,
  registryIdentityConflictMessage,
  registryPackageStates,
  registryPackageNameFromParams,
  registryRepositoryLink,
  shortDate,
  titleCase,
} from "@/features/registry/registry-data";
import { ApiError } from "@/lib/api-errors";
import { apiGet } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type JsonRecord = Record<string, unknown>;

type SectionId =
  | "overview"
  | "documentation"
  | "schema"
  | "security"
  | "releases"
  | "manifest";

export const Route: any = createFileRoute("/registry_/$scope/$name")({
  component: () => (
    <AppShell contentClassName="px-0 py-0">
      <RegistryPackagePage />
    </AppShell>
  ),
});

function RegistryPackagePage() {
  const { scope, name } = Route.useParams() as { scope: string; name: string };
  const packageName = registryPackageNameFromParams(scope, name);
  const { data, isPending, error } = useQuery({
    queryKey: ["/studio/registry"],
    queryFn: () => apiGet<RegistryData>("/studio/registry"),
  });
  const publicQuery = useQuery({
    queryKey: ["/studio/registry/public"],
    queryFn: () => apiGet<RegistryData>("/studio/registry/public"),
  });
  const item = useMemo(
    () =>
      mergeRegistryPackages(
        data?.packages ?? [],
        publicQuery.data?.packages ?? [],
      ).find((pkg) => pkg.packageName === packageName),
    [data?.packages, packageName, publicQuery.data?.packages],
  );

  if (error) {
    return (
      <RegistryMessage
        description={registryErrorMessage(error)}
        title="Registry package unavailable"
      />
    );
  }

  if (isPending) {
    return (
      <RegistryMessage
        description="Loading action manifest and package metadata..."
        title={packageName}
      />
    );
  }

  if (!item) {
    return (
      <RegistryMessage
        description={
          publicQuery.error
            ? `Public Registry unavailable. ${registryErrorMessage(publicQuery.error)}`
            : "This action package is not present in the current registry."
        }
        title={packageName}
      />
    );
  }

  return <RegistryPackageDetail item={item} />;
}

export function RegistryPackageDetail({
  item,
  layout = "page",
  onBack,
}: {
  item: RegistryPackage;
  layout?: "page" | "panel";
  onBack?: () => void;
}) {
  const manifest = recordValue(item.latestManifest);
  const catalog = recordValue(manifest.catalog);
  const execution = recordValue(manifest.execution);
  const runtime = recordValue(manifest.runtime);
  const configSchema = recordValue(manifest.configSchema);
  const requiredConfig = new Set(stringArray(configSchema.required));
  const configFields = schemaEntries(configSchema.properties);
  const inputFields = schemaEntries(manifest.inputs);
  const outputFields = schemaEntries(manifest.outputs);
  const changelog = changelogEntries(catalog.changelog);
  const credentialRequirements = credentialRequirementNames(
    catalog.credentialRequirements,
  );
  const permissions = item.permissions ?? [];
  const placements = item.placements ?? [];
  const readme = actionReadmes[item.packageName];
  const workflowSnippet = JSON.stringify(
    {
      actionPackageName: item.packageName,
      actionVersionRange: item.latestVersion
        ? `^${item.latestVersion}`
        : "latest",
      config: {},
      inputBindings: {},
    },
    null,
    2,
  );
  const states = registryPackageStates(item);
  const conflictMessage = registryIdentityConflictMessage(item);
  const manifestDifferences = compareRegistryManifests(item);
  const repository = registryRepositoryLink(item.repository);

  const sections: Array<{
    id: SectionId;
    label: string;
    icon: LucideIcon;
    count?: number;
    available: boolean;
  }> = [
    { id: "overview", label: "Overview", icon: Boxes, available: true },
    {
      id: "documentation",
      label: "Documentation",
      icon: FileText,
      available: Boolean(readme),
    },
    {
      id: "schema",
      label: "Schema",
      icon: Braces,
      count: configFields.length + inputFields.length + outputFields.length,
      available: true,
    },
    {
      id: "security",
      label: "Security",
      icon: ShieldCheck,
      count: permissions.length + placements.length,
      available: true,
    },
    {
      id: "releases",
      label: "Releases",
      icon: History,
      count: changelog.length || undefined,
      available: true,
    },
    { id: "manifest", label: "Manifest", icon: Code2, available: true },
  ];
  const visibleSections = sections.filter((section) => section.available);
  const [active, setActive] = useState<SectionId>("overview");
  const activeSection = visibleSections.some((section) => section.id === active)
    ? active
    : "overview";

  return (
    <div
      className={cn(
        "flex w-full flex-col",
        layout === "page" && "mx-auto max-w-5xl",
      )}
    >
      {layout === "page" ? (
        <div className="px-4 pt-4">
          <Button asChild className="w-fit -ml-2" size="sm" variant="ghost">
            <Link to="/registry">
              <ArrowLeft className="size-4" />
              Registry
            </Link>
          </Button>
        </div>
      ) : onBack ? (
        <div className="px-4 pt-4 lg:hidden">
          <Button
            className="w-fit -ml-2"
            onClick={onBack}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft className="size-4" />
            Back to list
          </Button>
        </div>
      ) : null}

      <PageSectionHeader className="grid gap-4 px-4 pt-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {item.displayName}
              </h1>
              <Badge variant="secondary">
                v{item.latestVersion ?? "latest"}
              </Badge>
            </div>
            <code className="inline-block break-all rounded-control-compact bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
              {item.packageName}
            </code>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {item.description ?? "Action package manifest."}
            </p>
            {repository ? (
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                <GitBranch className="size-4 shrink-0" />
                <a
                  className="break-all font-medium text-foreground underline-offset-4 hover:underline"
                  href={repository.href}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                >
                  {repository.label}
                </a>
                {repository.directory ? (
                  <code className="break-all rounded-control-compact bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {repository.directory}
                  </code>
                ) : null}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{titleCase(item.trustLevel)}</Badge>
          <Badge variant="outline">{titleCase(item.status)}</Badge>
          {item.latestValidationStatus ? (
            <Badge variant="outline">
              {titleCase(item.latestValidationStatus)}
            </Badge>
          ) : null}
          {item.latestVersionStatus &&
          item.latestVersionStatus !== item.status ? (
            <Badge variant="outline">
              Version {titleCase(item.latestVersionStatus)}
            </Badge>
          ) : null}
          {states.map((state) => (
            <Badge
              className={cn(
                state.tone === "danger" &&
                  "border-red-300 bg-red-50 text-red-800",
                state.tone === "warning" &&
                  "border-amber-300 bg-amber-50 text-amber-900",
                state.tone === "success" &&
                  "border-success/30 bg-success/10 text-success",
              )}
              key={state.id}
              variant="outline"
            >
              {state.label}
            </Badge>
          ))}
          {item.tags?.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
        {conflictMessage ? (
          <p className="max-w-2xl rounded-control border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {conflictMessage}
          </p>
        ) : null}
      </PageSectionHeader>

      <nav className="sticky top-0 z-10 -mb-px flex gap-1 overflow-x-auto border-b bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        {visibleSections.map((section) => {
          const Icon = section.icon;
          const isActive = section.id === activeSection;

          return (
            <button
              className={cn(
                "flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              key={section.id}
              onClick={() => setActive(section.id)}
              type="button"
            >
              <Icon className="size-4" />
              {section.label}
              {section.count ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[11px] leading-5",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {section.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="px-4 py-6">
        {activeSection === "overview" ? (
          <OverviewSection
            catalog={catalog}
            execution={execution}
            item={item}
            manifest={manifest}
            permissions={permissions}
            placements={placements}
            runtime={runtime}
            manifestDifferences={manifestDifferences}
            workflowSnippet={workflowSnippet}
          />
        ) : null}

        {activeSection === "documentation" && readme ? (
          <Section
            description="Author-provided guidance shipped with this action package."
            title="README"
          >
            <MarkdownContent value={readme} />
          </Section>
        ) : null}

        {activeSection === "schema" ? (
          <div className="grid gap-10">
            <Section
              description="Static settings supplied when the action is placed in a workflow."
              title="Configuration"
            >
              <SchemaList
                emptyLabel="No config fields declared."
                entries={configFields}
                required={requiredConfig}
              />
            </Section>
            <Section
              description="Values this action reads at runtime."
              title="Inputs"
            >
              <SchemaList
                emptyLabel="No inputs declared."
                entries={inputFields}
              />
            </Section>
            <Section
              description="Values this action produces for downstream steps."
              title="Outputs"
            >
              <SchemaList
                emptyLabel="No outputs declared."
                entries={outputFields}
              />
            </Section>
          </div>
        ) : null}

        {activeSection === "security" ? (
          <div className="grid gap-10">
            <Section
              description="Capabilities the worker grants this action at runtime."
              title="Permissions"
            >
              <BadgeList
                emptyLabel="No permissions declared."
                items={permissions}
              />
            </Section>
            <Section
              description="Execution environments where this action can run."
              title="Placements"
            >
              <BadgeList
                emptyLabel="No placements declared."
                items={placements}
              />
            </Section>
            <Section
              description="Credentials the action expects to be provisioned."
              title="Credential requirements"
            >
              <BadgeList
                emptyLabel="No credential requirements declared."
                items={credentialRequirements}
              />
            </Section>
            <Section
              description="Security notices returned by the Actions Registry."
              title="Advisories"
            >
              <AdvisoryList advisories={item.advisories ?? []} />
            </Section>
          </div>
        ) : null}

        {activeSection === "releases" ? (
          <div className="grid gap-10">
            <Section
              description="Version history for this action package."
              title="Changelog"
            >
              {changelog.length ? (
                <ol className="grid gap-5 border-l pl-5">
                  {changelog.map((entry) => (
                    <li className="relative grid gap-1" key={entry.version}>
                      <span className="absolute -left-[1.4375rem] top-1.5 size-2 rounded-full bg-primary" />
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{entry.version}</span>
                        {entry.date ? (
                          <span className="text-xs text-muted-foreground">
                            {entry.date}
                          </span>
                        ) : null}
                      </div>
                      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                        {entry.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyHint>No changelog entries declared.</EmptyHint>
              )}
            </Section>
            <Section
              description="Artifact distribution and storage metadata."
              title="Distribution"
            >
              <FactList
                items={[
                  ["Checksum", item.latestArtifactChecksum ?? "-", true],
                  [
                    "Artifact reference",
                    item.latestArtifactReference ?? "-",
                    true,
                  ],
                  [
                    "Source registry",
                    item.latestSourceRegistry ?? "local-registry",
                    true,
                  ],
                  ["Hippius bucket", item.latestHippiusBucket ?? "-", true],
                  ["Hippius key", item.latestHippiusKey ?? "-", true],
                  ["Category", item.category ?? "-"],
                  ["Versions", String(item.versionCount)],
                ]}
              />
            </Section>
          </div>
        ) : null}

        {activeSection === "manifest" ? (
          <Section
            action={<CopyButton label="manifest" value={rawManifest(item)} />}
            description="The complete manifest resolved for the latest version."
            title="Raw JSON"
          >
            <CodeBlock>{rawManifest(item)}</CodeBlock>
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function OverviewSection({
  catalog,
  execution,
  item,
  manifest,
  permissions,
  placements,
  runtime,
  manifestDifferences,
  workflowSnippet,
}: {
  catalog: JsonRecord;
  execution: JsonRecord;
  item: RegistryPackage;
  manifest: JsonRecord;
  permissions: string[];
  placements: string[];
  runtime: JsonRecord;
  manifestDifferences: ReturnType<typeof compareRegistryManifests>;
  workflowSnippet: string;
}) {
  return (
    <div className="grid gap-10">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={ShieldCheck}
          label="Trust"
          value={titleCase(item.trustLevel)}
        />
        <StatTile
          icon={PackageSearch}
          label="Placements"
          value={placements.length || "-"}
        />
        <StatTile
          icon={ShieldCheck}
          label="Permissions"
          value={permissions.length || "-"}
        />
        <StatTile icon={Boxes} label="Versions" value={item.versionCount} />
      </div>

      <Section
        description="Identity and execution metadata for the latest version."
        title="Details"
      >
        <FactList
          items={[
            ["Package", item.packageName, true],
            [
              "Author",
              stringValue(manifest.author) ??
                stringValue(catalog.owner) ??
                "Beam",
            ],
            [
              "Category",
              stringValue(catalog.category) ?? item.category ?? "workflow",
            ],
            ["API version", stringValue(manifest.apiVersion) ?? "-"],
            ["Task mode", stringValue(execution.taskMode) ?? "-"],
            [
              "Default placement",
              stringValue(execution.defaultPlacement) ??
                stringValue(runtime.defaultPlacement) ??
                "-",
            ],
            ["Visibility", titleCase(item.visibility)],
            ["Updated", shortDate(item.updatedAt)],
          ]}
        />
      </Section>

      <Section
        description="Exact immutable identities used for installation and workflow locks."
        title="Installed and available identity"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <RegistryIdentityCard
            identity={item.installedIdentity}
            label="Installed"
          />
          <RegistryIdentityCard
            identity={item.availableIdentity}
            label="Available"
          />
        </div>
      </Section>

      {manifestDifferences.length ? (
        <Section
          description="Relevant immutable identity and manifest fields that change in the available version."
          title="Version comparison"
        >
          <div className="overflow-hidden rounded-surface border">
            <div className="grid grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b bg-muted/50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span>Field</span>
              <span>Installed</span>
              <span>Available</span>
            </div>
            {manifestDifferences.map((difference) => (
              <div
                className="grid grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b px-4 py-3 text-xs last:border-b-0"
                key={difference.field}
              >
                <span className="font-medium">{difference.field}</span>
                <pre className="whitespace-pre-wrap break-all font-mono text-muted-foreground">
                  {difference.installed}
                </pre>
                <pre className="whitespace-pre-wrap break-all font-mono">
                  {difference.available}
                </pre>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        action={<CopyButton label="snippet" value={workflowSnippet} />}
        description="Drop this into a workflow definition to reference the action."
        title="Use in a workflow"
      >
        <CodeBlock>{workflowSnippet}</CodeBlock>
      </Section>
    </div>
  );
}

function RegistryIdentityCard({
  identity,
  label,
}: {
  identity: RegistryPackage["installedIdentity"];
  label: string;
}) {
  if (!identity) {
    return (
      <div className="rounded-surface border border-dashed p-4 text-sm text-muted-foreground">
        <div className="font-medium text-foreground">{label}</div>
        <p className="mt-2">No {label.toLowerCase()} version.</p>
      </div>
    );
  }
  return (
    <div className="rounded-surface border p-4">
      <div className="font-medium">{label}</div>
      <FactList
        items={[
          ["Exact version", identity.version, true],
          ["Manifest checksum", identity.manifestChecksum ?? "-", true],
          ["Artifact checksum", identity.artifactChecksum ?? "-", true],
          ["Artifact reference", identity.artifactReference ?? "-", true],
          ["Source", identity.sourceRegistry, true],
          ["Trust", titleCase(identity.trustLevel)],
        ]}
      />
    </div>
  );
}

function AdvisoryList({
  advisories,
}: {
  advisories: NonNullable<RegistryPackage["advisories"]>;
}) {
  if (!advisories.length) {
    return <EmptyHint>No active Registry advisories.</EmptyHint>;
  }
  return (
    <div className="grid gap-3">
      {advisories.map((advisory) => (
        <article
          className={cn(
            "rounded-surface border p-4",
            advisory.blocking
              ? "border-red-300 bg-red-50"
              : "border-amber-300 bg-amber-50",
          )}
          key={advisory.id}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{advisory.title}</span>
            <Badge variant="outline">{titleCase(advisory.severity)}</Badge>
            <Badge variant="outline">{titleCase(advisory.status)}</Badge>
            {advisory.blocking ? (
              <Badge variant="outline">Blocking</Badge>
            ) : null}
          </div>
          {advisory.summary ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {advisory.summary}
            </p>
          ) : null}
          {advisory.patchedVersions?.length ? (
            <p className="mt-2 text-xs">
              Patched versions: {advisory.patchedVersions.join(", ")}
            </p>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function Section({
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
    <section className="grid gap-4">
      <div className="flex items-start justify-between gap-3 border-b pb-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-surface border bg-card p-4">
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 truncate text-2xl font-semibold">{value}</p>
      </div>
      <Icon className="size-5 shrink-0 text-muted-foreground" />
    </div>
  );
}

function FactList({
  items,
}: {
  items: Array<[string, string] | [string, string, boolean]>;
}) {
  return (
    <dl className="grid overflow-hidden rounded-surface border">
      {items.map(([label, value, code], index) => (
        <div
          className={cn(
            "grid gap-1 px-4 py-3 text-sm sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4",
            index % 2 === 1 && "bg-muted/40",
          )}
          key={label}
        >
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">
            {code ? (
              <code className="break-all font-mono text-xs">{value}</code>
            ) : (
              <span className="font-medium">{value}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function BadgeList({
  emptyLabel,
  items,
}: {
  emptyLabel: string;
  items: string[];
}) {
  if (!items.length) {
    return <EmptyHint>{emptyLabel}</EmptyHint>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge className="font-mono text-xs" key={item} variant="outline">
          {item}
        </Badge>
      ))}
    </div>
  );
}

function SchemaList({
  emptyLabel,
  entries,
  required,
}: {
  emptyLabel: string;
  entries: Array<[string, JsonRecord]>;
  required?: Set<string>;
}) {
  if (!entries.length) {
    return <EmptyHint>{emptyLabel}</EmptyHint>;
  }

  return (
    <div className="grid divide-y overflow-hidden rounded-surface border">
      {entries.map(([name, schema]) => (
        <div className="grid gap-1.5 px-4 py-3" key={name}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium">{name}</span>
            <Badge variant="secondary">{schemaType(schema)}</Badge>
            {required?.has(name) ? (
              <Badge variant="outline">required</Badge>
            ) : null}
          </div>
          <div className="text-sm font-medium">
            {stringValue(schema.title) ?? titleCase(name)}
          </div>
          {stringValue(schema.description) ? (
            <p className="text-sm text-muted-foreground">
              {stringValue(schema.description)}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CodeBlock({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        "overflow-auto rounded-surface border bg-muted p-4 text-xs leading-relaxed",
        className,
      )}
    >
      {children}
    </pre>
  );
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <Button onClick={copy} size="sm" type="button" variant="outline">
      {copied ? <Check className="size-4" /> : <Clipboard className="size-4" />}
      {copied ? "Copied" : `Copy ${label}`}
    </Button>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-surface border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function RegistryMessage({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-4">
      <Button asChild className="w-fit -ml-2" size="sm" variant="ghost">
        <Link to="/registry">
          <ArrowLeft className="size-4" />
          Registry
        </Link>
      </Button>
      <PageHeader title={title} description={description} />
    </div>
  );
}

function rawManifest(item: RegistryPackage) {
  return JSON.stringify(item.latestManifest ?? {}, null, 2);
}

function registryErrorMessage(error: unknown) {
  return error instanceof ApiError
    ? [error.message, error.action].filter(Boolean).join(" ")
    : String(error);
}

function schemaEntries(value: unknown): Array<[string, JsonRecord]> {
  return Object.entries(recordValue(value)).map(([key, entry]) => [
    key,
    recordValue(entry),
  ]);
}

function changelogEntries(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => {
        const record = recordValue(entry);
        return {
          version: stringValue(record.version) ?? "unversioned",
          date: stringValue(record.date),
          notes: stringArray(record.notes),
        };
      })
    : [];
}

function schemaType(schema: JsonRecord) {
  const type = stringValue(schema.type) ?? "value";
  const enumValues = stringArray(schema.enum);
  return enumValues.length ? `${type}: ${enumValues.join(", ")}` : type;
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function credentialRequirementNames(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((requirement) => recordValue(requirement).displayName)
        .filter(
          (displayName): displayName is string =>
            typeof displayName === "string" && Boolean(displayName.trim()),
        )
    : [];
}
