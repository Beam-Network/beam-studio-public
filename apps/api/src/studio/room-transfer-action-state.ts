import type { PgPool } from "@beam-studio/db";
import { roomTransferActionVersion as ROOM_TRANSFER_ACTION_VERSION } from "@beam-studio/shared";
import {
  ensureRoomTransferActionV2Installed,
  roomTransferActionContractMismatch,
  type RoomTransferActionState,
} from "../agent-control/room-workflow-v2-migration.js";

/**
 * Whether the room-transfer action is usable, and why not when it isn't.
 *
 * Startup records the answer here instead of ending the process, so the rest of
 * Studio serves normally while the room-transfer surfaces report their own
 * unavailability.
 */
let state: RoomTransferActionState = { installed: false, available: true };

/** How long to wait before asking the Registry again. */
const retryIntervalMs = 60_000;
let nextRetryAt = 0;
let inFlight: Promise<RoomTransferActionState> | null = null;

export function recordRoomTransferActionState(next: RoomTransferActionState) {
  state = next;
  nextRetryAt = next.available ? 0 : Date.now() + retryIntervalMs;
}

export function roomTransferActionState(): RoomTransferActionState {
  return state;
}

export function roomTransferActionAvailable() {
  return state.available;
}

/**
 * Re-attempts the installation, so publishing the release recovers room
 * transfers without restarting the API.
 *
 * Rate-limited, and collapses concurrent callers onto one attempt, so an
 * unavailable action costs at most one Registry request a minute rather than
 * one per request.
 */
export async function refreshRoomTransferActionState(pool: PgPool) {
  if (state.available) return state;
  if (inFlight) return inFlight;
  if (Date.now() < nextRetryAt) return state;

  inFlight = ensureRoomTransferActionV2Installed(pool)
    .then(async (next) => {
      const settled = next.available
        ? await withContractCheck(pool, next)
        : next;
      recordRoomTransferActionState(settled);
      return settled;
    })
    .catch((error) => {
      // Never propagate: a failed retry must behave exactly like a known
      // unavailable action, not like a broken request.
      recordRoomTransferActionState({
        installed: false,
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      });
      return state;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Test seam: forget the recorded state and any retry backoff. */
export function resetRoomTransferActionState() {
  state = { installed: false, available: true };
  nextRetryAt = 0;
  inFlight = null;
}

/**
 * Refuses a room-transfer operation when its action is not installed.
 *
 * Without this the failure reaches `resolveActionPackageVersionPg`, which
 * throws a bare Error that the server's handler flattens to a 500 and
 * "Internal server error" — losing the one detail that explains the problem.
 */
export async function requireRoomTransferAction(pool?: PgPool) {
  if (pool) await refreshRoomTransferActionState(pool);
  if (state.available) return;
  throw Object.assign(
    new Error(
      `The room transfer action @beam/room-transfer@${ROOM_TRANSFER_ACTION_VERSION} is not installed, so room transfers are unavailable. Publish it to this deployment's action Registry, or contact an administrator.`,
    ),
    {
      code: "room_transfer_action_unavailable",
      statusCode: 503,
      expose: true,
      retryable: true,
      details: { reason: state.reason ?? null },
    },
  );
}

/**
 * An installed but incompatible release is reported exactly like a missing one,
 * rather than installing cleanly and failing per step after a run is billed.
 */
export async function withContractCheck(
  pool: PgPool,
  next: RoomTransferActionState,
): Promise<RoomTransferActionState> {
  const mismatch = await roomTransferActionContractMismatch(pool);
  return mismatch ? { ...next, available: false, reason: mismatch } : next;
}
