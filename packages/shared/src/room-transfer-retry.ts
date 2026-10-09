type Step = {
  actionPackageName?: unknown;
  status?: unknown;
  state?: unknown;
};

const terminalFailure = new Set(["failed", "cancelled", "expired"]);

/** Retry reattaches to one publication; it never resurrects a terminal failure. */
export function roomTransferRetryUnavailableReason(
  steps: readonly Step[],
  now = Date.now(),
): string | undefined {
  for (const step of steps) {
    if (
      step.actionPackageName !== "@beam/room-transfer" ||
      !["failed", "cancelled"].includes(String(step.status)) ||
      !step.state ||
      typeof step.state !== "object" ||
      Array.isArray(step.state)
    )
      continue;
    const state = step.state as Record<string, unknown>;
    if (!state.publicationId && state.publishRequested !== true) continue;
    const status = String(state.beamStatus ?? "").toLowerCase();
    if (terminalFailure.has(status) || state.cancellationStatus) {
      return "This room publication has ended or cancellation was requested. Run the workflow again to create a new publication; Retry only reattaches to an active publication.";
    }
    const expiry =
      typeof state.expiresAt === "string" ? Date.parse(state.expiresAt) : NaN;
    if (Number.isFinite(expiry) && expiry <= now) {
      return "This room publication has expired. Run the workflow again to create a new publication.";
    }
  }
  return undefined;
}
