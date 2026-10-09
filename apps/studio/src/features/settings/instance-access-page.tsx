import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, ResultCounter } from "@/components/data-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { ApiError } from "@/lib/api-errors";
import { apiGet, apiSend } from "@/lib/api-client";
import { InstanceKeyPanel, type InstanceKeyStatus } from "./instance-key-panel";

type JoinPolicy = "open" | "request" | "closed";

const STUDIO_GUIDE_URL = "https://docs.b1m.ai/docs/studio-first-workflow";

type AccessPayload = {
  /** The owner's instance key; null for anyone else. */
  instanceKey: InstanceKeyStatus | null;
  instance: {
    state: "unclaimed" | "adopted" | "claimed";
    joinPolicy: JoinPolicy;
    ownerOrganizationId: string | null;
    /** Resolvable only for an organization the viewer belongs to. */
    ownerOrganizationName: string | null;
    claimedAt: string | null;
    claimedByEmail: string | null;
  };
  viewer: {
    userId: string | null;
    isOwner: boolean;
    organizations: Array<{ id: string; name: string; role: string | null }>;
  };
  organizations: Array<{
    organizationId: string;
    /** Resolvable only for an organization the viewer belongs to. */
    name: string | null;
    role: "owner" | "member";
    status: "admitted" | "pending" | "revoked";
    requestedByEmail: string | null;
    decidedByEmail: string | null;
    note: string | null;
    createdAt: string;
  }>;
};

/**
 * Leads with the name when Beam gave us one, and with the id when it did not.
 * Never shows a placeholder: an operator deciding whether to revoke a tenant is
 * better served by a real id than by "Unknown organization".
 */
function OrganizationLabel({
  name,
  organizationId,
}: {
  name: string | null;
  organizationId: string;
}) {
  if (!name) {
    return (
      <span className="block truncate font-mono text-sm">{organizationId}</span>
    );
  }
  return (
    <>
      <span className="block truncate text-sm font-medium">{name}</span>
      <span className="block truncate font-mono text-xs text-muted-foreground">
        {organizationId}
      </span>
    </>
  );
}

const POLICIES: Array<{
  value: JoinPolicy;
  title: string;
  description: string;
}> = [
  {
    value: "closed",
    title: "Closed",
    description:
      "Only organizations you admit here can use this Studio. Anyone else is refused.",
  },
  {
    value: "request",
    title: "Request to join",
    description:
      "Anyone signed in to Beam can ask. They are refused until you admit them.",
  },
  {
    value: "open",
    title: "Open",
    description:
      "Any Beam organization admits itself on first use. Suitable only for a Studio you intend to be shared.",
  },
];

