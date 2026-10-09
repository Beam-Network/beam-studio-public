import type { InputHTMLAttributes, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  KeyRound,
  Plus,
  SearchX,
  Trash2,
} from "lucide-react";
import {
  nativeProviders as sharedNativeProviders,
  providerProfiles,
  STORAGE_NETWORK_HINT,
  type NativeCredentialTypeId,
  type ProviderProfile,
} from "@beam-studio/shared";
import { AppShell } from "@/components/app-shell";
import { PanelHeader } from "@/components/header-primitives";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/data-page";
import type { CredentialRecord } from "@/features/credentials/credential-grid";
import { showsStorageNetworkHint } from "@/features/credentials/credential-kinds";
import { apiGet, apiSend } from "@/lib/api-client";
import {
  TestResultBanner,
  testCredential,
  type CredentialTestResult,
} from "@/features/credentials/credential-test";
import { cn } from "@/lib/utils";

// Every non-S3 type comes from the shared catalog, so adding a native provider
// there is enough; only the S3-compatible type is named separately, since its
// providers come from provider-profiles.json rather than the catalog.
type CredentialTypeId = NativeCredentialTypeId | "s3_compatible_access_key";

type ProviderCategoryId =
  | "beam"
  | "object-storage"
  | "data-platforms"
  | "apps-integrations"
  | "http-webhooks"
  | "custom";

type CredentialsPayload = {
  credentials?: CredentialRecord[];
};

type ProviderField = {
  name: string;
  label: string;
  defaultChecked?: boolean;
  instruction?: string;
  pattern?: string;
  type?: string;
  required?: boolean;
};

type CredentialProvider = {
  id: string;
  credentialType: CredentialTypeId;
  name: string;
  logo: string;
  description: string;
  fields: ProviderField[];
  endpointTemplate?: string;
};

/** Labels the secret shape behind a provider, shown once the provider is picked. */
const credentialTypeLabels: Record<CredentialTypeId, string> = {
  s3_compatible_access_key: "S3-compatible access key",
  beam_api_key: "Beam API key",
  gcs_service_account: "GCS service account",
  huggingface_token: "Hugging Face Hub token",
  http_bearer_token: "HTTP bearer token",
  zapier_mcp: "Zapier MCP server",
  slack_bot_token: "Slack bot token",
  salesforce_client_credentials: "Salesforce client credentials",
  salesforce_jwt: "Salesforce JWT bearer",
  adobe_aep_oauth_s2s: "Adobe OAuth Server-to-Server",
  snowflake_key_pair: "RSA key pair",
  snowflake_pat: "Programmatic Access Token",
  databricks_oauth_m2m: "OAuth machine-to-machine",
  databricks_pat: "Personal Access Token",
};

/** Pinned to the top of object storage; the remaining providers are alphabetical. */
const popularProviderIds = [
  "s3",
  "r2",
  "gcs",
  "minio",
  "wasabi",
  "backblaze-b2",
];

const customProviderId = "custom-s3";

const fieldLabels: Record<string, string> = {
  access_key_id: "Access key ID",
  account: "Account identifier",
  account_id: "Account ID",
  api_key: "API key",
  api_secret: "API secret",
  api_version: "API version",
  base_url: "Platform API host",
  bucket: "Bucket",
  catalog: "Catalog",
  client_email: "Client email",
  database: "Database",
  client_id: "Consumer key",
  client_secret: "Consumer secret",
  endpoint_url: "Endpoint URL",
  environment: "Beam environment",
  force_path_style: "Force path-style addressing",
  http_path: "SQL warehouse HTTP path",
  instance_url: "Instance URL",
  login_url: "Login URL",
  org_id: "IMS organization ID",
  nats_url: "Beam NATS URL",
  private_key: "Private key",
  private_key_passphrase: "Private key passphrase",
  project_id: "Project ID",
  region: "Region",
  role: "Role",
  sandbox_name: "Sandbox",
  scopes: "Scopes",
  schema: "Schema",
  secret_access_key: "Secret access key",
  session_token: "Session token",
  token: "Access token",
  username: "Integration user",
  warehouse: "Warehouse",
};

