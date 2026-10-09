import { getProviderProfile } from "@beam-studio/shared";
import type { RoomAgent, RoomSnapshot, RoomStorageBinding } from "./room-data";
import {
  roomActionEvaluator,
  roomActions,
  type RoomAction,
} from "./room-permissions";

type Row = Record<string, unknown>;
export type GraphInput = Pick<
  RoomSnapshot,
  | "id"
  | "state"
  | "memberships"
  | "roles"
  | "memberRoles"
  | "channels"
  | "grants"
> & {
  agents: Pick<RoomAgent, "id" | "name" | "machineName">[];
  consumerId: string | null;
  bindings: Pick<
    RoomStorageBinding,
    "coordinatorMemberId" | "providerProfileId" | "displayName" | "bucket"
  >[];
};
export type GraphNode = {
  id: string;
  name: string;
  kind: "agent" | "service" | "storage";
  provider?: string;
  logo?: string;
  roles: string[];
  privileged: boolean;
  active: boolean;
  send: boolean;
  receive: boolean;
  permissions: { channelId: string; channel: string; actions: RoomAction[] }[];
  position: [number, number, number];
};
export type GraphDirection = {
  channelId: string;
  channel: string;
  send: RoomAction;
  receive: RoomAction;
};
export type GraphLink = {
  source: number;
  target: number;
  forward: GraphDirection[];
  reverse: GraphDirection[];
};
export type RoomGraph = {
  nodes: GraphNode[];
  links: GraphLink[];
  channels: { id: string; name: string }[];
};