export function InstanceAccessPage() {
  const queryClient = useQueryClient();
  const [claimOrganizationId, setClaimOrganizationId] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Set by a claim from this page: the owner has just acted, so the instance
  // key consent starts right away. Nothing else starts it on its own.
  const [claimedHere, setClaimedHere] = useState(false);

  const accessQuery = useQuery({
    queryKey: ["instance-access"],
    queryFn: () => apiGet<AccessPayload>("/studio/instance/access"),
  });

  // Access changes decide which organizations this Studio serves, so the
  // organization and project lists are refreshed with the access view.
  const refresh = () => {
    for (const key of [
      "instance-access",
      "/studio/organizations",
      "/studio/projects",
    ]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
  const fail = (cause: unknown) =>
    setError(
      cause instanceof ApiError || cause instanceof Error
        ? cause.message
        : "Something went wrong.",
    );

  const claim = useMutation({
    mutationFn: () =>
      apiSend("POST", "/studio/instance/claim", {
        organizationId: claimOrganizationId,
        claimCode,
      }),
    onSuccess: () => {
      setError(null);
      setClaimCode("");
      setClaimedHere(true);
      refresh();
    },
    onError: fail,
  });

  const release = useMutation({
    mutationFn: () => apiSend("POST", "/studio/instance/release"),
    onSuccess: () => {
      setError(null);
      setClaimedHere(false);
      refresh();
    },
    onError: fail,
  });

  const setPolicy = useMutation({
    mutationFn: (joinPolicy: JoinPolicy) =>
      apiSend("PATCH", "/studio/instance/access", { joinPolicy }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: fail,
  });

  const admit = useMutation({
    mutationFn: (organizationId: string) =>
      apiSend("POST", "/studio/instance/access/organizations", {
        organizationId,
      }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: fail,
  });

  const revoke = useMutation({
    mutationFn: (organizationId: string) =>
      apiSend(
        "POST",
        `/studio/instance/access/organizations/${organizationId}/revoke`,
      ),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: fail,
  });

  const data = accessQuery.data;
  // Both states mean nobody owns this installation yet, which is the only
  // thing the claim card cares about. They differ in whether it is already
  // serving people, which the copy below reflects.
  const adopted = data?.instance.state === "adopted";
  const unclaimed = data?.instance.state !== "claimed";
  const owner = data?.viewer.isOwner ?? false;
  const pending = data?.organizations.filter(
    (entry) => entry.status === "pending",
  );

  return (
    <AppShell contentClassName="px-3 py-4">
      <div className="grid gap-3">
        {error && (
          <p
            role="alert"
            className="rounded-control border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {accessQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Loading access…</p>
        )}

        {unclaimed && data && (
          <section className="rounded-surface border border-warning/40 bg-warning/5 p-4">
            <h2 className="text-base font-medium">Claim this Studio</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {adopted
                ? "This Studio was already in use before it had an owner, so it keeps serving the organizations it already served. Claim it to decide who may join from now on."
                : "Nobody owns this installation yet, so it serves nobody. Claim it for your organization to start using it."}
            </p>
            {!adopted && (
              <p className="mt-2 text-sm text-muted-foreground">
                Only someone with access to the Studio host can read the claim
                code. Print it on the host with{" "}
                <code>sudo beam-updater claim-code</code>. See the{" "}
                <a
                  className="font-medium text-foreground underline underline-offset-2"
                  href={STUDIO_GUIDE_URL}
                  rel="noreferrer"
                  target="_blank"
                >
                  Your First Studio Workflow
                </a>{" "}
                for every first-run step.
              </p>
            )}
            <div className="mt-4 grid gap-3 sm:max-w-md">
              <label className="grid gap-1.5 text-sm font-medium">
                Organization
                <select
                  value={claimOrganizationId}
                  onChange={(event) =>
                    setClaimOrganizationId(event.target.value)
                  }
                  className="h-10 rounded-control border border-input bg-background px-3 text-sm"
                >
                  <option value="">Choose an organization…</option>
                  {data.viewer.organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                {adopted ? "Claim code (not required)" : "Claim code"}
                <input
                  value={claimCode}
                  onChange={(event) => setClaimCode(event.target.value)}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  autoComplete="off"
                  className="h-10 rounded-control border border-input bg-background px-3 font-mono text-sm"
                />
              </label>
              <Button
                disabled={
                  !claimOrganizationId ||
                  (!adopted && !claimCode) ||
                  claim.isPending
                }
                onClick={() => claim.mutate()}
              >
                {claim.isPending ? "Claiming…" : "Claim this Studio"}
              </Button>
            </div>
          </section>
        )}

        {data && !unclaimed && (
          <section className="rounded-surface border p-4">
            <h2 className="text-base font-medium">Owner</h2>
            <p className="mt-1 text-sm">
              <span className="font-medium">
                {data.instance.ownerOrganizationName ??
                  data.instance.ownerOrganizationId}
              </span>{" "}
              <span className="text-muted-foreground">
                owns this installation
                {data.instance.claimedByEmail
                  ? `, claimed by ${data.instance.claimedByEmail}`
                  : ""}
                .{" "}
                {owner
                  ? "You can decide who else may use it."
                  : "Only that organization can change who may use it."}
              </span>
            </p>
            {data.instance.ownerOrganizationName && (
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {data.instance.ownerOrganizationId}
              </p>
            )}
          </section>
        )}

        {data &&
          !unclaimed &&
          owner &&
          data.instanceKey &&
          data.instanceKey.status !== "disabled" && (
            <InstanceKeyPanel
              instanceKey={data.instanceKey}
              onChanged={refresh}
              startOnMount={claimedHere}
            />
          )}

        {data && !unclaimed && owner && (
          <section className="rounded-surface border p-4">
            <h2 className="text-base font-medium">Who may join</h2>
            <div className="mt-3 grid gap-2">
              {POLICIES.map((policy) => {
                const active = data.instance.joinPolicy === policy.value;
                return (
                  <button
                    key={policy.value}
                    type="button"
                    disabled={setPolicy.isPending}
                    onClick={() => setPolicy.mutate(policy.value)}
                    className={`rounded-control border p-3 text-left transition-colors ${
                      active
                        ? "border-primary bg-primary/5"
                        : "hover:bg-secondary"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {policy.title}
                      {active && <Badge>Current</Badge>}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {policy.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {data && owner && pending && pending.length > 0 && (
          <section className="rounded-surface border p-4">
            <h2 className="text-base font-medium">Requests to join</h2>
            <ul className="mt-3 divide-y">
              {pending.map((entry) => (
                <li
                  key={entry.organizationId}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <span className="min-w-0">
                    <OrganizationLabel
                      name={entry.name}
                      organizationId={entry.organizationId}
                    />
                    {entry.requestedByEmail && (
                      <span className="text-xs text-muted-foreground">
                        asked by {entry.requestedByEmail}
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    disabled={admit.isPending}
                    onClick={() => admit.mutate(entry.organizationId)}
                  >
                    Admit
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data && owner && (
          <section className="rounded-surface border p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-medium">Organizations</h2>
              <ResultCounter
                totalCount={data.organizations.length}
                visibleCount={data.organizations.length}
              />
            </div>
            {data.organizations.length === 0 ? (
              <EmptyState
                title="No organizations yet"
                description="Nobody has been admitted to this Studio."
              />
            ) : (
              <ul className="mt-3 divide-y">
                {data.organizations.map((entry) => (
                  <li
                    key={entry.organizationId}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <span className="min-w-0">
                      <OrganizationLabel
                        name={entry.name}
                        organizationId={entry.organizationId}
                      />
                      <span className="text-xs text-muted-foreground">
                        {entry.note ?? "admitted"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {entry.role === "owner" && <Badge>Owner</Badge>}
                      <Badge
                        variant={
                          entry.status === "admitted" ? "default" : "secondary"
                        }
                      >
                        {entry.status}
                      </Badge>
                      {entry.role !== "owner" &&
                        entry.status !== "revoked" && (
                          <ConfirmationDialog
                            title="Revoke access"
                            description={`${entry.name ?? entry.organizationId} loses access to this Studio. Its machine tokens and agents stop working too. Anything it created here stays.`}
                            confirmLabel="Revoke"
                            onConfirm={() =>
                              revoke.mutateAsync(entry.organizationId)
                            }
                            trigger={
                              <Button size="sm" variant="outline">
                                Revoke
                              </Button>
                            }
                          />
                        )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {data && !unclaimed && owner && (
          <section className="rounded-surface border border-destructive/40 p-4">
            <h2 className="text-base font-medium">Release this Studio</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Revokes the instance key and removes the owner. The Studio then
              serves nobody until it is claimed again with its claim code.
            </p>
            <div className="mt-3">
              <ConfirmationDialog
                confirmLabel="Release Studio"
                description="The instance key is revoked at Beam and nobody can use this Studio until it is claimed again. Workflows and credentials stay."
                onConfirm={() => release.mutateAsync()}
                title="Release this Studio?"
                trigger={
                  <Button
                    disabled={release.isPending}
                    type="button"
                    variant="destructive"
                  >
                    Release this Studio
                  </Button>
                }
              />
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