const passwordFields = new Set([
  "api_key",
  "api_secret",
  "client_secret",
  "private_key",
  "private_key_passphrase",
  "secret_access_key",
  "session_token",
  "token",
]);

const nativeProviders: CredentialProvider[] = sharedNativeProviders;

const providers = [
  ...providerProfiles.map(profileToProvider),
  ...nativeProviders,
];

const providerCategories: Array<{
  id: ProviderCategoryId;
  title: string;
  description: string;
}> = [
  {
    id: "beam",
    title: "Beam",
    description: "Beam platform access",
  },
  {
    id: "object-storage",
    title: "Object storage",
    description: "Cloud and S3-compatible storage",
  },
  {
    id: "data-platforms",
    title: "Data platforms",
    description: "Warehouses and lakehouses",
  },
  {
    id: "apps-integrations",
    title: "Apps & integrations",
    description: "Business and developer tools",
  },
  {
    id: "http-webhooks",
    title: "HTTP & webhooks",
    description: "Authenticated endpoints",
  },
  {
    id: "custom",
    title: "Custom",
    description: "Configure an endpoint manually",
  },
];

export const Route: any = createFileRoute("/credentials/new")({
  component: NewCredentialPage,
});

function NewCredentialPage() {
  const credentialsQuery = useQuery({
    queryKey: ["/studio/credentials"],
    queryFn: () => apiGet<CredentialsPayload>("/studio/credentials"),
  });

  return (
    <AppShell
      contentClassName="px-3 py-4 lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:overflow-hidden"
      title="New credential"
    >
      <div className="mb-3 lg:shrink-0">
        <Button
          asChild
          className="-ml-2 h-7 px-2"
          size="sm"
          type="button"
          variant="ghost"
        >
          <Link to="/credentials">
            <ArrowLeft size={16} />
            Credentials
          </Link>
        </Button>
      </div>
      <CredentialCreateFlow
        credentials={credentialsQuery.data?.credentials ?? []}
      />
    </AppShell>
  );
}

