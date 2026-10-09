import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRoomGraph,
  roomGraphKey,
  visibleGraphLinks,
  type GraphInput,
} from "./room-member-graph-model";
import { roomActionEvaluator } from "./room-permissions";
import type { RoomSnapshot } from "./room-data";

function fixture(count = 3): GraphInput {
  return {
    id: "room",
    state: "active",
    consumerId: null,
    agents: [],
    bindings: [],
    roles: [],
    memberRoles: [],
    memberships: Array.from({ length: count }, (_, i) => ({
      room_id: "room",
      member_id: `m${i}`,
      state: "active",
      presence: "online",
    })),
    channels: [
      {
        room_id: "room",
        channel_id: "objects",
        name: "Objects",
        kind: "object",
        state: "active",
      },
    ],
    grants: [],
  };
}
function grant(
  room: GraphInput,
  subject: string,
  actions: string[],
  channel = "objects",
  type = "member",
) {
  room.grants.push({
    room_id: room.id,
    channel_id: channel,
    subject_type: type,
    subject_id: subject,
    actions,
    state: "active",
  });
}

test("exact grants combine direct and active roles; management, ownership and presence do not confer data access", () => {
  const room = fixture();
  room.memberships[0]!.owner = true;
  grant(room, "m0", ["manage", "observe", "discover"]);
  grant(room, "sender", ["publish"], "objects", "role");
  room.memberRoles.push({
    room_id: room.id,
    member_id: "m1",
    role_id: "sender",
    state: "active",
  });
  grant(room, "m2", ["subscribe"]);
  room.memberships[1]!.presence = "offline";
  const can = roomActionEvaluator(room);
  assert.equal(can(room.memberships[0]!, "objects", "publish"), false);
  assert.equal(can(room.memberships[1]!, "objects", "publish"), true);
  assert.equal(can(room.memberships[1]!, "objects", "subscribe"), false);
  const graph = buildRoomGraph(room);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.links.length, 1);
  assert.equal(graph.nodes[0]!.privileged, true);
  assert.deepEqual(
    graph.links[0]!.forward.map((d) => [d.send, d.receive]),
    [["publish", "subscribe"]],
  );
  room.memberRoles[0]!.state = "revoked";
  assert.equal(buildRoomGraph(room).links.length, 0);
});

test("membership, grant, room and channel revocation/rotation remove links without hiding nodes", () => {
  for (const mutate of [
    (r: GraphInput) => {
      r.memberships[0]!.state = "left";
    },
    (r: GraphInput) => {
      r.grants[0]!.state = "revoked";
    },
    (r: GraphInput) => {
      r.channels[0]!.state = "closed";
    },
    (r: GraphInput) => {
      r.channels[0]!.rotation_required = true;
    },
    (r: GraphInput) => {
      r.state = "closed";
    },
    (r: GraphInput) => {
      r.grants[0]!.room_id = "other";
    },
  ]) {
    const room = fixture();
    grant(room, "m0", ["publish"]);
    grant(room, "m1", ["subscribe"]);
    assert.equal(buildRoomGraph(room).links.length, 1);
    mutate(room);
    assert.equal(buildRoomGraph(room).links.length, 0);
    assert.equal(buildRoomGraph(room).nodes.length, 3);
  }
});

test("permissions never cross channels; aggregate directions preserve supporting channels and actions", () => {
  const room = fixture();
  room.channels.push({
    room_id: room.id,
    channel_id: "second",
    name: "Second",
    kind: "object",
    state: "active",
  });
  grant(room, "m0", ["publish"]);
  grant(room, "m1", ["subscribe"], "second");
  assert.equal(buildRoomGraph(room).links.length, 0);
  grant(room, "m1", ["subscribe"]);
  grant(room, "m1", ["publish"], "second");
  grant(room, "m0", ["subscribe"], "second");
  const graph = buildRoomGraph(room);
  assert.equal(graph.links.length, 1);
  assert.deepEqual(
    graph.links[0]!.forward.map((d) => d.channelId),
    ["objects"],
  );
  assert.deepEqual(
    graph.links[0]!.reverse.map((d) => d.channelId),
    ["second"],
  );
  assert.equal(buildRoomGraph(room, "objects").links[0]!.reverse.length, 0);
});

test("request/reply uses request/respond, never publish/subscribe or observe", () => {
  const room = fixture();
  room.channels[0]!.kind = "request-reply";
  grant(room, "m0", ["publish", "subscribe", "observe"]);
  grant(room, "m1", ["publish", "subscribe"]);
  assert.equal(buildRoomGraph(room).links.length, 0);
  grant(room, "m0", ["request"]);
  grant(room, "m1", ["respond"]);
  const link = buildRoomGraph(room).links[0]!;
  assert.deepEqual(
    link.forward.map((d) => [d.send, d.receive]),
    [["request", "respond"]],
  );
});

test("provider catalog and service identities are explicit, with actual role names", () => {
  const room = fixture(5);
  for (const [i, provider] of ["hippius", "r2", "huggingface"].entries()) {
    room.memberships[i]!.kind = "object_storage";
    room.bindings.push({
      coordinatorMemberId: `m${i}`,
      providerProfileId: provider,
      displayName: provider,
      bucket: "bucket",
    });
  }
  room.memberships[3]!.principal_id = "studio-organization:org";
  room.memberships[3]!.owner = true;
  room.memberships[4]!.agent_id = "consumer";
  room.consumerId = "consumer";
  room.roles.push({
    room_id: room.id,
    role_id: "admin",
    template: "admin",
    name: "Administrator",
  });
  room.memberRoles.push({
    room_id: room.id,
    member_id: "m4",
    role_id: "admin",
    state: "active",
  });
  const graph = buildRoomGraph(room);
  assert.deepEqual(
    graph.nodes.slice(0, 3).map((n) => n.provider),
    ["Hippius", "Cloudflare R2", "Hugging Face"],
  );
  assert.ok(graph.nodes.slice(0, 3).every((n) => n.logo));
  assert.deepEqual(
    graph.nodes.slice(3).map((n) => n.kind),
    ["service", "service"],
  );
  assert.equal(graph.nodes[4]!.privileged, true);
  assert.equal(graph.links.length, 0);
});

test("lease, presence and ordering changes preserve normalized topology; grant changes invalidate it", () => {
  const room = { ...fixture(), consumer: null } as unknown as RoomSnapshot;
  const before = roomGraphKey(room, [], []);
  room.memberships[0]!.lease_version = 42;
  room.memberships[0]!.updated_at = "later";
  room.memberships[0]!.presence = "offline";
  room.memberships.reverse();
  assert.equal(roomGraphKey(room, [], []), before);
  room.memberships[0]!.state = "left";
  assert.notEqual(roomGraphKey(room, [], []), before);
});

test("dense rooms retain every node and show only selected-member connections above 500", () => {
  const room = fixture(100);
  for (const member of room.memberships)
    grant(room, String(member.member_id), ["publish", "subscribe"]);
  const graph = buildRoomGraph(room);
  assert.equal(graph.nodes.length, 100);
  assert.equal(graph.links.length, 4950);
  assert.equal(visibleGraphLinks(graph, "m0").length, 99);
  assert.equal(visibleGraphLinks(graph, null).length, 0);
  const sparse = { ...graph, links: graph.links.slice(0, 500) };
  assert.equal(visibleGraphLinks(sparse, null).length, 500);
});
