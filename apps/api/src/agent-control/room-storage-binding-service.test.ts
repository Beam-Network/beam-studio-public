import assert from "node:assert/strict";
import test from "node:test";
import type { RoomStorageBindingInput } from "@beam-studio/shared";
import type { CoordinatorRoomClient } from "./coordinator-client.js";
import {
  attachAndAuthorizeCoordinatorStorageMember,
  type RoomStorageTarget,
} from "./room-storage-binding-service.js";

const roomId = `btr_room_${"a".repeat(26)}`;
const channelId = "btr_channel_qcbinvelbbcautngwm3m2zmaca";
const memberId = "btr_member_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const delegateId = "btr_member_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const roleId = "btr_role_cccccccccccccccccccccccccc";
const resourceId = "room-storage-resource";

const parsed: RoomStorageBindingInput = {
  environmentTemplateKey: "dev",
  roomId,
  credentialId: "credential",
  bucket: "bucket",
  displayName: "Bucket",
  objectChannelIds: [channelId],
  destinationPrefix: "",
  destinationLayout: "isolated",
  collisionPolicy: "fail_if_exists",
  sourceDelegateMemberIds: [delegateId],
  sourceDelegateRoleIds: [roleId],
  roleIds: [roleId],
};

const snapshot = {
  room: { authorization_epoch: 11 },
  channels: [
    {
      channel_id: channelId,
      channel_revision: 4,
      kind: "object",
      state: "active",
    },
  ],
  roles: [{ role_id: roleId, state: "active" }],
  memberships: [
    { member_id: delegateId, kind: "agent", state: "active" },
    { member_id: memberId, kind: "object_storage", state: "active" },
  ],
};

test("storage attachment authorizes from the post-attachment epoch", async () => {
  const calls: Array<{
    operation: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }> = [];
  const coordinator = {
    async attachOrganizationRoomStorage(
      _organizationId: string,
      _roomId: string,
      _resource: unknown,
      idempotencyKey: string,
    ) {
      assert.equal(
        idempotencyKey,
        `storage-member:${resourceId}:attempt-one`,
      );
      return { created: true, membership: { member_id: memberId } };
    },
    async organizationRoomSnapshot() {
      return snapshot;
    },
    async mutateOrganizationRoom(
      _organizationId: string,
      operation: string,
      payload: Record<string, unknown>,
      idempotencyKey: string,
    ) {
      calls.push({ operation, payload, idempotencyKey });
      if (operation === "room.role.assign") {
        assert.equal(payload.expected_authorization_epoch, 11);
        return { authorization_epoch: 12 };
      }
      assert.equal(operation, "room.grant.put");
      assert.equal(payload.expected_authorization_epoch, 12);
      assert.equal(payload.expected_channel_revision, 4);
      return {
        authorization_epoch: 13,
        channel: { channel_revision: 5 },
      };
    },
  } as unknown as CoordinatorRoomClient;

  const result = await attachAndAuthorizeCoordinatorStorageMember({
    organizationId: "organization",
    roomId,
    resourceId,
    parsed,
    target: target(coordinator),
    attemptId: "attempt-one",
  });

  assert.equal(result.memberId, memberId);
  assert.deepEqual(
    calls.map((call) => [call.operation, call.idempotencyKey]),
    [
      [
        "room.role.assign",
        `storage-role:${resourceId}:attempt-one:${roleId}`,
      ],
      [
        "room.grant.put",
        `storage-grant:${resourceId}:attempt-one:${channelId}`,
      ],
    ],
  );
});

test("failed authorization rolls back with the same attempt namespace", async () => {
  const calls: Array<{ operation: string; idempotencyKey: string }> = [];
  const coordinator = {
    async attachOrganizationRoomStorage() {
      return { created: true, membership: { member_id: memberId } };
    },
    async organizationRoomSnapshot() {
      return snapshot;
    },
    async mutateOrganizationRoom(
      _organizationId: string,
      operation: string,
      _payload: Record<string, unknown>,
      idempotencyKey: string,
    ) {
      calls.push({ operation, idempotencyKey });
      if (operation === "room.role.assign") {
        throw new Error("stale authorization");
      }
      return {};
    },
  } as unknown as CoordinatorRoomClient;

  await assert.rejects(
    attachAndAuthorizeCoordinatorStorageMember({
      organizationId: "organization",
      roomId,
      resourceId,
      parsed,
      target: target(coordinator),
      attemptId: "attempt-two",
    }),
    /stale authorization/,
  );

  assert.deepEqual(calls, [
    {
      operation: "room.role.assign",
      idempotencyKey: `storage-role:${resourceId}:attempt-two:${roleId}`,
    },
    {
      operation: "room.membership.remove",
      idempotencyKey: `storage-attach-rollback:${resourceId}:attempt-two`,
    },
  ]);
});

function target(coordinator: CoordinatorRoomClient): RoomStorageTarget {
  return { coordinator, token: "token", templateKey: "dev" };
}
