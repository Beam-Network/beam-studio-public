import type { StudioSession } from "../auth/session.js";

/**
 * How this installation is allowed to manage its own updates.
 *
 * Channel selection and update authority are separate concerns: choosing a
 * development channel must never imply permission to install from it. This
 * type answers only the authority question.
 */
export type UpdateMode = "managed" | "notify-only" | "disabled";

/** Autonomous installations manage themselves unless told otherwise. */
export const DEFAULT_UPDATE_MODE: UpdateMode = "managed";

const updateModes = new Set<UpdateMode>(["managed", "notify-only", "disabled"]);

/**
 * Reads the mode, refusing anything unrecognised.
 *
 * An unknown value is a configuration mistake, and the safe reading of a
 * mistake is not "manage this host anyway". It fails closed to `disabled`,
 * which performs no checks and exposes no actions.
 */
export function updateModeFromEnv(
  value: string | undefined = process.env.BEAM_STUDIO_UPDATE_MODE,
): UpdateMode {
  const mode = value?.trim();
  if (!mode) return DEFAULT_UPDATE_MODE;
  return updateModes.has(mode as UpdateMode) ? (mode as UpdateMode) : "disabled";
}

export type UpdateOperation = "status" | "check" | "apply" | "rollback";

export type UpdateDecision =
  | { allowed: true }
  | { allowed: false; code: string; statusCode: number; reason: string };

/**
 * Whether one session may perform one update operation under this mode.
 *
 * Mode is checked before identity on purpose. A `notify-only` or `disabled`
 * installation refuses to mutate regardless of who is asking, so no account
 * can talk the host into an update its operator deliberately withheld.
 *
 * Who may ask is decided by the route policy, not here: `auth.instanceAdmin()`
 * admits only the organization that owns this installation. This function used
 * to say that any authenticated user could start an update, which was true and
 * was the bug — updating the host is an act of ownership, not of membership.
 */
export function authorizeUpdateOperation(input: {
  mode: UpdateMode;
  operation: UpdateOperation;
  session: StudioSession | null;
}): UpdateDecision {
  const mutating = input.operation === "apply" || input.operation === "rollback";

  if (input.mode === "disabled") {
    return {
      allowed: false,
      code: "updates_disabled",
      statusCode: 404,
      reason:
        "This installation does not manage its own updates. Its deployment is controlled elsewhere.",
    };
  }

  if (mutating && input.mode === "notify-only") {
    return {
      allowed: false,
      code: "updates_notify_only",
      statusCode: 409,
      reason:
        "This installation reports available releases but does not install them.",
    };
  }

  if (!input.session) {
    return {
      allowed: false,
      code: "update_authentication_required",
      statusCode: 401,
      reason: "Sign in to view or manage updates.",
    };
  }

  // The route policy has already established that the caller administers this
  // installation. The browser asks for explicit confirmation first, and the
  // updater itself only installs a signed release newer than the current one.
  return { allowed: true };
}

/** What the mode permits, for the settings surface. */
export function updateCapabilities(mode: UpdateMode) {
  return {
    mode,
    checksReleases: mode !== "disabled",
    canApply: mode === "managed",
    // Release checks are answered by the updater, which verifies the signed
    // control plane, so notify-only needs the socket too — read-only.
    requiresUpdaterSocket: mode !== "disabled",
  };
}
