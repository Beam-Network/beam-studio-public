import type { RoomSnapshot } from "./room-data";

export const roomActions = [
  "discover",
  "publish",
  "subscribe",
  "manage",
  "request",
  "respond",
  "observe",
] as const;
export type RoomAction = (typeof roomActions)[number];
export type RoomPermissionSnapshot = Pick<
  RoomSnapshot,
  "id" | "state" | "channels" | "memberRoles" | "grants"
>;

/** Exact-action, additive grants. Presence and administrative status grant no data access.
 * Execution still reauthorizes membership, epochs, grants and enrollment roots.
 */
export function roomActionEvaluator(room: RoomPermissionSnapshot) {
  const channels = new Map(
    room.channels.map((channel) => [channel.channel_id, channel]),
  );
  const roles = new Map<unknown, Set<unknown>>();
  for (const assignment of room.memberRoles) {
    if (assignment.room_id !== room.id || assignment.state !== "active")
      continue;
    const memberRoles = roles.get(assignment.member_id) ?? new Set();
    memberRoles.add(assignment.role_id);
    roles.set(assignment.member_id, memberRoles);
  }
  const grants = new Map<unknown, Record<string, unknown>[]>();
  for (const grant of room.grants) {
    if (grant.room_id !== room.id || grant.state !== "active") continue;
    const channelGrants = grants.get(grant.channel_id) ?? [];
    channelGrants.push(grant);
    grants.set(grant.channel_id, channelGrants);
  }
  return (
    member: Record<string, unknown>,
    channelId: string,
    action: RoomAction,
  ): boolean => {
    const channel = channels.get(channelId);
    if (
      room.state !== "active" ||
      member.room_id !== room.id ||
      member.state !== "active" ||
      channel?.room_id !== room.id ||
      channel.state !== "active" ||
      channel.rotation_required === true ||
      !roomActions.includes(action)
    )
      return false;
    if (action === "discover" && channel.visibility === "room") return true;
    return (grants.get(channelId) ?? []).some(
      (grant) =>
        Array.isArray(grant.actions) &&
        grant.actions.includes(action) &&
        ((grant.subject_type === "member" &&
          grant.subject_id === member.member_id) ||
          (grant.subject_type === "role" &&
            roles.get(member.member_id)?.has(grant.subject_id))),
    );
  };
}

export function memberCanPerformAction(
  room: RoomPermissionSnapshot,
  channelId: string,
  member: Record<string, unknown>,
  action: RoomAction,
) {
  return roomActionEvaluator(room)(member, channelId, action);
}
