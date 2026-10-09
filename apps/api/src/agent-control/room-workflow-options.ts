import { roomActionContentType } from "@beam-studio/shared";

type JsonObject = Record<string, unknown>;

type StorageBindingAvailability = {
  coordinatorMemberId: string;
  availability: string;
};

export type RoomWorkflowAgent = {
  id: string;
  machineName?: string | null;
  name?: string | null;
  platform?: string | null;
  status: string;
  capabilities?: unknown[];
};

export type RoomWorkflowRecipientFilter = {
  channelId: string;
  sourceMemberId: string;
  query?: string;
  roleId?: string;
  presence?: string;
  selectedOnly?: boolean;
  selectedMemberIds?: string[];
  cursor?: string;
  limit?: number;
};

export function paginateRoomWorkflowRooms(
  rooms: Array<{ id: string; name: string; state: string }>,
  query?: string,
  cursor?: string,
  limit?: number,
) {
  const needle = normalized(query);
  const filtered = rooms
    .filter(
      (room) =>
        !needle || `${room.name} ${room.id}`.toLowerCase().includes(needle),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  return page(filtered, cursor, limit);
}

export function roomWorkflowContext(
  roomId: string,
  roomName: string,
  snapshot: JsonObject,
  agents: RoomWorkflowAgent[],
  storageBindings: Array<{
    coordinatorMemberId: string;
    credentialId: string;
    providerProfileId: string;
    bucket: string;
    availability: string;
  }> = [],
) {
  const memberships = records(snapshot.memberships);
  const channels = records(snapshot.channels)
    .filter(
      (channel) =>
        value(channel.kind) === "object" &&
        value(channel.state) === "active" &&
        channel.rotation_required !== true,
    )
    .map((channel) => ({
      id: value(channel.channel_id) ?? value(channel.id) ?? "",
      name:
        value(channel.name) ?? value(channel.channel_id) ?? "Object channel",
      description: value(channel.description),
    }))
    .filter((channel) => channel.id);
  const activeMemberByAgent = new Map(
    memberships
      .filter(
        (member) => value(member.state) === "active" && value(member.agent_id),
      )
      .map((member) => [value(member.agent_id)!, member]),
  );
  const roleIdsByMember = memberRoleIds(snapshot, roomId);
  const publishByChannel = new Map(
    channels.map((channel) => [
      channel.id,
      authorizedSubjects(snapshot, roomId, channel.id, "publish"),
    ]),
  );
  const agentSources = agents.flatMap((agent) => {
    const member = activeMemberByAgent.get(agent.id);
    const memberId = value(member?.member_id);
    const assignedRoles = memberId ? (roleIdsByMember.get(memberId) ?? []) : [];
    if (
      agent.status !== "online" ||
      !agent.capabilities?.includes("room-workflows/v1") ||
      !memberId
    )
      return [];
    const channelIds = channels.flatMap((channel) => {
      const authorization = publishByChannel.get(channel.id)!;
      return authorization.memberIds.has(memberId) ||
        assignedRoles.some((roleId) => authorization.roleIds.has(roleId))
        ? [channel.id]
        : [];
    });
    return channelIds.length
      ? [
          {
            id: memberId,
            agentId: agent.id,
            kind: "agent" as const,
            name: agent.machineName || agent.name || agent.id,
            platform: agent.platform ?? null,
            channelIds,
            credentialId: null,
            providerProfileId: null,
            bucket: null,
          },
        ]
      : [];
  });
  const bindingByMember = new Map(
    storageBindings.map((binding) => [binding.coordinatorMemberId, binding]),
  );
  const storageSources = memberships.flatMap((member) => {
    const memberId = value(member.member_id);
    const binding = memberId ? bindingByMember.get(memberId) : undefined;
    if (
      !memberId ||
      value(member.kind) !== "object_storage" ||
      value(member.state) !== "active" ||
      value(member.presence) !== "online" ||
      binding?.availability !== "available" ||
      !Array.isArray(member.object_capabilities) ||
      !member.object_capabilities.includes("source")
    )
      return [];
    const assignedRoles = roleIdsByMember.get(memberId) ?? [];
    const channelIds = channels.flatMap((channel) => {
      const authorization = publishByChannel.get(channel.id)!;
      return authorization.memberIds.has(memberId) ||
        assignedRoles.some((roleId) => authorization.roleIds.has(roleId))
        ? [channel.id]
        : [];
    });
    return channelIds.length
      ? [
          {
            id: memberId,
            agentId: null,
            kind: "object_storage" as const,
            name: value(member.display_name) ?? binding.bucket,
            platform: null,
            channelIds,
            credentialId: binding.credentialId,
            providerProfileId: binding.providerProfileId,
            bucket: binding.bucket,
          },
        ]
      : [];
  });
  const sources = [...agentSources, ...storageSources].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const roles = records(snapshot.roles)
    .filter((role) => !value(role.state) || value(role.state) === "active")
    .map((role) => ({
      id: value(role.role_id) ?? value(role.id) ?? "",
      name:
        value(role.name) ??
        value(role.label) ??
        value(role.template) ??
        value(role.role_id) ??
        "Role",
    }))
    .filter((role) => role.id)
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    room: {
      id: roomId,
      name: roomName,
      state: value(object(snapshot.room).state) ?? "unknown",
    },
    channels,
    sources,
    roles,
  };
}

