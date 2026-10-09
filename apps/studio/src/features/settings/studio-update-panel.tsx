import { type ReactNode, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { apiGet, apiSend } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  isActivePhase,
  isSessionEndedError,
  isTerminalPhase,
  isUpdatesDisabledError,
  phaseLabel,
  phaseProgress,
  studioUpdateView,
  type StudioUpdateCheckPayload,
  type StudioUpdateStatus,
  type StudioUpdateStatusPayload,
} from "./studio-update-state";

const statusKey = ["/studio/updates/status"];
const checkKey = ["/studio/updates/check"];

type ApplyResponse = {
  accepted: boolean;
  operationId: string;
  targetVersion: string;
};

/**
 * Beam Studio self-update. Everything goes through the authenticated Studio
 * API, which forwards to the host updater socket; the browser never reaches the
 * updater. Nothing installs without an explicit confirmation.
 */
export function StudioUpdatePanel() {
  const queryClient = useQueryClient();
  // The operation started from this page, followed until it is terminal.
  const [tracked, setTracked] = useState<{
    operationId: string;
    targetVersion: string;
  } | null>(null);
  // A manual check against a local updater answers in milliseconds; keep the
  // refresh icon spinning long enough to show the check happened.
  const [manualCheck, setManualCheck] = useState(false);

  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => apiGet<StudioUpdateStatusPayload>("/studio/updates/status"),
    retry: false,
    // Opening Settings is when someone wants to know; never show a result the
    // app-wide notice cached before, possibly from before the instance was
    // claimed.
    refetchOnMount: "always",
    refetchInterval: (query) => {
      if (
        isUpdatesDisabledError(query.state.error) ||
        isSessionEndedError(query.state.error)
      )
        return false;
      const current = query.state.data?.status;
      const followingTracked =
        tracked &&
        (current?.operationId !== tracked.operationId ||
          !isTerminalPhase(current.phase));
      // While an update replaces the stack the API restarts and briefly fails;
      // keep polling through it.
      return followingTracked || isActivePhase(current?.phase ?? "idle")
        ? 2_000
        : false;
    },
  });
  const check = useQuery({
    queryKey: checkKey,
    queryFn: () => apiGet<StudioUpdateCheckPayload>("/studio/updates/check"),
    retry: false,
    staleTime: 60_000,
    refetchOnMount: "always",
    enabled: !isUpdatesDisabledError(status.error),
  });

  const current = status.data?.status;
  const trackedResult =
    tracked &&
    current?.operationId === tracked.operationId &&
    isTerminalPhase(current.phase)
      ? current
      : null;

  // Once the tracked update finishes, the installed and available versions
  // have changed: re-read them.
  useEffect(() => {
    if (trackedResult)
      void queryClient.invalidateQueries({ queryKey: checkKey });
  }, [trackedResult?.operationId, trackedResult?.phase, queryClient]);

  const view = studioUpdateView({
    status: status.data,
    check: check.data,
    statusError: status.error,
    checkError: check.error,
  });
  if (view.kind === "hidden") return null;

  // The restart ended this browser's session: polling cannot recover, so stop
  // showing progress and ask for a new sign-in instead.
  const sessionEnded = Boolean(tracked) && isSessionEndedError(status.error);
  const operationRunning =
    !sessionEnded &&
    (Boolean(tracked && !trackedResult) ||
      isActivePhase(current?.phase ?? "idle"));
  const refreshing = manualCheck || status.isFetching || check.isFetching;

  async function checkForUpdates() {
    setManualCheck(true);
    try {
      await Promise.all([
        status.refetch(),
        check.refetch(),
        new Promise((resolve) => setTimeout(resolve, 800)),
      ]);
    } finally {
      setManualCheck(false);
    }
  }

  async function install() {
    const response = await apiSend<ApplyResponse>(
      "POST",
      "/studio/updates/apply",
      { confirm: true },
    );
    setTracked({
      operationId: response.operationId,
      targetVersion: response.targetVersion,
    });
    await queryClient.invalidateQueries({ queryKey: statusKey });
  }

  // Each row waits only for the answer it shows: the host updater's status
  // can be slow while the release check has long answered, or the reverse.
  const checkPending = check.isPending;
  const installedPending =
    !view.installedVersion && (status.isPending || check.isPending);
  const modeLabel = view.mode === "managed" ? "Managed" : "Notify only";

  return (
    <section className="rounded-surface border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">
            Beam Studio updates
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Version of this Studio installation, on the release channel chosen
            at install time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            disabled={refreshing || operationRunning}
            onClick={() => void checkForUpdates()}
            size="sm"
            type="button"
            variant="secondary"
          >
            <RefreshCw
              className={cn("h-4 w-4", refreshing && "animate-spin")}
            />
            Check for updates
          </Button>
          {!sessionEnded && view.showUpdateButton && view.availableVersion ? (
            <ConfirmationDialog
              confirmLabel={`Install ${view.availableVersion}`}
              description={confirmDescription(
                check.data,
                view.installedVersion,
              )}
              onConfirm={install}
              title={`Update Beam Studio to ${view.availableVersion}?`}
              trigger={
                <Button size="sm" type="button">
                  <Download className="h-4 w-4" />
                  Update
                </Button>
              }
            />
          ) : null}
        </div>
      </div>
      <div className="px-4 py-1">
        <dl className="divide-y">
          <Row label="Channel">
            {checkPending ? (
              <Muted>—</Muted>
            ) : view.channel ? (
              <Badge className="font-mono" variant="outline">
                {view.channel}
              </Badge>
            ) : (
              <Muted>Unknown</Muted>
            )}
          </Row>
          <Row label="Installed version">
            <span className="font-mono">
              {installedPending ? "—" : (view.installedVersion ?? "Unknown")}
            </span>
          </Row>
          <Row label="Available version">
            {checkPending ? (
              <Muted>—</Muted>
            ) : view.availableVersion ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{view.availableVersion}</span>
                {view.updateAvailable ? (
                  <Badge
                    className="border-warning/30 bg-warning/10 text-warning"
                    variant="outline"
                  >
                    New version
                  </Badge>
                ) : (
                  <Badge
                    className="border-success/30 bg-success/10 text-success"
                    variant="outline"
                  >
                    Up to date
                  </Badge>
                )}
                {check.data?.releaseNotesUrl ? (
                  <a
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    href={check.data.releaseNotesUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Release notes
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </span>
            ) : (
              <Muted>Unknown</Muted>
            )}
          </Row>
          <Row label="Update mode">
            <Muted>{modeLabel}</Muted>
          </Row>
        </dl>

        {view.showNotifyOnlyNotice ? (
          <Notice tone="warning">
            Beam Studio {view.availableVersion} is available. This installation
            only reports new releases; ask the host operator to install it.
          </Notice>
        ) : null}

        {status.error && !(tracked && !trackedResult) ? (
          <Notice tone="destructive">
            Update status unavailable: {errorMessage(status.error)}
          </Notice>
        ) : null}
        {check.error ? (
          <Notice tone="destructive">
            Could not check for a new version: {errorMessage(check.error)}
          </Notice>
        ) : null}

        {operationRunning ? (
          <Progress
            reconnecting={Boolean(tracked && status.error)}
            status={current}
            targetVersion={tracked?.targetVersion ?? current?.targetVersion}
          />
        ) : null}

        {sessionEnded ? (
          <Notice tone="warning">
            Studio restarted during the update and your session ended. Reload
            the page and sign in again to see the result.{" "}
            <Button
              className="ml-2"
              onClick={() => window.location.reload()}
              size="sm"
              variant="outline"
            >
              Reload
            </Button>
          </Notice>
        ) : null}
        {trackedResult ? <Result status={trackedResult} /> : null}
        {!tracked && current?.operation && current.phase === "failed" ? (
          <Notice tone="destructive">
            The last {current.operation} failed
            {current.completedAt ? ` (${formatDate(current.completedAt)})` : ""}
            : {current.error ?? current.message ?? "unknown error"}
          </Notice>
        ) : null}
      </div>
    </section>
  );
}

function confirmDescription(
  check: StudioUpdateCheckPayload | undefined,
  installedVersion: string | null,
) {
  return [
    `Beam Studio will be updated from ${installedVersion ?? "the installed version"} to ${check?.availableVersion} on the ${check?.channel} channel.`,
    "All Studio services restart and running work may be interrupted.",
    check?.requiresBackup ? "The database is backed up first." : "",
    "If the new release fails its health checks, the previous one is restored automatically.",
  ]
    .filter(Boolean)
    .join(" ");
}

function Progress({
  reconnecting,
  status,
  targetVersion,
}: {
  reconnecting: boolean;
  status?: StudioUpdateStatus;
  targetVersion?: string | null;
}) {
  const phase = status?.phase ?? "queued";
  const progress = phaseProgress(phase, status?.message);
  return (
    <div className="my-3 rounded-control border bg-muted/30 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        {targetVersion
          ? `Updating Beam Studio to ${targetVersion}`
          : "Updating Beam Studio"}
      </div>
      <div
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={
          progress === null ? undefined : Math.round(progress * 100)
        }
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div
          className={cn(
            "h-full rounded-full bg-brand transition-all",
            progress === null && "w-1/3 animate-pulse",
          )}
          style={
            progress === null ? undefined : { width: `${progress * 100}%` }
          }
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {reconnecting
          ? "Studio is restarting; reconnecting…"
          : `${phaseLabel(phase)}${status?.message ? ` — ${status.message}` : ""}`}
      </p>
    </div>
  );
}

function Result({ status }: { status: StudioUpdateStatus }) {
  if (status.phase === "succeeded") {
    return (
      <Notice tone="success">
        <CheckCircle2 className="mr-1.5 inline h-4 w-4" />
        {status.message ?? "Beam Studio update completed"}
        {status.currentVersion ? ` — now running ${status.currentVersion}` : ""}
        .{" "}
        <button
          className="underline underline-offset-2"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload Studio
        </button>
      </Notice>
    );
  }
  return (
    <Notice tone="destructive">
      <AlertTriangle className="mr-1.5 inline h-4 w-4" />
      Update failed: {status.error ?? status.message ?? "unknown error"}
      {status.message && status.error ? ` (${status.message})` : ""}
    </Notice>
  );
}

function Row({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex min-h-10 items-center gap-6 py-2">
      <dt className="w-36 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Notice({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "success" | "warning" | "destructive";
}) {
  return (
    <p
      className={cn(
        "my-3 rounded-control border p-3 text-sm",
        tone === "success" && "border-success/30 bg-success/10 text-success",
        tone === "warning" && "border-warning/30 bg-warning/10 text-warning",
        tone === "destructive" &&
          "border-destructive/40 bg-destructive/5 text-destructive",
      )}
      role={tone === "destructive" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
