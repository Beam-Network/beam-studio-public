import type { InputHTMLAttributes, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
  nativeProviders as sharedNativeProviders,
  providerProfiles,
  STORAGE_NETWORK_HINT,
  type ProviderProfile,
} from "@beam-studio/shared";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apiGet, apiSend } from "@/lib/api-client";
import { showsStorageNetworkHint } from "./credential-kinds";
import {
  TestResultBanner,
  testCredential,
  type CredentialTestResult,
} from "./credential-test";
import { cn } from "@/lib/utils";

type ProviderGroupId = "hosted-s3" | "cloud-s3" | "self-hosted-s3" | "native";

type ProviderField = {
  name: string;
  label: string;
  instruction?: string;
  pattern?: string;
  type?: string;
  required?: boolean;
};

type CredentialProvider = {
  id: string;
  name: string;
  logo: string;
  description: string;
  group: ProviderGroupId;
  fields: ProviderField[];
  supportsBuckets?: boolean;
  endpointTemplate?: string;
};

type EditableCredential = {
  id: string;
  name: string;
  kind: string;
  updatedAt: string;
  payload: Record<string, boolean | string | string[]>;
};

const cloudS3ProviderIds = new Set([
  "s3",
  "r2",
  "ibm-cloud-object-storage",
  "oracle-object-storage",
  "yandex-object-storage",
  "tencent-cos",
  "alibaba-oss",
  "huawei-obs",
  "baidu-bos",
]);

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

const nativeProviders: CredentialProvider[] = sharedNativeProviders.map(
  (provider) => ({ ...provider, group: "native" as const }),
);

const s3Providers = providerProfiles.map(profileToProvider);
const providers = [...s3Providers, ...nativeProviders];
const defaultProvider = providers[0]!;

const providerGroups: Array<{ id: ProviderGroupId; title: string }> = [
  { id: "cloud-s3", title: "Cloud S3" },
  { id: "hosted-s3", title: "Hosted S3" },
  { id: "self-hosted-s3", title: "Self-hosted S3" },
  { id: "native", title: "Native providers" },
];

