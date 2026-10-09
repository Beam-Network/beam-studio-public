export type RoomActionAccess = {
  state: string;
  readOnly: boolean;
  canManage: boolean;
};

/**
 * Why a room control is unavailable, or null when it is available.
 *
 * A disabled control with no explanation is indistinguishable from a broken
 * one, and cost real debugging time during an incident. The two causes need
 * different answers, so they are reported separately: an inactive room will
 * never accept the action, while a room owned by someone else needs a
 * different identity rather than a retry.
 *
 * This lives apart from room-data so it carries no Vite or network imports
 * and can be exercised directly.
 */
export function roomActionUnavailableReason(
  room: RoomActionAccess,
): string | null {
  if (room.state !== "active") {
    return `This room is ${room.state}, so it cannot accept changes.`;
  }
  if (!room.readOnly) return null;
  if (room.canManage) {
    // Organization-scoped but not yet serviceable. Matches the error the
    // command path throws when the action is attempted anyway.
    return "This organization room is read-only until a managed agent or Studio joins it.";
  }
  return "You do not have manage rights on this room. A room created outside Studio, for example with beam room create using an API key, is member-owned rather than organization-owned, so Studio cannot manage it. Invite from the owning identity with beam room invite instead.";
}