const string = (value: unknown) => (typeof value === "string" ? value : "");
function pick<T extends object>(rows: T[], keys: string[]) {
  return rows
    .map((row) =>
      Object.fromEntries(keys.map((key) => [key, (row as Row)[key]])),
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Excludes leases, timestamps and presence: refreshes do not rebuild permission topology. */
export function roomGraphKey(
  room: RoomSnapshot,
  bindings: RoomStorageBinding[],
  agents: RoomAgent[],
) {
  return JSON.stringify({
    id: room.id,
    state: room.state,
    consumerId: room.consumer?.id ?? null,
    memberships: pick(room.memberships, [
      "member_id",
      "room_id",
      "agent_id",
      "principal_id",
      "kind",
      "display_name",
      "state",
      "owner",
    ]),
    roles: pick(room.roles, ["room_id", "role_id", "name", "template"]),
    memberRoles: pick(room.memberRoles, [
      "room_id",
      "member_id",
      "role_id",
      "state",
    ]),
    channels: pick(room.channels, [
      "room_id",
      "channel_id",
      "name",
      "kind",
      "state",
      "rotation_required",
      "visibility",
    ]),
    grants: pick(room.grants, [
      "room_id",
      "channel_id",
      "subject_type",
      "subject_id",
      "state",
      "actions",
    ]),
    agents: pick(agents, ["id", "name", "machineName"]),
    bindings: pick(bindings, [
      "coordinatorMemberId",
      "providerProfileId",
      "displayName",
      "bucket",
    ]),
  });
}

export function buildRoomGraph(room: GraphInput, channelId = "all"): RoomGraph {
  const evaluate = roomActionEvaluator(room);
  const channels = room.channels
    .filter((c) => c.room_id === room.id && c.state === "active")
    .map((c) => ({
      id: string(c.channel_id),
      name: string(c.name) || string(c.channel_id),
      kind: string(c.kind),
    }));
  const selected = channels.filter(
    (c) => channelId === "all" || c.id === channelId,
  );
  const roles = new Map(
    room.roles.filter((r) => r.room_id === room.id).map((r) => [r.role_id, r]),
  );
  const members = room.memberships
    .filter((m) => m.room_id === room.id)
    .sort((a, b) => string(a.member_id).localeCompare(string(b.member_id)));
  const nodes: GraphNode[] = members.map((member, index) => {
    const id = string(member.member_id);
    const agent = room.agents.find((a) => a.id === member.agent_id);
    const binding = room.bindings.find((b) => b.coordinatorMemberId === id);
    const provider = binding && getProviderProfile(binding.providerProfileId);
    const memberRoles = room.memberRoles
      .filter(
        (r) =>
          r.room_id === room.id && r.member_id === id && r.state === "active",
      )
      .map((r) => roles.get(r.role_id))
      .filter((r): r is Row => Boolean(r));
    const service =
      string(member.principal_id).startsWith("studio-organization:") ||
      (Boolean(room.consumerId) && member.agent_id === room.consumerId);
    const permissions = selected.map((channel) => ({
      channelId: channel.id,
      channel: channel.name,
      actions: roomActions.filter((action) =>
        evaluate(member, channel.id, action),
      ),
      kind: channel.kind,
    }));
    const y =
      members.length === 1 ? 0 : 1 - (2 * (index + 0.5)) / members.length;
    const radius = Math.sqrt(1 - y * y),
      angle = index * Math.PI * (3 - Math.sqrt(5));
    return {
      id,
      kind:
        member.kind === "object_storage"
          ? "storage"
          : service
            ? "service"
            : "agent",
      name:
        binding?.displayName ||
        string(member.display_name) ||
        agent?.name ||
        agent?.machineName ||
        (service
          ? "Studio organization owner"
          : string(member.principal_id) || id),
      provider: provider?.name,
      logo: provider?.logo,
      roles: [
        ...new Set([
          ...(member.owner === true ? ["Owner"] : []),
          ...memberRoles.map((r) => string(r.name)),
        ]),
      ],
      privileged:
        member.owner === true ||
        memberRoles.some(
          (r) => r.template === "owner" || r.template === "admin",
        ),
      active: room.state === "active" && member.state === "active",
      send: permissions.some((p) =>
        p.actions.includes(p.kind === "request-reply" ? "request" : "publish"),
      ),
      receive: permissions.some((p) =>
        p.actions.includes(
          p.kind === "request-reply" ? "respond" : "subscribe",
        ),
      ),
      permissions,
      position: [Math.cos(angle) * radius, y, Math.sin(angle) * radius],
    };
  });
  const links = new Map<string, GraphLink>();
  for (const channel of selected) {
    const send = channel.kind === "request-reply" ? "request" : "publish";
    const receive = channel.kind === "request-reply" ? "respond" : "subscribe";
    const senders: number[] = [],
      receivers: number[] = [];
    nodes.forEach((node, index) => {
      if (node.kind === "storage" && channel.kind !== "object") return;
      const actions =
        node.permissions.find((p) => p.channelId === channel.id)?.actions ?? [];
      if (actions.includes(send)) senders.push(index);
      if (actions.includes(receive)) receivers.push(index);
    });
    for (const sender of senders)
      for (const receiver of receivers) {
        if (sender === receiver) continue;
        const source = Math.min(sender, receiver),
          target = Math.max(sender, receiver),
          key = `${source}:${target}`;
        const link = links.get(key) ?? {
          source,
          target,
          forward: [],
          reverse: [],
        };
        (sender === source ? link.forward : link.reverse).push({
          channelId: channel.id,
          channel: channel.name,
          send,
          receive,
        });
        links.set(key, link);
      }
  }
  return { nodes, links: [...links.values()], channels };
}

export function visibleGraphLinks(graph: RoomGraph, selectedId: string | null) {
  if (graph.links.length <= 500) return graph.links;
  const selected = graph.nodes.findIndex((node) => node.id === selectedId);
  return graph.links.filter(
    (link) => link.source === selected || link.target === selected,
  );
}

export function accessLabel(node: GraphNode) {
  return node.send
    ? node.receive
      ? "Send and receive"
      : "Send only"
    : node.receive
      ? "Receive only"
      : "No data permissions";
}
