import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Circle, ShieldCheck, Trash2 } from "lucide-react";
import {
  getProviderProfile,
  nativeProviderDisplay,
} from "@beam-studio/shared";
import { EmptyState, Skeleton } from "@/components/data-page";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { apiSend } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { CredentialModal } from "./credential-modal";

export type CredentialRecord = {
  id?: string;
  name?: string;
  kind?: string;
  payloadPreview?: string;
  /** "studio-instance" for the Studio instance key, which only Studio changes. */
  managedBy?: "studio-instance" | null;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Hippius is an S3-compatible profile, so it resolves through
 * getProviderProfile; it is listed here only because older credentials stored
 * it as a bare kind.
 */
const legacyProviderMetadata: Record<string, { logo: string; name: string }> = {
  hippius: {
    logo: "/provider-logos/hippius.svg",
    name: "Hippius",
  },
  "huggingface-hub": {
    logo: "/provider-logos/huggingface.png",
    name: "Hugging Face Hub (token)",
  },
};

export function CredentialGrid({
  error,
  isPending,
  rows,
}: {
  error: unknown;
  isPending: boolean;
  rows: CredentialRecord[];
}) {
  const queryClient = useQueryClient();
  const deleteCredential = useMutation({
    mutationFn: (id: string) => apiSend("DELETE", `/studio/credentials/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/studio/credentials"] }),
  });

  if (error) {
    return (
      <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {String(error)}
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="overflow-hidden rounded-control border bg-card">
        <div className="divide-y">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="flex items-center gap-4 px-4 py-4" key={index}>
              <Skeleton className="h-9 w-9 shrink-0 rounded-control" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-8 w-8 rounded-control" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No credentials yet"
        description="Add a credential to connect providers and run transfers."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-control border bg-card">
      {deleteCredential.error ? (
        <div className="border-b border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {String(deleteCredential.error)}
        </div>
      ) : null}
      <div className="divide-y">
        {rows.map((row, index) => (
          <CredentialRow
            deleting={deleteCredential.isPending}
            key={row.id ?? `${row.kind}:${row.name}:${index}`}
            row={row}
            onDelete={(id) => deleteCredential.mutateAsync(id)}
          />
        ))}
      </div>
    </div>
  );
}

function CredentialRow({
  deleting,
  row,
  onDelete,
}: {
  deleting: boolean;
  row: CredentialRecord;
  onDelete(id: string): Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const id = textValue(row.id);
  // The instance key is rotated and revoked in Settings → Access, which keeps
  // Beam in step; editing or deleting it here would not.
  const managed = row.managedBy === "studio-instance";
  const openRow = () =>
    managed ? void navigate({ to: "/settings/access" }) : setOpen(true);
  const name = textValue(row.name) || "Untitled credential";
  const kind = textValue(row.kind) || "unknown";
  const provider = credentialProviderMetadata(kind);
  const payloadPreview = textValue(row.payloadPreview) || "Encrypted payload";
  const updatedAt = textValue(row.updatedAt);

  return (
    <div className="grid min-h-14 grid-cols-[minmax(220px,1fr)_180px_180px_140px_88px] items-center gap-4 px-3 py-3 text-sm transition-colors hover:bg-secondary/60 max-xl:grid-cols-[minmax(220px,1fr)_180px_140px_88px] max-lg:grid-cols-[minmax(0,1fr)_120px_88px]">
      <button
        aria-label={`Open ${name}`}
        className="flex min-w-0 items-center gap-3 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        disabled={!id}
        type="button"
        onClick={openRow}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-control bg-white p-2">
          {provider.logo ? (
            <img
              alt=""
              aria-hidden="true"
              className="max-h-full max-w-full object-contain"
              height={28}
              src={provider.logo}
              width={28}
            />
          ) : (
            <span className="font-mono text-xs uppercase text-muted-foreground">
              {kind.slice(0, 2)}
            </span>
          )}
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">
              {name}
            </span>
            {managed ? (
              <span className="shrink-0 rounded-control-compact bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Instance key
              </span>
            ) : null}
          </div>
          {id ? (
            <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {id}
            </div>
          ) : null}
        </div>
      </button>
      <button
        className="flex min-w-0 items-center gap-2 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        disabled={!id}
        tabIndex={-1}
        type="button"
        onClick={openRow}
      >
        <Circle className="h-2.5 w-2.5 fill-current text-success" />
        <span className="truncate">{provider.name}</span>
      </button>
      <span className="truncate font-mono text-xs text-muted-foreground max-xl:hidden">
        {payloadPreview}
      </span>
      <span className="truncate text-muted-foreground max-lg:hidden">
        {formatDate(updatedAt)}
      </span>
      <span className="flex items-center justify-end gap-2">
        {managed ? (
          <Button asChild size="sm" variant="outline">
            <Link
              title="Rotate or revoke it in Settings → Access"
              to="/settings/access"
            >
              Manage
            </Link>
          </Button>
        ) : (
          <>
            <CredentialModal
              credential={{ id, kind, name }}
              open={open}
              onOpenChange={setOpen}
            />
            <ConfirmationDialog
              confirmLabel="Delete credential"
              description={`This permanently deletes ${name}. Workflows using it may stop working.`}
              onConfirm={() => onDelete(id)}
              title="Delete this credential?"
              trigger={
                <Button
                  aria-label="Delete credential"
                  className={cn(!id && "invisible")}
                  disabled={deleting || !id}
                  size="icon"
                  title="Delete credential"
                  type="button"
                  variant="outline"
                >
                  <Trash2 size={16} />
                </Button>
              }
            />
          </>
        )}
      </span>
    </div>
  );
}

export function credentialProviderMetadata(provider: string) {
  const profile = getProviderProfile(provider);
  if (profile) {
    return { logo: profile.logo, name: profile.name };
  }

  return (
    nativeProviderDisplay(provider) ??
    legacyProviderMetadata[provider] ?? { logo: null, name: provider }
  );
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function formatDate(value: string) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(date);
}