export function roomWorkflowRecipientPage(
  roomId: string,
  snapshot: JsonObject,
  agents: RoomWorkflowAgent[],
  filter: RoomWorkflowRecipientFilter,
  storageBindings: StorageBindingAvailability[] = [],
) {
  const all = recipientOptions(
    roomId,
    snapshot,
    agents,
    filter,
    storageBindings,
  );
  const selected = new Set(uniqueText(filter.selectedMemberIds));
  const eligibleIds = new Set(
    all.filter((item) => item.eligible).map((item) => item.memberId),
  );
  const candidates = all.filter((item) => {
    if (!item.eligible && !selected.has(item.memberId)) return false;
    if (filter.selectedOnly && !selected.has(item.memberId)) return false;
    return recipientMatches(item, filter);
  });
  const result = page(candidates, filter.cursor, filter.limit);
  return {
    ...result,
    selectedCount: selected.size,
    ineligibleSelectedCount: [...selected].filter((id) => !eligibleIds.has(id))
      .length,
  };
}

export function resolveRoomWorkflowRecipients(
  roomId: string,
  snapshot: JsonObject,
  agents: RoomWorkflowAgent[],
  filter: Omit<
    RoomWorkflowRecipientFilter,
    "cursor" | "limit" | "selectedOnly" | "selectedMemberIds"
  >,
  storageBindings: StorageBindingAvailability[] = [],
) {
  return recipientOptions(roomId, snapshot, agents, filter, storageBindings)
    .filter((item) => item.eligible && recipientMatches(item, filter))
    .map((item) => item.memberId);
}

function recipientOptions(
  roomId: string,
  snapshot: JsonObject,
  agents: RoomWorkflowAgent[],
  filter: Pick<
    RoomWorkflowRecipientFilter,
    "channelId" | "sourceMemberId" | "selectedMemberIds"
  >,
  storageBindings: StorageBindingAvailability[] = [],
) {
  const storageAvailability = new Map(
    storageBindings.map((binding) => [
      binding.coordinatorMemberId,
      binding.availability,
    ]),
  );
  const agentNames = new Map(
    agents.map((agent) => [
      agent.id,
      agent.machineName || agent.name || agent.id,
    ]),
  );
  const roles = new Map(
    records(snapshot.roles).map((role) => [
      value(role.role_id) ?? value(role.id),
      value(role.name) ??
        value(role.label) ??
        value(role.template) ??
        value(role.role_id),
    ]),
  );
  const roleIdsByMember = memberRoleIds(snapshot, roomId);
  const authorization = authorizedSubjects(
    snapshot,
    roomId,
    filter.channelId,
    "subscribe",
  );
  const selected = uniqueText(filter.selectedMemberIds);
  const members = records(snapshot.memberships);
  const known = new Set<string>();
  const options = members.flatMap((member) => {
    const memberId = value(member.member_id);
    if (!memberId || memberId === filter.sourceMemberId) return [];
    known.add(memberId);
    const roleIds = roleIdsByMember.get(memberId) ?? [];
    const agentId = value(member.agent_id);
    const storageMember = value(member.kind) === "object_storage";
    const storageAvailable =
      !storageMember ||
      (value(member.presence) === "online" &&
        Array.isArray(member.object_capabilities) &&
        member.object_capabilities.includes("destination") &&
        storageAvailability.get(memberId) === "available");
    const eligible =
      authorization.channelActive &&
      value(member.state) === "active" &&
      storageAvailable &&
      (authorization.memberIds.has(memberId) ||
        roleIds.some((roleId) => authorization.roleIds.has(roleId)));
    return [
      {
        memberId,
        agentId,
        kind:
          value(member.kind) === "object_storage" ? "object_storage" : "agent",
        name:
          value(member.display_name) ||
          (agentId && agentNames.get(agentId)) ||
          value(member.principal_id) ||
          memberId,
        presence: value(member.presence) ?? "unknown",
        roleIds,
        roleNames: roleIds.map((roleId) => roles.get(roleId) ?? roleId),
        eligible,
        unavailableReason: eligible
          ? null
          : storageMember && !storageAvailable
            ? "Bucket is unavailable for destination writes"
            : "No longer active or authorized for this channel",
      },
    ];
  });
  for (const memberId of selected) {
    if (known.has(memberId)) continue;
    options.push({
      memberId,
      agentId: null,
      kind: "unknown",
      name: memberId,
      presence: "unknown",
      roleIds: [],
      roleNames: [],
      eligible: false,
      unavailableReason: "Member is no longer in this room",
    });
  }
  return options.sort((left, right) => left.name.localeCompare(right.name));
}

