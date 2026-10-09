/**
 * Beam Studio self-update, as shown in Settings. This is the Studio
 * installation itself, not Registry package updates.
 *
 * Pure state so the display rules for each mode can be tested without a DOM.
 */

export type StudioUpdateMode = "managed" | "notify-only" | "disabled";

export type StudioUpdateStatus = {
  operationId: string | null;
  operation: string | null;
  phase: string;
  currentVersion: string | null;
  targetVersion: string | null;
  previousVersion: string | null;
  message: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
};

export type StudioUpdateStatusPayload = {
  mode: StudioUpdateMode;
  canApply: boolean;
  installedVersion: string | null;
  status: StudioUpdateStatus;
};

export type StudioUpdateCheckPayload = {
  mode: StudioUpdateMode;
  channel: string;
  installedVersion: string | null;
  availableVersion: string;
  updateAvailable: boolean;
  canApply: boolean;
  publishedAt: string | null;
  releaseNotesUrl: string | null;
  requiresBackup: boolean;
};

/** Ordered phases of an apply, as persisted by the host updater. */
export const updatePhases = [
  "queued",
  "checking",
  "downloading",
  "validating",
  "pulling",
  "backing_up",
  "deploying",
  "verifying",
] as const;

const phaseLabels: Record<string, string> = {
  idle: "Idle",
  queued: "Queued",
  checking: "Checking the signed release",
  downloading: "Downloading release metadata",
  validating: "Validating the deployment",
  pulling: "Pulling images",
  backing_up: "Backing up the database",
  deploying: "Replacing the Studio stack",
  verifying: "Verifying health",
  rolling_back: "Rolling back",
  recovering: "Recovering the previous release",
  succeeded: "Succeeded",
  failed: "Failed",
};

export function phaseLabel(phase: string) {
  return phaseLabels[phase] ?? phase;
}

export function isTerminalPhase(phase: string) {
  return phase === "succeeded" || phase === "failed";
}

export function isActivePhase(phase: string) {
  return phase !== "idle" && !isTerminalPhase(phase);
}

/**
 * Relative weight of each apply phase in the progress bar. Pulling the seven
 * release images dominates an update, so it spans most of the bar and advances
 * image by image.
 */
const phaseWeights: Record<(typeof updatePhases)[number], number> = {
  queued: 1,
  checking: 1,
  downloading: 1,
  validating: 1,
  pulling: 8,
  backing_up: 2,
  deploying: 3,
  verifying: 2,
};

/** "Pulling image 3/7: api", as reported by the updater while pulling. */
export function imagePullStep(message: string | null | undefined) {
  const match = /Pulling image (\d+)\/(\d+)/.exec(message ?? "");
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  return total > 0 && current >= 1 && current <= total
    ? { current, total }
    : null;
}

/**
 * 0–1 progress through an apply; rollback and recovery have no fixed length.
 * A phase counts as half done once entered; while pulling, the image being
 * pulled sets the position within the phase.
 */
export function phaseProgress(phase: string, message?: string | null) {
  if (phase === "succeeded") return 1;
  const index = (updatePhases as readonly string[]).indexOf(phase);
  if (index < 0) return null;
  const weights = updatePhases.map((name) => phaseWeights[name]);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const before = weights.slice(0, index).reduce((sum, w) => sum + w, 0);
  const step = phase === "pulling" ? imagePullStep(message) : null;
  const within = step ? (step.current - 0.5) / step.total : 0.5;
  return (before + weights[index]! * within) / total;
}

/** The API answers 404 `updates_disabled` when this installation hides updates. */
export function isUpdatesDisabledError(error: unknown) {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "updates_disabled"
  );
}

/**
 * A 401 while following an update: the restart ended the browser session, so
 * the API will keep refusing this page. Unlike a restart, it never recovers.
 */
export function isSessionEndedError(error: unknown) {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { statusCode?: unknown }).statusCode === 401
  );
}

export type StudioUpdateView =
  | { kind: "hidden" }
  | {
      kind: "visible";
      mode: Exclude<StudioUpdateMode, "disabled">;
      channel: string | null;
      installedVersion: string | null;
      availableVersion: string | null;
      updateAvailable: boolean;
      /** The "Update" button: managed mode, a newer release, nothing running. */
      showUpdateButton: boolean;
      /** notify-only with a newer release: say so, offer no install. */
      showNotifyOnlyNotice: boolean;
    };

export function studioUpdateView(input: {
  status?: StudioUpdateStatusPayload | null;
  check?: StudioUpdateCheckPayload | null;
  statusError?: unknown;
  checkError?: unknown;
}): StudioUpdateView {
  const mode = input.check?.mode ?? input.status?.mode ?? null;
  if (
    mode === "disabled" ||
    isUpdatesDisabledError(input.statusError) ||
    isUpdatesDisabledError(input.checkError)
  ) {
    return { kind: "hidden" };
  }
  const visibleMode = mode ?? "managed";
  const updateAvailable = input.check?.updateAvailable === true;
  const operationRunning = isActivePhase(input.status?.status.phase ?? "idle");
  return {
    kind: "visible",
    mode: visibleMode,
    channel: input.check?.channel ?? null,
    installedVersion:
      input.status?.installedVersion ?? input.check?.installedVersion ?? null,
    availableVersion: input.check?.availableVersion ?? null,
    updateAvailable,
    showUpdateButton:
      visibleMode === "managed" &&
      updateAvailable &&
      input.check?.canApply === true &&
      !operationRunning,
    showNotifyOnlyNotice: visibleMode === "notify-only" && updateAvailable,
  };
}

/**
 * The release the app-wide notice should announce, or null. A dismissed notice
 * stays closed for that release only; a newer one is announced again.
 */
export function updateNoticeVersion(
  check: StudioUpdateCheckPayload | null | undefined,
  dismissedVersion: string | null,
) {
  if (!check || check.mode === "disabled" || !check.updateAvailable) {
    return null;
  }
  return check.availableVersion === dismissedVersion
    ? null
    : check.availableVersion;
}