export function CredentialModal({
  credential,
  triggerLabel = "Create credentials",
  triggerVariant,
  open: controlledOpen,
  onOpenChange,
  hideTrigger,
}: {
  credential?: Pick<EditableCredential, "id" | "kind" | "name">;
  triggerLabel?: string;
  triggerVariant?: ButtonProps["variant"];
  /** Controlled mode, so the list row itself can open the dialog. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const editing = Boolean(credential);
  const queryClient = useQueryClient();
  const allowUntestedRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [step, setStep] = useState<"provider" | "form">(
    editing ? "form" : "provider",
  );
  const [selectedProvider, setSelectedProvider] = useState(
    credential?.kind ?? "s3",
  );
  const [query, setQuery] = useState("");
  const [buckets, setBuckets] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CredentialTestResult | null>(null);
  const { data: editableData, isFetching: editableIsFetching } = useQuery({
    queryKey: ["/studio/credentials", credential?.id],
    queryFn: () =>
      apiGet<{ credential: EditableCredential }>(
        `/studio/credentials/${credential?.id}`,
      ),
    enabled: open && editing && Boolean(credential?.id),
  });
  const editableCredential = editableData?.credential;
  useEffect(() => {
    if (!open || !editableCredential) {
      return;
    }
    setSelectedProvider(editableCredential.kind);
    setBuckets(credentialBucketsFromPayload(editableCredential.payload));
  }, [editableCredential, open]);

  const provider = useMemo(
    () =>
      providers.find((item) => item.id === selectedProvider) ?? defaultProvider,
    [selectedProvider],
  );
  const filteredProviders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return providers;
    }

    return providers.filter((item) =>
      [item.name, item.id, item.description].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      ),
    );
  }, [query]);

  // The prefix covers the list and this credential's detail. Waiting for the
  // refetch means the list already shows the saved credential when the dialog
  // closes, instead of its old row until the request returns.
  const closeAfterRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["/studio/credentials"] });
    setOpen(false);
  };

  const createCredential = useMutation({
    mutationFn: (input: {
      name: string;
      kind: string;
      payload: Record<string, unknown>;
      allowUntested?: boolean;
    }) => apiSend("POST", "/studio/credentials", input),
    onSuccess: closeAfterRefresh,
  });
  const updateCredential = useMutation({
    mutationFn: (input: {
      name: string;
      kind: string;
      payload: Record<string, unknown>;
      allowUntested?: boolean;
    }) => apiSend("PATCH", `/studio/credentials/${credential?.id}`, input),
    onSuccess: closeAfterRefresh,
  });
  const mutation = editing ? updateCredential : createCredential;

  const runTest = async () => {
    const form = formRef.current;
    if (!form) {
      return;
    }
    const formData = new FormData(form);
    const payload = providerPayloadFromForm(formData);
    setValidationError(null);
    setTestResult(null);
    setTesting(true);
    try {
      setTestResult(
        await testCredential({
          kind: provider.id,
          payload: provider.supportsBuckets
            ? { ...payload, buckets, bucket: buckets[0] ?? "" }
            : payload,
          // On edit, blank password fields mean "keep the stored value", so the
          // server merges the saved payload underneath before probing.
          credentialId: editing ? (credential?.id ?? null) : null,
        }),
      );
    } catch (error) {
      setTestResult({ status: "error", errorMessage: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    // The row opens the dialog directly, so the reset the trigger button would
    // have done has to happen here too.
    setStep(editing ? "form" : "provider");
    setValidationError(null);
    setTestResult(null);
    allowUntestedRef.current = false;
  }, [open, editing]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {hideTrigger ? null : (
      <DialogTrigger asChild>
        {editing ? (
          <Button
            aria-label="Edit credential"
            size="icon"
            title="Edit credential"
            type="button"
            variant="outline"
            onClick={() => {
              setStep("form");
              setSelectedProvider(credential?.kind ?? "s3");
              setValidationError(null);
              setTestResult(null);
              allowUntestedRef.current = false;
            }}
          >
            <Pencil size={16} />
          </Button>
        ) : (
          <Button
            size="sm"
            type="button"
            variant={triggerVariant}
            onClick={() => {
              setStep("provider");
              setSelectedProvider("s3");
              setQuery("");
              setBuckets([]);
              setValidationError(null);
              setTestResult(null);
              allowUntestedRef.current = false;
            }}
          >
            <Plus size={16} />
            {triggerLabel}
          </Button>
        )}
      </DialogTrigger>
      )}

      <DialogContent
        className={
          step === "provider"
            ? "h-[min(760px,90vh)] grid-rows-[auto_minmax(0,1fr)]"
            : // Providers differ widely in field count, so the form is bounded
              // to the viewport and scrolls internally rather than pushing its
              // actions off-screen.
              "max-h-[90vh] grid-rows-[auto_minmax(0,1fr)]"
        }
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit credential" : "Add credential"}
          </DialogTitle>
          <DialogDescription>
            {step === "provider"
              ? "Choose the provider for this credential."
              : `Configure ${provider.name} credentials.`}
          </DialogDescription>
        </DialogHeader>

        {step === "provider" ? (
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4">
            <div className="relative">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                size={16}
              />
              <Input
                className="pl-9"
                placeholder="Search providers"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
              {providerGroups.map((group) => {
                const groupProviders = filteredProviders.filter(
                  (item) => item.group === group.id,
                );
                if (!groupProviders.length) {
                  return null;
                }

                return (
                  <section className="grid gap-2" key={group.id}>
                    <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                      {group.title}
                    </h3>
                    <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                      {groupProviders.map((item) => (
                        <button
                          className={`relative grid min-h-20 grid-cols-[48px_minmax(0,1fr)] items-center gap-3 rounded-control border bg-muted/40 p-4 text-left transition-colors hover:bg-muted ${
                            item.id === selectedProvider
                              ? "border-primary bg-primary/10"
                              : ""
                          }`}
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setSelectedProvider(item.id);
                          }}
                        >
                          {item.id === selectedProvider ? (
                            <span className="absolute right-3 top-3 grid size-6 place-items-center rounded-full bg-primary text-primary-foreground">
                              <Check size={14} />
                            </span>
                          ) : null}
                          <span className="grid size-12 place-items-center rounded-control bg-white p-2">
                            <ProviderLogo provider={item} size={32} />
                          </span>
                          <span className="min-w-0 pr-7">
                            <strong className="block text-sm leading-snug">
                              {item.name}
                            </strong>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
              {!filteredProviders.length ? (
                <p className="rounded-control border border-dashed p-4 text-sm text-muted-foreground">
                  No providers match this search.
                </p>
              ) : null}
            </div>
            <div className="col-span-full flex justify-end">
              <Button type="button" onClick={() => setStep("form")}>
                Continue
              </Button>
            </div>
          </div>
        ) : null}

        {step === "form" ? (
          editableIsFetching ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (
            <form
              className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4"
              key={`${credential?.id ?? "new"}:${selectedProvider}:${editableCredential?.updatedAt ?? ""}`}
              onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData(event.currentTarget);
                setValidationError(null);
                mutation.mutate({
                  name: formText(formData, "name"),
                  kind: provider.id,
                  payload: providerPayloadFromForm(formData),
                  // The API tests before writing and refuses a rejected
                  // credential; this is the explicit override.
                  allowUntested: allowUntestedRef.current,
                });
                allowUntestedRef.current = false;
              }}
              ref={formRef}
            >
              <div className="mb-4 flex items-center gap-3 rounded-control border bg-muted/40 p-3">
                {!editing ? (
                  <Button
                    aria-label="Back to providers"
                    size="icon"
                    type="button"
                    variant="outline"
                    onClick={() => setStep("provider")}
                  >
                    <ArrowLeft size={16} />
                  </Button>
                ) : null}
                <span className="grid size-10 place-items-center rounded-control bg-white p-2">
                  <ProviderLogo provider={provider} size={28} />
                </span>
                <div>
                  <strong className="block text-sm">{provider.name}</strong>
                  <span className="text-xs text-muted-foreground">
                    {provider.description}
                  </span>
                  {provider.endpointTemplate ? (
                    <span className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">
                      {provider.endpointTemplate}
                    </span>
                  ) : null}
                </div>
              </div>
              <input type="hidden" name="kind" value={provider.id} />
              {provider.supportsBuckets ? (
                <input
                  type="hidden"
                  name="payload.buckets"
                  value={JSON.stringify(buckets)}
                />
              ) : null}
              <FormGrid className="min-h-0 overflow-y-auto pr-1">
                <Field label="Credential name">
                  <Input
                    defaultValue={editableCredential?.name ?? credential?.name}
                    name="name"
                    placeholder={`${provider.name} production`}
                    required
                  />
                </Field>
                {provider.fields.map((field) =>
                  field.type === "checkbox" ? (
                    <div className="grid gap-2" key={field.name}>
                      <input
                        type="hidden"
                        name={`payload.${field.name}`}
                        value="false"
                      />
                      <CheckField
                        defaultChecked={
                          editableCredential?.payload[field.name] === true ||
                          editableCredential?.payload[field.name] === "true"
                        }
                        label={field.label}
                        name={`payload.${field.name}`}
                      />
                      {field.instruction ? (
                        <span className="text-xs text-muted-foreground">
                          {field.instruction}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <Field label={field.label} key={field.name}>
                      <Input
                        defaultValue={
                          field.type === "password"
                            ? undefined
                            : fieldValue(
                                editableCredential?.payload[field.name],
                              )
                        }
                        name={`payload.${field.name}`}
                        pattern={field.pattern}
                        placeholder={
                          editing && field.type === "password"
                            ? "Leave blank to keep current value"
                            : undefined
                        }
                        required={
                          editing && field.type === "password"
                            ? false
                            : field.required
                        }
                        type={field.type ?? "text"}
                      />
                      {field.instruction ? (
                        <span className="text-xs text-muted-foreground">
                          {field.instruction}
                        </span>
                      ) : null}
                    </Field>
                  ),
                )}
                {provider.supportsBuckets ? (
                  <BucketAccessField
                    buckets={buckets}
                    onChange={(nextBuckets) => {
                      allowUntestedRef.current = false;
                      setValidationError(null);
                      setTestResult(null);
                      setBuckets(nextBuckets);
                    }}
                  />
                ) : null}
                {showsStorageNetworkHint(provider.id) ? (
                  <p className="text-xs text-muted-foreground">
                    {STORAGE_NETWORK_HINT}
                  </p>
                ) : null}
                {testResult ? <TestResultBanner result={testResult} /> : null}
                {validationError || mutation.error ? (
                  <div className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    <p>{validationError ?? errorMessage(mutation.error)}</p>
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
              </FormGrid>
              <FormActions className="border-t bg-card pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (editing) {
                      setOpen(false);
                    } else {
                      setStep("provider");
                    }
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={testing || mutation.isPending}
                  type="button"
                  variant="outline"
                  onClick={runTest}
                >
                  {testing ? "Testing..." : "Test connection"}
                </Button>
                <Button disabled={mutation.isPending || testing} type="submit">
                  {mutation.isPending ? "Saving..." : "Save"}
                </Button>
              </FormActions>
            </form>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function profileToProvider(profile: ProviderProfile): CredentialProvider {
  return {
    id: profile.id,
    name: profile.name,
    logo: profile.logo,
    description:
      profile.endpoint?.required === true
        ? "S3-compatible credentials with a required endpoint."
        : "S3-compatible credentials with profile defaults.",
    group: groupForProfile(profile),
    fields: fieldsForProfile(profile),
    supportsBuckets: true,
    endpointTemplate: profile.endpoint?.template,
  };
}

function groupForProfile(profile: ProviderProfile): ProviderGroupId {
  if (profile.endpoint?.required === true) {
    return "self-hosted-s3";
  }

  return cloudS3ProviderIds.has(profile.id) ? "cloud-s3" : "hosted-s3";
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
    <div className="grid gap-2 rounded-control border bg-muted/30 p-3">
      <div>
        <span className="text-sm font-semibold">Buckets</span>
        <p className="mt-1 text-xs text-muted-foreground">
          Saved buckets are tested before this credential is saved.
        </p>
      </div>
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
              className="inline-flex max-w-full items-center gap-2 rounded-control border bg-card px-2 py-1 text-sm"
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
          No bucket saved for this credential.
        </span>
      )}
    </div>
  );
}

function ProviderLogo({
  provider,
  size,
}: {
  provider: CredentialProvider;
  size: number;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className="font-mono text-xs uppercase text-muted-foreground">
        {provider.id.slice(0, 2)}
      </span>
    );
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className="max-h-full max-w-full object-contain"
      height={size}
      src={provider.logo}
      width={size}
      onError={() => setFailed(true)}
    />
  );
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

function credentialBucketsFromPayload(
  payload: Record<string, boolean | string | string[]>,
) {
  const buckets = Array.isArray(payload.buckets)
    ? payload.buckets
    : typeof payload.buckets === "string"
      ? payload.buckets.split(/\r?\n|,/)
      : [];
  const legacyBucket =
    typeof payload.bucket === "string"
      ? payload.bucket
      : typeof payload.default_bucket === "string"
        ? payload.default_bucket
        : "";

  return [...buckets, legacyBucket]
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);
}

function fieldValue(value: boolean | string | string[] | undefined) {
  if (typeof value === "boolean") {
    return String(value);
  }

  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={[
        "h-10 w-full rounded-control border bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}

function FormGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("grid gap-3", className)}>{children}</div>;
}

function FormActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 max-sm:justify-start",
        className,
      )}
    >
      {children}
    </div>
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