function recipientMatches(
  recipient: {
    memberId: string;
    agentId: string | null;
    name: string;
    presence: string;
    roleIds: string[];
    roleNames: string[];
  },
  filter: Pick<RoomWorkflowRecipientFilter, "query" | "roleId" | "presence">,
) {
  const needle = normalized(filter.query);
  if (
    needle &&
    !`${recipient.name} ${recipient.memberId} ${recipient.agentId ?? ""} ${recipient.roleNames.join(" ")}`
      .toLowerCase()
      .includes(needle)
  )
    return false;
  if (
    filter.roleId &&
    filter.roleId !== "all" &&
    !recipient.roleIds.includes(filter.roleId)
  )
    return false;
  return (
    !filter.presence ||
    filter.presence === "all" ||
    recipient.presence === filter.presence
  );
}

export function roomMemberCan(
  snapshot: JsonObject,
  roomId: string,
  channelId: string,
  memberId: string,
  action: "publish" | "subscribe" | "request" | "respond",
) {
  const member = records(snapshot.memberships).find(
    (member) =>
      value(member.member_id) === memberId &&
      (!value(member.room_id) || value(member.room_id) === roomId) &&
      value(member.state) === "active",
  );
  if (!member) return false;
  const subjects = authorizedSubjects(snapshot, roomId, channelId, action);
  const activeRoles = new Set(
    records(snapshot.roles)
      .filter((role) => !value(role.state) || value(role.state) === "active")
      .map((role) => value(role.role_id) ?? value(role.id)),
  );
  return (
    subjects.channelActive &&
    (subjects.memberIds.has(memberId) ||
      (memberRoleIds(snapshot, roomId).get(memberId) ?? []).some(
        (role) => activeRoles.has(role) && subjects.roleIds.has(role),
      ))
  );
}

/** Authorization boundary for a pairwise encrypted action channel. The agent
 * verifies the MLS roster separately. Manage-only members stay outside that
 * group; one of the two agent participants must manage MLS bootstrap. */
