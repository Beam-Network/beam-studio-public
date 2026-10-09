import { roomScopeKey, selectedRoomTemplateKey } from "@/lib/beam-environments";
import { apiFetch, apiGet, apiSend } from "@/lib/api-client";

export type RoomAgent = {
  id: string;
  machineName?: string | null;
  name?: string | null;
  status: string;
  capabilities?: unknown[];
};

export type RoomCommand = {
  id: string;
  agentId: string;
  operation: string;
  state: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type RoomEvent = {
  id: string;
  agentId: string;
  commandId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  createdAt?: string | null;
};

export type RoomSnapshot = {
  id: string;
  label: string | null;
  state: string;
  readOnly: boolean;
  canManage: boolean;
  accessRole: "owner" | "admin" | "member";
  agent: RoomAgent | null;
  consumer: RoomAgent | null;
  metadata: Record<string, unknown>;
  membership: Record<string, unknown>;
  resume: Record<string, unknown>;
  roles: Record<string, unknown>[];
  memberRoles: Record<string, unknown>[];
  channels: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  invitations: Record<string, unknown>[];
  grants: Record<string, unknown>[];
  commands: RoomCommand[];
  events: RoomEvent[];
  updatedAt: string | null;
};

export type RoomChannel = {
  description: string;
  endpoint: string | null;
  group: string;
  id: string;
  kind: string;
  name: string;
  raw: Record<string, unknown>;
  state: string;
  target: string | null;
};

/** Why no online Studio room consumer can serve the organization's rooms. */
export type RoomConsumerUnavailableReason =
  | "not_enrolled"
  | "not_authorized"
  | "offline";

export type RoomsSnapshot = {
  agents: RoomAgent[];
  consumer: RoomAgent | null;
  consumerUnavailableReason: RoomConsumerUnavailableReason | null;
  rooms: RoomSnapshot[];
};

export type RoomStorageBinding = {
  id: string;
  roomId: string;
  environmentTemplateKey: string;
  credentialId: string;
  providerProfileId: string;
  bucket: string;
  displayName: string;
  resourceId: string;
  coordinatorMemberId: string;
  objectChannelIds: string[];
  destinationPrefix: string;
  destinationLayout: "isolated" | "preserve_path" | "flat_name";
  collisionPolicy: "fail_if_exists" | "overwrite";
  sourceDelegateMemberIds: string[];
  sourceDelegateRoleIds: string[];
  roleIds: string[];
  availability: "online" | "offline";
};

type RoomStorageBindingsPayload = {
  bindings: RoomStorageBinding[];
};

type CommandsPayload = { commands?: RoomCommand[] };
type CreatedCommandPayload = { command: RoomCommand; dispatched: boolean };
type DelegatedRoomPayload = {
  result: Record<string, unknown>;
  delegated: boolean;
};
type CoordinatorRoomsPayload = {
  agents?: RoomAgent[];
  consumer?: RoomAgent | null;
  consumerUnavailableReason?: RoomConsumerUnavailableReason | null;
  rooms?: Record<string, unknown>[];
};

export const roomsQueryKey = [
  "/studio/rooms",
  "coordinator",
  roomScopeKey(),
] as const;

export async function fetchRoomsSnapshot(
  options: {
    templateKey?: string;
  } = {},
): Promise<RoomsSnapshot> {
  const headers: Record<string, string> = {};
  const templateKey = options.templateKey ?? selectedRoomTemplateKey();
  if (templateKey) {
    headers["x-beam-environment-template"] = templateKey;
  }
  const response = await apiFetch<CoordinatorRoomsPayload>("/studio/rooms", {
    headers,
  });
  const agents = (response.agents ?? []).filter(supportsRooms);
  const rooms = new Map<string, RoomSnapshot>();
  for (const raw of records(response.rooms)) {
    const metadata = record(raw.room);
    const roomId = text(metadata.room_id);
    const agentValue = record(raw.agent) as RoomAgent;
    const agent = agentValue.id ? agentValue : null;
    if (!roomId) continue;
    const coordinator = record(raw.coordinator);
    const access = record(raw.access);
    const membership = record(raw.membership);
    const roles = records(raw.roles);
    const memberRoles = records(raw.member_roles);
    const accessRole = roomAccessRole(access, membership, roles, memberRoles);
    const canManage =
      access.can_manage === true ||
      text(access.scope) === "organization" ||
      accessRole === "owner" ||
      accessRole === "admin";
    const candidate: RoomSnapshot = {
      id: roomId,
      label: text(raw.label),
      state: text(metadata.state) ?? "unknown",
      readOnly: access.read_only === true || !canManage,
      canManage,
      accessRole,
      agent,
      consumer: response.consumer ?? null,
      metadata,
      membership,
      resume: {
        active_coordinator_url: text(coordinator.url),
      },
      roles,
      memberRoles,
      channels: records(raw.channels),
      memberships: records(raw.memberships),
      invitations: records(raw.invitations),
      grants: records(raw.grants),
      commands: records(raw.commands) as RoomCommand[],
      events: records(raw.events) as RoomEvent[],
      updatedAt: text(metadata.updated_at) ?? text(metadata.created_at),
    };
    const current = rooms.get(roomId);
    if (!current || preferRoom(candidate, current))
      rooms.set(roomId, candidate);
  }

  return {
    agents,
    consumer: response.consumer ?? null,
    consumerUnavailableReason: response.consumerUnavailableReason ?? null,
    rooms: [...rooms.values()].sort(
      (left, right) =>
        right.updatedAt?.localeCompare(left.updatedAt ?? "") ?? -1,
    ),
  };
}

function roomAccessRole(
  access: Record<string, unknown>,
  membership: Record<string, unknown>,
  roles: Record<string, unknown>[],
  memberRoles: Record<string, unknown>[],
): "owner" | "admin" | "member" {
  const declared = text(access.role)?.toLowerCase();
  if (declared === "owner" || declared === "admin") return declared;
  if (text(access.scope) === "organization" || membership.owner === true) {
    return "owner";
  }
  const memberId = text(membership.member_id);
  if (!memberId) return "member";
  const roleTemplates = new Map(
    roles.map((role) => [
      text(role.role_id),
      text(role.template)?.toLowerCase(),
    ]),
  );
  for (const assignment of memberRoles) {
    if (
      text(assignment.member_id) !== memberId ||
      (text(assignment.state) ?? "active") !== "active"
    ) {
      continue;
    }
    const template = roleTemplates.get(text(assignment.role_id));
    if (template === "owner") return "owner";
    if (template === "admin") return "admin";
  }
  return "member";
}

/**
 * Runs a room operation. `room.create` is billable, so it names the Beam API
 * key that pays for the room and always goes through the organization's own
 * delegated path: Studio holds the key and forwards it server-side, so no key
 * secret is ever sent to an agent.
 */
export async function runRoomCommand(
  agentId: string | null,
  operation: string,
  payload: Record<string, unknown> = {},
  apiKeyId?: string,
) {
  if (!agentId || operation === "room.create") {
    const idempotencyKey = crypto.randomUUID();
    const roomId = text(payload.room_id);
    if (operation !== "room.create" && !roomId) {
      throw new Error(
        "room_id is required for an organization room operation.",
      );
    }
    const created = await apiSend<DelegatedRoomPayload>(
      "POST",
      operation === "room.create"
        ? "/studio/rooms"
        : `/studio/rooms/${encodeURIComponent(roomId!)}/commands`,
      operation === "room.create"
        ? { operation, payload, idempotencyKey, apiKeyId }
        : { operation, payload, idempotencyKey },
    );
    return {
      id: idempotencyKey,
      agentId: "",
      operation,
      state: "completed",
      payload,
      result: created.result,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies RoomCommand;
  }
  const created = await apiSend<CreatedCommandPayload>(
    "POST",
    `/studio/agents/${encodeURIComponent(agentId)}/commands`,
    {
      operation,
      payload,
      idempotencyKey: crypto.randomUUID(),
    },
  );

  if (terminalStates.has(created.command.state)) {
    return completedRoomCommand(created.command, operation);
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await apiGet<CommandsPayload>(
      `/studio/agents/${encodeURIComponent(agentId)}/commands`,
    );
    const command = response.commands?.find(
      (item) => item.id === created.command.id,
    );
    if (!command || !terminalStates.has(command.state)) {
      await delay(250);
      continue;
    }
    return completedRoomCommand(command, operation);
  }

  throw new Error(`${operation} did not complete in time.`);
}

function completedRoomCommand(command: RoomCommand, operation: string) {
  if (command.state !== "completed") {
    throw new Error(
      text(command.error?.message) ??
        `${operation} ended with state ${command.state}.`,
    );
  }
  return command;
}

export function roomCommandMatches(command: RoomCommand, roomId: string) {
  if (!command.operation.startsWith("room.")) return false;
  if (text(command.payload?.room_id) === roomId) return true;
  return containsRoomId(command.result, roomId);
}

export function roomAgentName(agent: RoomAgent | null) {
  return agent
    ? agent.name || agent.machineName || agent.id
    : "Organization-owned";
}

export function roomDisplayName(room: Pick<RoomSnapshot, "id" | "label">) {
  return room.label ?? room.id;
}

export async function updateRoomLabel(roomId: string, label: string | null) {
  return apiSend<{ roomId: string; label: string | null }>(
    "PATCH",
    `/studio/rooms/${encodeURIComponent(roomId)}`,
    { label },
  );
}

export function roomStorageBindingsQueryKey(roomId: string) {
  return [`/studio/rooms/${roomId}/storage-members`, roomScopeKey()] as const;
}

export async function fetchRoomStorageBindings(roomId: string) {
  return apiGet<RoomStorageBindingsPayload>(
    `/studio/rooms/${encodeURIComponent(roomId)}/storage-members`,
  );
}

export async function attachRoomStorageMember(
  roomId: string,
  input: {
    credentialId: string;
    bucket: string;
    displayName: string;
    objectChannelIds: string[];
    destinationPrefix: string;
    destinationLayout: RoomStorageBinding["destinationLayout"];
    collisionPolicy: RoomStorageBinding["collisionPolicy"];
    sourceDelegateMemberIds: string[];
    sourceDelegateRoleIds: string[];
    roleIds: string[];
  },
) {
  return apiSend<{ binding: RoomStorageBinding }>(
    "POST",
    `/studio/rooms/${encodeURIComponent(roomId)}/storage-members`,
    input,
  );
}

export async function removeRoomStorageMember(
  roomId: string,
  bindingId: string,
) {
  return apiSend<{ removed: true }>(
    "DELETE",
    `/studio/rooms/${encodeURIComponent(roomId)}/storage-members/${encodeURIComponent(bindingId)}`,
  );
}

export function roomCoordinator(room: RoomSnapshot) {
  return (
    text(room.resume.active_coordinator_url) ??
    records(room.resume.coordinator_urls).map(String)[0] ??
    (Array.isArray(room.resume.coordinator_urls)
      ? text(room.resume.coordinator_urls[0])
      : null)
  );
}

export function roomChannels(room: RoomSnapshot | null): RoomChannel[] {
  if (!room) return [];
  return room.channels.map((raw, index) => {
    const kind = text(raw.kind) ?? text(raw.transport) ?? "channel";
    const id = text(raw.channel_id) ?? text(raw.id) ?? `channel-${index + 1}`;
    return {
      description:
        text(raw.description) ?? `${kind} channel reported by the coordinator`,
      endpoint:
        text(raw.endpoint) ?? text(raw.public_url) ?? text(raw.public_endpoint),
      group: channelGroup(kind),
      id,
      kind,
      name: text(raw.name) ?? id,
      raw,
      state: text(raw.state) ?? "unknown",
      target: text(raw.target) ?? text(raw.local_target),
    };
  });
}

function supportsRooms(agent: RoomAgent) {
  return (
    agent.status !== "revoked" &&
    (agent.capabilities ?? []).some((capability) => capability === "rooms")
  );
}

function channelGroup(kind: string) {
  if (["object", "file", "blob"].includes(kind)) return "Objects";
  if (["message", "stream"].includes(kind)) return "Messaging";
  return "Network";
}

function preferRoom(candidate: RoomSnapshot, current: RoomSnapshot) {
  if (candidate.readOnly !== current.readOnly) return !candidate.readOnly;
  if (!current.agent && candidate.agent) return true;
  if (current.agent && !candidate.agent) return false;
  if (!current.agent || !candidate.agent) return false;
  if (
    candidate.agent.status === "online" &&
    current.agent.status !== "online"
  ) {
    return true;
  }
  if (
    candidate.membership.owner === true &&
    current.membership.owner !== true
  ) {
    return true;
  }
  return (candidate.updatedAt ?? "") > (current.updatedAt ?? "");
}

function containsRoomId(value: unknown, roomId: string): boolean {
  if (typeof value === "string") return value === roomId;
  if (Array.isArray(value)) {
    return value.some((item) => containsRoomId(item, roomId));
  }
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) =>
    containsRoomId(item, roomId),
  );
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

const terminalStates = new Set(["completed", "failed", "cancelled", "expired"]);
