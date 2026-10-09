import { Fragment, useState, type ReactNode } from "react";
import type { Node } from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Database,
  File,
  Folder,
  FolderCheck,
  KeyRound,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { isStorageCredentialKind } from "@/features/credentials/credential-kinds";
import { apiGet } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { stringValue } from "./workflow-config-schema";
import {
  credentialBucketsFromPayload,
  errorMessage,
  fetchStorageObjects,
  folderName,
  objectName,
} from "./workflow-storage-browser";
import { formatBytes } from "@/lib/format-bytes";
import { FieldRow, TextInput, ToggleRow } from "./workflow-form-controls";
import type {
  CredentialDetail,
  CredentialRecord,
  WorkflowNodeData,
} from "./workflow-graph-types";

export function ObjectStorageEndpointSettings({
  credentials,
  fileOnly = false,
  node,
  onChange,
}: {
  credentials: CredentialRecord[];
  /**
   * A Beam Transfer source copies one object, so it cannot be a folder: the
   * explorer offers files only.
   */
  fileOnly?: boolean;
  node: Node<WorkflowNodeData>;
  onChange(patch: Partial<WorkflowNodeData>): void;
}) {
  const config = node.data.config;
  const [prefix, setPrefix] = useState("");
  const [manualBucket, setManualBucket] = useState("");
  const credentialId = stringValue(config.credentialId);
  const bucket = stringValue(config.bucket);
  const objectKey = stringValue(config.objectKey);
  const sourceType =
    stringValue(config.sourceType) === "directory" ? "directory" : "file";
  const selectedCredential =
    credentials.find((credential) => credential.id === credentialId) ?? null;
  // Only credentials that open object storage can back an endpoint; a Beam
  // API key belongs to the Beam Transfer step.
  const storageCredentials = credentials.filter((credential) =>
    isStorageCredentialKind(credential.kind),
  );
  const credentialQuery = useQuery({
    enabled: Boolean(selectedCredential),
    queryKey: ["/studio/credentials", credentialId],
    queryFn: () =>
      apiGet<{ credential: CredentialDetail }>(
        `/studio/credentials/${credentialId}`,
      ),
  });
  const savedBuckets = credentialBucketsFromPayload(
    credentialQuery.data?.credential.payload ?? {},
  );
  const objectsQuery = useQuery({
    enabled: Boolean(selectedCredential && bucket),
    queryKey: ["workflow-storage-objects", credentialId, bucket, prefix],
    queryFn: () =>
      fetchStorageObjects({
        bucket,
        credentialId,
        prefix,
      }),
  });

  const updateConfig = (name: string, value: unknown) => {
    onChange({ config: { ...config, [name]: value } });
  };
  const selectCredential = (nextCredentialId: string) => {
    const nextConfig = withoutObjectSize(config);
    delete nextConfig.storageLocation;
    const credential =
      credentials.find((item) => item.id === nextCredentialId) ?? null;
    onChange({
      config: {
        ...nextConfig,
        credentialId: nextCredentialId === "__none__" ? "" : nextCredentialId,
        provider: credential?.kind ?? config.provider ?? "s3",
        bucket: "",
        objectKey: "",
        sourceType: "file",
      },
    });
    setPrefix("");
    setManualBucket("");
  };
  const selectBucket = (nextBucket: string) => {
    const nextConfig = withoutObjectSize(config);
    delete nextConfig.storageLocation;
    onChange({
      config: {
        ...nextConfig,
        provider: selectedCredential?.kind ?? config.provider ?? "s3",
        bucket: nextBucket,
        objectKey: "",
        sourceType: "file",
      },
    });
    setPrefix("");
  };
  const selectObject = (key: string) => {
    const selectedObject = objectsQuery.data?.objects.find(
      (object) => object.key === key,
    );
    const size =
      typeof selectedObject?.size === "number"
        ? selectedObject.size
        : undefined;
    onChange({
      config: {
        ...withoutObjectSize(config),
        provider: selectedCredential?.kind ?? config.provider ?? "s3",
        bucket,
        objectKey: key,
        sourceType: "file",
        ...(size !== undefined ? { objectSize: size } : {}),
        name:
          !stringValue(config.name) ||
          stringValue(config.name) === "Object storage endpoint"
            ? `Endpoint - ${objectName(key)}`
            : config.name,
      },
    });
  };
  const updateObjectKey = (value: string) => {
    const isDirectory = value.endsWith("/");
    onChange({
      config: {
        ...withoutObjectSize(config),
        provider: selectedCredential?.kind ?? config.provider ?? "s3",
        bucket,
        objectKey: value,
        sourceType: isDirectory ? "directory" : "file",
        name:
          value &&
          (!stringValue(config.name) ||
            stringValue(config.name) === "Object storage endpoint")
            ? `Endpoint - ${
                isDirectory ? folderName(value) : objectName(value)
              }`
            : config.name,
      },
    });
  };
  const selectFolder = () => {
    if (!prefix) {
      return;
    }
    onChange({
      config: {
        ...withoutObjectSize(config),
        provider: selectedCredential?.kind ?? config.provider ?? "s3",
        bucket,
        objectKey: prefix,
        sourceType: "directory",
        name:
          !stringValue(config.name) ||
          stringValue(config.name) === "Object storage endpoint"
            ? `Endpoint - ${folderName(prefix)}`
            : config.name,
      },
    });
  };

  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,380px)_minmax(0,1fr)] overflow-hidden max-lg:grid-cols-1 max-lg:grid-rows-[auto_minmax(0,1fr)]">
      <div className="min-h-0 space-y-5 overflow-y-auto border-r p-5 max-lg:border-b max-lg:border-r-0">
        <FieldRow label="Endpoint name">
          <TextInput
            placeholder="e.g. Nightly export"
            value={stringValue(config.name)}
            onChange={(event) => updateConfig("name", event.target.value)}
          />
        </FieldRow>

        <StepSection
          description="Pick a stored credential that can reach your object storage."
          title="Credential"
        >
          {selectedCredential ? (
            <div className="flex items-center justify-between gap-3 rounded-control border bg-card p-3">
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-control bg-primary/10 text-primary">
                  <KeyRound size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {selectedCredential.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {selectedCredential.kind}
                  </span>
                </span>
              </span>
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => selectCredential("__none__")}
              >
                Change
              </Button>
            </div>
          ) : storageCredentials.length ? (
            <div className="grid gap-2">
              {storageCredentials.map((credential) => (
                <button
                  className="flex items-center gap-3 rounded-control border bg-card p-3 text-left transition-colors hover:bg-muted/60"
                  key={credential.id}
                  type="button"
                  onClick={() => selectCredential(credential.id)}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-control bg-primary/10 text-primary">
                    <KeyRound size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {credential.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {credential.kind}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-control border border-dashed p-6 text-center">
              <ShieldCheck className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">No storage credentials yet</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Add a storage credential from the Credentials page, then come
                back to connect this endpoint.
              </p>
            </div>
          )}
        </StepSection>

        {selectedCredential ? (
          <StepSection
            description="Choose an existing bucket or enter one by name."
            title="Bucket"
          >
            {bucket ? (
              <div className="flex items-center justify-between gap-3 rounded-control border bg-card p-3">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-control bg-primary/10 text-primary">
                    <Database size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs text-muted-foreground">
                      Bucket
                    </span>
                    <span className="block truncate text-sm font-medium">
                      {bucket}
                    </span>
                  </span>
                </span>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => selectBucket("")}
                >
                  Change
                </Button>
              </div>
            ) : (
              <div className="grid gap-3">
                {credentialQuery.isLoading ? (
                  <p className="rounded-control border border-dashed p-4 text-sm text-muted-foreground">
                    Loading credential buckets…
                  </p>
                ) : null}
                {savedBuckets.length ? (
                  <div className="grid gap-2">
                    {savedBuckets.map((savedBucket) => (
                      <button
                        className="flex items-center gap-3 rounded-control border bg-card p-3 text-left text-sm font-medium transition-colors hover:bg-muted/60"
                        key={savedBucket}
                        type="button"
                        onClick={() => selectBucket(savedBucket)}
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-control bg-muted text-muted-foreground">
                          <Database size={15} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {savedBucket}
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  {savedBuckets.length
                    ? "or enter manually"
                    : "enter a bucket name"}
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="flex gap-2 max-sm:grid">
                  <TextInput
                    placeholder="my-bucket"
                    value={manualBucket}
                    onChange={(event) => setManualBucket(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        const value = manualBucket.trim();
                        if (value) {
                          selectBucket(value);
                          setManualBucket("");
                        }
                      }
                    }}
                  />
                  <Button
                    disabled={!manualBucket.trim()}
                    type="button"
                    variant="outline"
                    onClick={() => {
                      const value = manualBucket.trim();
                      if (value) {
                        selectBucket(value);
                        setManualBucket("");
                      }
                    }}
                  >
                    <Plus size={16} />
                    Use bucket
                  </Button>
                </div>
              </div>
            )}
          </StepSection>
        ) : null}

        <StepSection title="Options">
          {node.data.manifest?.version === "1.1.0" ? (
            <FieldRow label="Physical storage location">
              <TextInput
                placeholder="Unknown (optional), e.g. wnam or eu-west-1"
                maxLength={64}
                value={stringValue(config.storageLocation)}
                onChange={(event) => updateConfig("storageLocation", event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Use the bucket's known physical location, independently of its signing region.
              </p>
            </FieldRow>
          ) : null}
          <div className="grid gap-3 rounded-control border bg-card p-3">
            <ToggleRow
              checked={node.data.enabled}
              label="Enabled"
              onCheckedChange={(checked) => onChange({ enabled: checked })}
            />
            <ToggleRow
              checked={node.data.required}
              label="Required"
              onCheckedChange={(checked) => onChange({ required: checked })}
            />
          </div>
        </StepSection>

        {node.data.issues.length ? (
          <div className="rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {node.data.issues.join(" ")}
          </div>
        ) : null}
      </div>

      <div className="grid min-h-0 overflow-hidden bg-muted/15 p-5">
        {selectedCredential && bucket ? (
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PrefixBreadcrumb
                  bucket={bucket}
                  prefix={prefix}
                  onNavigate={setPrefix}
                />
                {prefix && !fileOnly ? (
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={selectFolder}
                  >
                    <FolderCheck size={16} />
                    Use this folder
                  </Button>
                ) : null}
              </div>

              <div className="grid gap-2">
                <FieldRow label="Object key">
                  <TextInput
                    placeholder="path/to/file.json"
                    value={objectKey}
                    onChange={(event) => updateObjectKey(event.target.value)}
                  />
                </FieldRow>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {objectKey ? (
                    <>
                      {sourceType === "directory" ? (
                        <Folder className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <File className="size-3.5 shrink-0 text-primary" />
                      )}
                      <span>
                        Selected as{" "}
                        {sourceType === "directory" ? "a folder" : "a file"}.
                        {fileOnly
                          ? " Pick another file below or edit above."
                          : " Pick another below or edit above — end with “/” for a folder."}
                      </span>
                    </>
                  ) : fileOnly ? (
                    <span>
                      Pick a file below to prefill this, or type its key
                      directly.
                    </span>
                  ) : (
                    <span>
                      Pick a file or folder below to prefill this, or type it
                      directly. End with “/” for a folder.
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto rounded-control border bg-card">
              {objectsQuery.isLoading ? (
                <p className="grid h-full place-items-center px-4 text-sm text-muted-foreground">
                  Loading objects…
                </p>
              ) : objectsQuery.error ? (
                <p className="m-3 rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                  {errorMessage(objectsQuery.error)}
                </p>
              ) : objectsQuery.data &&
                !objectsQuery.data.prefixes.length &&
                !objectsQuery.data.objects.length ? (
                <div className="grid h-full place-items-center gap-2 px-4 text-center">
                  <Folder className="size-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    This folder is empty.
                  </p>
                </div>
              ) : (
                <div className="divide-y">
                  {(objectsQuery.data?.prefixes ?? []).map((folderPrefix) => (
                    <button
                      className="flex h-11 w-full items-center gap-3 px-3 text-left text-sm transition-colors hover:bg-muted/60"
                      key={folderPrefix}
                      type="button"
                      onClick={() => setPrefix(folderPrefix)}
                    >
                      <Folder
                        className="shrink-0 text-muted-foreground"
                        size={16}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {folderName(folderPrefix)}
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                  {(objectsQuery.data?.objects ?? []).map((object) => {
                    const selected =
                      objectKey === object.key && sourceType === "file";
                    return (
                      <button
                        className={cn(
                          "grid h-12 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-3 text-left text-sm transition-colors hover:bg-muted/60",
                          selected && "bg-primary/10",
                        )}
                        key={object.key}
                        type="button"
                        onClick={() => selectObject(object.key)}
                      >
                        <File
                          className={cn(
                            "shrink-0",
                            selected ? "text-primary" : "text-muted-foreground",
                          )}
                          size={16}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {objectName(object.key)}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {object.key}
                          </span>
                        </span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          {formatBytes(object.size) ?? "Unknown"}
                          {selected ? (
                            <Check className="size-4 text-primary" />
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {objectsQuery.data?.truncated ? (
              <p className="text-xs text-muted-foreground">
                Showing the first 1000 entries.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="grid h-full place-items-center rounded-control border border-dashed p-8 text-center">
            <div className="grid max-w-xs justify-items-center gap-2 text-sm text-muted-foreground">
              <Folder className="size-6" />
              <p className="font-medium text-foreground">Bucket explorer</p>
              <p className="text-xs">
                {selectedCredential
                  ? "Select a bucket to browse its files and folders."
                  : "Select a credential and bucket to browse your object storage."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function withoutObjectSize(config: Record<string, unknown>) {
  const next = { ...config };
  delete next.objectSize;
  return next;
}

function StepSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="grid gap-3">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function PrefixBreadcrumb({
  bucket,
  prefix,
  onNavigate,
}: {
  bucket: string;
  prefix: string;
  onNavigate(next: string): void;
}) {
  const segments = prefix.split("/").filter(Boolean);

  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs">
      <button
        className={cn(
          "flex items-center gap-1 rounded-control-compact px-1.5 py-0.5 font-medium transition-colors hover:bg-muted",
          segments.length ? "text-muted-foreground" : "text-foreground",
        )}
        type="button"
        onClick={() => onNavigate("")}
      >
        <Database className="size-3.5" />
        {bucket}
      </button>
      {segments.map((segment, index) => {
        const path = `${segments.slice(0, index + 1).join("/")}/`;
        const last = index === segments.length - 1;
        return (
          <Fragment key={path}>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            <button
              className={cn(
                "truncate rounded-control-compact px-1.5 py-0.5 transition-colors hover:bg-muted",
                last ? "font-medium text-foreground" : "text-muted-foreground",
              )}
              type="button"
              onClick={() => onNavigate(path)}
            >
              {segment}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
