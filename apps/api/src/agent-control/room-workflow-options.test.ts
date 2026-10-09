import assert from "node:assert/strict";
import test from "node:test";
import {
  paginateRoomWorkflowRooms,
  resolveRoomWorkflowRecipients,
  roomWorkflowContext,
  roomWorkflowRecipientPage,
} from "./room-workflow-options.js";

const roomId = `btr_room_${"a".repeat(26)}`;
const channelId = "btr_channel_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const snapshot = {
  room: { room_id: roomId, state: "active" },
  channels: [
    { channel_id: channelId, name: "Files", kind: "object", state: "active" },
  ],
  roles: [
    { role_id: "role-transfer", name: "Transfer member", state: "active" },
  ],
  member_roles: [
    {
      room_id: roomId,
      member_id: "member-source",
      role_id: "role-transfer",
      state: "active",
    },
    {
      room_id: roomId,
      member_id: "member-a",
      role_id: "role-transfer",
      state: "active",
    },
    {
      room_id: roomId,
      member_id: "member-b",
      role_id: "role-transfer",
      state: "active",
    },
  ],
  memberships: [
    {
      member_id: "member-source",
      agent_id: "agent-source",
      state: "active",
      presence: "online",
    },
    {
      member_id: "member-a",
      agent_id: "agent-a",
      state: "active",
      presence: "online",
    },
    {
      member_id: "member-b",
      agent_id: "agent-b",
      state: "active",
      presence: "offline",
    },
  ],
  grants: [
    {
      room_id: roomId,
      channel_id: channelId,
      subject_type: "role",
      subject_id: "role-transfer",
      state: "active",
      actions: ["publish", "subscribe"],
    },
  ],
};
const agents = [
  {
    id: "agent-source",
    name: "Source",
    machineName: "Source host",
    platform: "linux",
    status: "online",
    capabilities: ["room-workflows/v1"],
  },
  {
    id: "agent-a",
    name: "A",
    machineName: "Recipient A",
    platform: "windows",
    status: "online",
    capabilities: ["room-workflows/v1"],
  },
  {
    id: "agent-b",
    name: "B",
    machineName: "Recipient B",
    platform: "linux",
    status: "online",
    capabilities: ["room-workflows/v1"],
  },
];

test("room choices are searched and paginated without loading snapshots", () => {
  assert.deepEqual(
    paginateRoomWorkflowRooms(
      [
        { id: "room-b", name: "Beta", state: "active" },
        { id: "room-a", name: "Alpha", state: "active" },
      ],
      "a",
      "0",
      1,
    ),
    {
      items: [{ id: "room-a", name: "Alpha", state: "active" }],
      total: 2,
      nextCursor: "1",
    },
  );
});

test("selected room context exposes active object channels and eligible sources", () => {
  const context = roomWorkflowContext(
    roomId,
    "Production room",
    snapshot,
    agents,
  );
  assert.deepEqual(context.channels, [
    { id: channelId, name: "Files", description: null },
  ]);
  assert.deepEqual(context.sources, [
    {
      id: "member-a",
      agentId: "agent-a",
      kind: "agent",
      name: "Recipient A",
      platform: "windows",
      channelIds: [channelId],
      credentialId: null,
      providerProfileId: null,
      bucket: null,
    },
    {
      id: "member-b",
      agentId: "agent-b",
      kind: "agent",
      name: "Recipient B",
      platform: "linux",
      channelIds: [channelId],
      credentialId: null,
      providerProfileId: null,
      bucket: null,
    },
    {
      id: "member-source",
      agentId: "agent-source",
      kind: "agent",
      name: "Source host",
      platform: "linux",
      channelIds: [channelId],
      credentialId: null,
      providerProfileId: null,
      bucket: null,
    },
  ]);
  assert.deepEqual(context.roles, [
    { id: "role-transfer", name: "Transfer member" },
  ]);
});

test("recipients support role, presence, selected-only and stale selection handling", () => {
  const page = roomWorkflowRecipientPage(roomId, snapshot, agents, {
    channelId,
    sourceMemberId: "member-source",
    roleId: "role-transfer",
    presence: "online",
    selectedOnly: true,
    selectedMemberIds: ["member-a", "member-missing"],
  });
  assert.deepEqual(
    page.items.map((item) => item.memberId),
    ["member-a"],
  );
  assert.equal(page.selectedCount, 2);
  assert.equal(page.ineligibleSelectedCount, 1);
});

test("available storage bindings are first-class sources and recipients", () => {
  const storageSnapshot = {
    ...snapshot,
    memberships: [
      ...snapshot.memberships,
      {
        member_id: "member-storage",
        resource_id: "resource-storage",
        display_name: "Archive bucket",
        kind: "object_storage",
        state: "active",
        presence: "online",
        object_capabilities: ["source", "destination"],
      },
    ],
    grants: [
      ...snapshot.grants,
      {
        room_id: roomId,
        channel_id: channelId,
        subject_type: "member",
        subject_id: "member-storage",
        state: "active",
        actions: ["publish", "subscribe"],
      },
    ],
  };
  const bindings = [
    {
      coordinatorMemberId: "member-storage",
      credentialId: "credential-storage",
      providerProfileId: "r2",
      bucket: "archive",
      availability: "available",
    },
  ];
  const context = roomWorkflowContext(
    roomId,
    "Production room",
    storageSnapshot,
    agents,
    bindings,
  );
  assert.deepEqual(
    context.sources.find((source) => source.id === "member-storage"),
    {
      id: "member-storage",
      agentId: null,
      kind: "object_storage",
      name: "Archive bucket",
      platform: null,
      channelIds: [channelId],
      credentialId: "credential-storage",
      providerProfileId: "r2",
      bucket: "archive",
    },
  );
  const page = roomWorkflowRecipientPage(
    roomId,
    storageSnapshot,
    agents,
    {
      channelId,
      sourceMemberId: "member-source",
    },
    bindings,
  );
  assert.equal(
    page.items.find((item) => item.memberId === "member-storage")?.eligible,
    true,
  );
});

test("select all matching resolves every authorized recipient without an editor cap", () => {
  const largeSnapshot = {
    ...snapshot,
    memberships: [
      snapshot.memberships[0],
      ...Array.from({ length: 1_001 }, (_, index) => ({
        member_id: `member-${index}`,
        agent_id: `recipient-${index}`,
        state: "active",
        presence: "online",
      })),
    ],
    grants: [
      snapshot.grants[0],
      ...Array.from({ length: 1_001 }, (_, index) => ({
        room_id: roomId,
        channel_id: channelId,
        subject_type: "member",
        subject_id: `member-${index}`,
        state: "active",
        actions: ["subscribe"],
      })),
    ],
  };
  const recipients = resolveRoomWorkflowRecipients(
    roomId,
    largeSnapshot,
    agents,
    {
      channelId,
      sourceMemberId: "member-source",
    },
  );
  assert.equal(recipients.length, 1_001);
});