function CredentialCreateFlow({
  credentials,
}: {
  credentials: CredentialRecord[];
}) {
  const [selectedCategoryId, setSelectedCategoryId] =
    useState<ProviderCategoryId>("beam");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );

  const selectedCategory = providerCategories.find(
    (category) => category.id === selectedCategoryId,
  )!;
  const selectedProvider =
    providers.find((provider) => provider.id === selectedProviderId) ?? null;

  return (
    <div className="mx-auto w-full max-w-[1500px] overflow-hidden rounded-surface border bg-card lg:min-h-0 lg:flex-1">
      <div className="grid lg:h-full lg:min-h-0 lg:grid-cols-[minmax(190px,0.7fr)_minmax(260px,1fr)_minmax(400px,1.8fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
        <CategoryPicker
          selectedCategoryId={selectedCategoryId}
          onSelect={(categoryId) => {
            setSelectedCategoryId(categoryId);
            if (
              selectedProvider &&
              providerCategoryId(selectedProvider) !== categoryId
            ) {
              setSelectedProviderId(null);
            }
          }}
        />

        <ProviderPicker
          key={selectedCategoryId}
          category={selectedCategory}
          credentials={credentials}
          selectedProviderId={selectedProviderId}
          onSelect={setSelectedProviderId}
        />

        <section className="flex min-h-[420px] min-w-0 flex-col bg-background lg:min-h-0 lg:overflow-hidden">
          <ColumnHeader
            description={
              selectedProvider
                ? `Configure ${selectedProvider.name}`
                : "Select a provider to continue"
            }
            title="Details"
          />
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {selectedProvider ? (
              <CredentialForm
                key={selectedProvider.id}
                provider={selectedProvider}
              />
            ) : (
              <div className="grid h-full min-h-64 place-items-center rounded-control border border-dashed p-6 text-center">
                <div className="grid max-w-xs justify-items-center gap-3">
                  <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                    <KeyRound size={20} />
                  </span>
                  <div>
                    <p className="text-sm font-medium">Choose a provider</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Its credential fields will appear here without leaving the
                      page.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function CategoryPicker({
  selectedCategoryId,
  onSelect,
}: {
  selectedCategoryId: ProviderCategoryId;
  onSelect(categoryId: ProviderCategoryId): void;
}) {
  return (
    <section className="flex min-w-0 flex-col border-b bg-muted/20 lg:min-h-0 lg:overflow-hidden lg:border-b-0 lg:border-r">
      <ColumnHeader description="Choose a credential type" title="Categories" />
      <div className="grid min-h-0 content-start gap-1 overflow-y-auto p-2">
        {providerCategories.map((category) => {
          const count = providers.filter(
            (provider) => providerCategoryId(provider) === category.id,
          ).length;
          const selected = category.id === selectedCategoryId;

          return (
            <button
              aria-pressed={selected}
              className={cn(
                "flex items-center gap-3 rounded-control px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                selected &&
                  "bg-primary/10 text-foreground ring-1 ring-inset ring-primary hover:bg-primary/10",
              )}
              key={category.id}
              type="button"
              onClick={() => onSelect(category.id)}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {category.title}
                </span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {category.description}
                </span>
              </span>
              <span
                className={cn(
                  "grid min-w-6 place-items-center rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground",
                  selected && "bg-primary text-primary-foreground",
                )}
              >
                {count}
              </span>
              <ChevronRight
                className={cn(
                  "shrink-0 text-muted-foreground",
                  selected && "text-foreground",
                )}
                size={16}
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ProviderPicker({
  category,
  credentials,
  selectedProviderId,
  onSelect,
}: {
  category: (typeof providerCategories)[number];
  credentials: CredentialRecord[];
  selectedProviderId: string | null;
  onSelect(providerId: string): void;
}) {
  const [search, setSearch] = useState("");

  const credentialCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const credential of credentials) {
      if (credential.kind) {
        counts.set(credential.kind, (counts.get(credential.kind) ?? 0) + 1);
      }
    }
    return counts;
  }, [credentials]);

  const filteredProviders = useMemo(() => {
    const query = search.trim().toLowerCase();
    return providersForCategory(category.id).filter((provider) =>
      [provider.name, provider.id, provider.description]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [category.id, search]);

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-b bg-card lg:overflow-hidden lg:border-b-0 lg:border-r">
      <ColumnHeader
        description={`${providersForCategory(category.id).length} available`}
        title="Providers"
      />
      <div className="border-b p-3">
        <SearchInput
          placeholder={`Search ${category.title.toLowerCase()}`}
          value={search}
          onChange={setSearch}
        />
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-1 overflow-x-hidden overflow-y-auto p-2">
        {filteredProviders.length ? (
          filteredProviders.map((provider) => (
            <ProviderTile
              credentialCount={credentialCounts.get(provider.id) ?? 0}
              key={provider.id}
              provider={provider}
              selected={provider.id === selectedProviderId}
              onSelect={() => onSelect(provider.id)}
            />
          ))
        ) : (
          <div className="grid min-h-48 place-items-center p-4 text-center">
            <div className="grid max-w-56 justify-items-center gap-2 text-muted-foreground">
              <SearchX size={20} />
              <p className="text-sm">No provider matches “{search.trim()}”.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ColumnHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <PanelHeader className="flex-col items-start justify-center gap-0 px-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
    </PanelHeader>
  );
}

function providersForCategory(categoryId: ProviderCategoryId) {
  const popularIndex = new Map(
    popularProviderIds.map((providerId, index) => [providerId, index]),
  );

  return providers
    .filter((provider) => providerCategoryId(provider) === categoryId)
    .sort((left, right) => {
      const leftIndex = popularIndex.get(left.id);
      const rightIndex = popularIndex.get(right.id);
      if (leftIndex !== undefined || rightIndex !== undefined) {
        return (
          (leftIndex ?? Number.MAX_SAFE_INTEGER) -
          (rightIndex ?? Number.MAX_SAFE_INTEGER)
        );
      }
      return left.name.localeCompare(right.name);
    });
}

function providerCategoryId(provider: CredentialProvider): ProviderCategoryId {
  if (provider.id === "beam") {
    return "beam";
  }
  if (provider.id === customProviderId) {
    return "custom";
  }
  if (
    provider.credentialType === "s3_compatible_access_key" ||
    provider.credentialType === "gcs_service_account"
  ) {
    return "object-storage";
  }
  if (
    provider.credentialType.startsWith("snowflake_") ||
    provider.credentialType.startsWith("databricks_")
  ) {
    return "data-platforms";
  }
  if (provider.credentialType === "http_bearer_token") {
    return "http-webhooks";
  }
  return "apps-integrations";
}

function ProviderTile({
  credentialCount,
  provider,
  selected,
  onSelect,
}: {
  credentialCount: number;
  provider: CredentialProvider;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 rounded-control px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        selected &&
          "bg-primary/10 text-foreground ring-1 ring-inset ring-primary hover:bg-primary/10",
      )}
      type="button"
      onClick={onSelect}
    >
      <ProviderLogo provider={provider} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {provider.name}
        </span>
        {credentialCount ? (
          <span className="block text-xs text-muted-foreground">
            {credentialCount} credential{credentialCount > 1 ? "s" : ""}
          </span>
        ) : (
          <span className="block break-words text-xs leading-4 text-muted-foreground">
            {provider.description}
          </span>
        )}
      </span>
      <ChevronRight
        className={cn(
          "shrink-0 text-muted-foreground",
          selected && "text-foreground",
        )}
        size={16}
      />
    </button>
  );
}

function CredentialForm({ provider }: { provider: CredentialProvider }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [buckets, setBuckets] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CredentialTestResult | null>(
    null,
  );
  const allowUntestedRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const runTest = async () => {
    const form = formRef.current;
    if (!form) {
      return;
    }
    const payload = providerPayloadFromForm(new FormData(form));
    setValidationError(null);
    setTestResult(null);
    setTesting(true);
    try {
      setTestResult(
        await testCredential({
          kind: provider.id,
          payload: hasBuckets
            ? { ...payload, buckets, bucket: buckets[0] ?? "" }
            : payload,
          credentialId: null,
        }),
      );
    } catch (error) {
      setTestResult({ status: "error", errorMessage: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  };
  const hasBuckets = provider.credentialType === "s3_compatible_access_key";
  const requiredFields = provider.fields.filter((field) => field.required);
  const optionalFields = provider.fields.filter((field) => !field.required);
  const createCredential = useMutation({
    mutationFn: (input: {
      name: string;
      kind: string;
      payload: Record<string, unknown>;
      allowUntested?: boolean;
    }) => apiSend("POST", "/studio/credentials", input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["/studio/credentials"],
      });
      await navigate({ to: "/credentials" });
    },
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        setValidationError(null);
        createCredential.mutate({
          name: formText(formData, "name"),
          kind: provider.id,
          payload: providerPayloadFromForm(formData),
          // The API tests before writing and refuses a rejected credential;
          // this is the explicit override.
          allowUntested: allowUntestedRef.current,
        });
        allowUntestedRef.current = false;
      }}
      ref={formRef}
    >
      <div className="flex items-center gap-3 rounded-control border bg-card p-4">
        <ProviderLogo provider={provider} />
        <div className="min-w-0 flex-1">
          <strong className="block text-sm">{provider.name}</strong>
          <span className="block truncate text-xs text-muted-foreground">
            {credentialTypeLabels[provider.credentialType]}
          </span>
        </div>
      </div>

      <div className="grid gap-3 rounded-control border bg-card p-4">
        <Field label="Credential name">
          <Input
            name="name"
            placeholder={`${provider.name} production`}
            required
          />
        </Field>
        {requiredFields.map((field) => (
          <ProviderFieldInput field={field} key={field.name} />
        ))}
        {hasBuckets ? (
          <BucketAccessField
            buckets={buckets}
            onChange={(nextBuckets) => {
              setValidationError(null);
              setBuckets(nextBuckets);
            }}
          />
        ) : null}
        {showsStorageNetworkHint(provider.id) ? (
          <p className="text-xs text-muted-foreground">
            {STORAGE_NETWORK_HINT}
          </p>
        ) : null}
      </div>

      {optionalFields.length ? (
        <details className="group rounded-surface border bg-card">
          <summary className="flex cursor-pointer list-none items-center justify-between p-4 text-sm font-medium">
            Advanced options
            <ChevronRight
              className="text-muted-foreground transition-transform group-open:rotate-90"
              size={16}
            />
          </summary>
          <div className="grid gap-3 border-t p-4">
            {provider.endpointTemplate ? (
              <p className="text-xs text-muted-foreground">
                Endpoint defaults to{" "}
                <span className="break-all font-mono">
                  {provider.endpointTemplate}
                </span>
              </p>
            ) : null}
            {optionalFields.map((field) => (
              <ProviderFieldInput field={field} key={field.name} />
            ))}
          </div>
        </details>
      ) : null}

      <input type="hidden" name="kind" value={provider.id} />
      {hasBuckets ? (
        <input
          type="hidden"
          name="payload.buckets"
          value={JSON.stringify(buckets)}
        />
      ) : null}

      {testResult ? <TestResultBanner result={testResult} /> : null}
      {validationError || createCredential.error ? (
        <div className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <p>{validationError ?? errorMessage(createCredential.error)}</p>
          <Button
            className="mt-2"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => {
              allowUntestedRef.current = true;
              formRef.current?.requestSubmit();
            }}
          >
            Save anyway
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 max-sm:justify-start">
        <Button
          disabled={testing || createCredential.isPending}
          type="button"
          variant="outline"
          onClick={runTest}
        >
          {testing ? "Testing..." : "Test connection"}
        </Button>
        <Button disabled={createCredential.isPending || testing} type="submit">
          {createCredential.isPending ? "Saving..." : "Save"}
          <ArrowRight size={16} />
        </Button>
      </div>
    </form>
  );
}

function ProviderFieldInput({ field }: { field: ProviderField }) {
  if (field.type === "checkbox") {
    return (
      <div className="grid gap-2">
        <input type="hidden" name={`payload.${field.name}`} value="false" />
        <CheckField
          defaultChecked={field.defaultChecked}
          label={field.label}
          name={`payload.${field.name}`}
        />
        {field.instruction ? (
          <span className="text-xs text-muted-foreground">
            {field.instruction}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <Field label={field.label}>
      <Input
        name={`payload.${field.name}`}
        pattern={field.pattern}
        required={field.required}
        type={field.type ?? "text"}
      />
      {field.instruction ? (
        <span className="text-xs text-muted-foreground">
          {field.instruction}
        </span>
      ) : null}
    </Field>
  );
}

function ProviderLogo({
  provider,
  size = "md",
}: {
  provider: CredentialProvider;
  size?: "sm" | "md";
}) {
  const [failed, setFailed] = useState(false);
  const box = size === "sm" ? "size-8 p-1.5" : "size-11 p-2";

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-control bg-white",
        box,
      )}
    >
      {failed ? (
        <span className="font-mono text-[10px] uppercase text-muted-foreground">
          {provider.id.slice(0, 2)}
        </span>
      ) : (
        <img
          alt=""
          aria-hidden="true"
          className="max-h-full max-w-full object-contain"
          src={provider.logo}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function BucketAccessField({
  buckets,
  onChange,
}: {
  buckets: string[];
  onChange: (buckets: string[]) => void;
}) {
  const [bucket, setBucket] = useState("");
  const addBucket = () => {
    const value = bucket.trim();
    if (!value || buckets.includes(value)) {
      setBucket("");
      return;
    }
    onChange([...buckets, value]);
    setBucket("");
  };

  return (
    <div className="grid gap-2">
      <span className="text-sm">Buckets</span>
      <div className="flex gap-2 max-sm:grid">
        <Input
          value={bucket}
          placeholder="my-bucket"
          onChange={(event) => setBucket(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addBucket();
            }
          }}
        />
        <Button type="button" variant="outline" onClick={addBucket}>
          <Plus size={16} />
          Bucket
        </Button>
      </div>
      {buckets.length ? (
        <div className="flex flex-wrap gap-2">
          {buckets.map((item) => (
            <span
              className="inline-flex max-w-full items-center gap-2 rounded-control border bg-muted/40 px-2 py-1 text-sm"
              key={item}
            >
              <span className="truncate">{item}</span>
              <button
                aria-label={`Remove ${item}`}
                className="grid size-6 place-items-center rounded-control-compact hover:bg-muted"
                type="button"
                onClick={() =>
                  onChange(buckets.filter((bucketName) => bucketName !== item))
                }
              >
                <Trash2 size={14} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">
          Optional. Saved buckets are tested before the credential is saved.
        </span>
      )}
    </div>
  );
}

async function validateCredentialBuckets(
  provider: string,
  payload: Record<string, unknown>,
  buckets: string[],
) {
  if (!buckets.length) {
    return;
  }

  await apiSend("POST", "/studio/credentials/validate-buckets", {
    provider,
    payload: {
      ...payload,
      buckets,
      bucket: buckets[0] ?? "",
    },
  });
}

function providerPayloadFromForm(formData: FormData) {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("payload.")) {
      continue;
    }

    const fieldName = key.replace("payload.", "");
    const fieldValue = String(value).trim();
    if (!fieldValue) {
      continue;
    }

    if (fieldName === "buckets") {
      payload.buckets = parseBucketList(fieldValue);
      payload.bucket = parseBucketList(fieldValue)[0] ?? "";
      continue;
    }

    payload[fieldName] =
      fieldName === "force_path_style"
        ? ["1", "true", "yes", "on"].includes(fieldValue.toLowerCase())
        : fieldValue;
  }
  return payload;
}

function parseBucketList(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item ?? "").trim()).filter(Boolean);
    }
  } catch {
    // Fall back to accepting newline or comma separated values.
  }

  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formText(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function profileToProvider(profile: ProviderProfile): CredentialProvider {
  return {
    id: profile.id,
    credentialType: "s3_compatible_access_key",
    name: profile.name,
    logo: profile.logo,
    description:
      profile.endpoint?.required === true
        ? "S3-compatible credentials with a required endpoint."
        : "S3-compatible credentials with profile defaults.",
    fields: fieldsForProfile(profile),
    endpointTemplate: profile.endpoint?.template,
  };
}

function fieldsForProfile(profile: ProviderProfile): ProviderField[] {
  const requiredFields = new Set(profile.credential_fields.required);
  const fieldNames = [
    ...profile.credential_fields.required,
    ...(profile.credential_fields.optional ?? []),
  ].filter((fieldName, index, fields) => fields.indexOf(fieldName) === index);

  return fieldNames.map((fieldName) => ({
    name: fieldName,
    label: fieldLabels[fieldName] ?? titleize(fieldName),
    instruction: instructionForField(profile, fieldName),
    required: requiredFields.has(fieldName),
    type: typeForField(fieldName),
  }));
}

function instructionForField(profile: ProviderProfile, fieldName: string) {
  if (fieldName === "endpoint_url") {
    if (profile.endpoint?.required === true) {
      return "Required for this S3-compatible endpoint.";
    }
    if (profile.endpoint?.template) {
      return "Optional override for the generated endpoint.";
    }
    return "Optional custom S3-compatible endpoint.";
  }

  if (fieldName === "region" && profile.region?.default) {
    return `Defaults to ${profile.region.default} for this profile.`;
  }

  if (profile.endpoint?.template_variables?.includes(fieldName)) {
    return "Used to generate the provider endpoint.";
  }

  if (fieldName === "force_path_style") {
    return "Use path-style bucket addressing.";
  }

  return undefined;
}

function typeForField(fieldName: string) {
  if (fieldName === "force_path_style") {
    return "checkbox";
  }
  if (fieldName === "endpoint_url") {
    return "url";
  }
  if (passwordFields.has(fieldName)) {
    return "password";
  }
  return "text";
}

function titleize(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-control border bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-2 text-sm">
      {label}
      {children}
    </label>
  );
}

function CheckField({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-3 text-sm">
      <input
        className="size-4 rounded-control-compact border"
        defaultChecked={defaultChecked}
        name={name}
        type="checkbox"
        value="on"
      />
      <span>{label}</span>
    </label>
  );
}