export function roomControlChannelIsPairwise(
  snapshot: JsonObject,
  roomId: string,
  channelId: string,
  controllerMemberId: string,
  recipientMemberId: string,
) {
  const channel = records(snapshot.channels).find(
    (candidate) => value(candidate.channel_id) === channelId,
  );
  if (
    !channel || channel.kind !== "message" ||
    channel.content_type !== roomActionContentType ||
    (value(channel.room_id) && value(channel.room_id) !== roomId) ||
    channel.visibility !== "restricted" || channel.state !== "active" ||
    channel.rotation_required === true ||
    controllerMemberId === recipientMemberId
  ) return false;
  const participants = new Set([controllerMemberId, recipientMemberId]);
  const memberships = records(snapshot.memberships);
  if (![...participants].every((memberId) => memberships.some((member) =>
    value(member.member_id) === memberId &&
    value(member.state) === "active" &&
    (!value(member.kind) || value(member.kind) === "agent") &&
    Boolean(value(member.agent_id))))) return false;
  const grants = records(snapshot.grants).filter(
    (grant) => value(grant.channel_id) === channelId &&
      (!value(grant.room_id) || value(grant.room_id) === roomId) &&
      value(grant.state) === "active",
  );
  if (!grants.length) return false;
  const actionsByMember = new Map<string, Set<string>>();
  for (const grant of grants) {
    const memberId = value(grant.subject_id);
    if (
      grant.subject_type !== "member" || !memberId ||
      !memberships.some((member) =>
        value(member.member_id) === memberId &&
        value(member.state) === "active") ||
      actionsByMember.has(memberId) || !Array.isArray(grant.actions)
    ) return false;
    const actions = new Set<string>();
    for (const action of grant.actions) {
      if (
        typeof action !== "string" || actions.has(action) ||
        !["discover", "publish", "subscribe", "manage"].includes(action) ||
        (!participants.has(memberId) &&
          action !== "discover" && action !== "manage")
      ) return false;
      actions.add(action);
    }
    if (actions.has("manage") && !actions.has("discover")) return false;
    actionsByMember.set(memberId, actions);
  }
  if (![...participants].some((memberId) =>
    actionsByMember.get(memberId)?.has("manage"))) return false;
  return [...participants].every((memberId) => {
    const actions = actionsByMember.get(memberId);
    return actions?.has("discover") && actions.has("publish") &&
      actions.has("subscribe");
  });
}

function authorizedSubjects(
  snapshot: JsonObject,
  roomId: string,
  channelId: string,
  action: "publish" | "subscribe" | "request" | "respond",
) {
  const channel = records(snapshot.channels).find(
    (candidate) =>
      (value(candidate.channel_id) ?? value(candidate.id)) === channelId,
  );
  const memberIds = new Set<string>();
  const roleIds = new Set<string>();
  for (const grant of records(snapshot.grants)) {
    if (
      (value(grant.state) && value(grant.state) !== "active") ||
      (value(grant.room_id) && value(grant.room_id) !== roomId) ||
      value(grant.channel_id) !== channelId ||
      !Array.isArray(grant.actions) ||
      !grant.actions.includes(action)
    )
      continue;
    const id = value(grant.subject_id);
    if (!id) continue;
    if (value(grant.subject_type) === "member") memberIds.add(id);
    if (value(grant.subject_type) === "role") roleIds.add(id);
  }
  return {
    channelActive:
      Boolean(channel) &&
      value(channel?.state) === "active" &&
      channel?.rotation_required !== true,
    memberIds,
    roleIds,
  };
}

function memberRoleIds(snapshot: JsonObject, roomId: string) {
  const roleIdsByMember = new Map<string, string[]>();
  for (const assignment of records(snapshot.member_roles)) {
    if (
      (value(assignment.state) && value(assignment.state) !== "active") ||
      (value(assignment.room_id) && value(assignment.room_id) !== roomId)
    )
      continue;
    const memberId = value(assignment.member_id);
    const roleId = value(assignment.role_id);
    if (!memberId || !roleId) continue;
    const memberRoles = roleIdsByMember.get(memberId) ?? [];
    memberRoles.push(roleId);
    roleIdsByMember.set(memberId, memberRoles);
  }
  return roleIdsByMember;
}

function page<T>(items: T[], cursor?: string, requestedLimit?: number) {
  const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
  const limit = Math.min(200, Math.max(1, Math.trunc(requestedLimit ?? 50)));
  const values = items.slice(offset, offset + limit);
  const nextOffset = offset + values.length;
  return {
    items: values,
    total: items.length,
    nextCursor: nextOffset < items.length ? String(nextOffset) : null,
  };
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function value(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : null;
}

function uniqueText(input: unknown): string[] {
  return [
    ...new Set(
      Array.isArray(input)
        ? input
            .filter(
              (item): item is string =>
                typeof item === "string" && Boolean(item.trim()),
            )
            .map((item) => item.trim())
        : [],
    ),
  ];
}

function normalized(input?: string) {
  return input?.trim().toLowerCase() ?? "";
}
