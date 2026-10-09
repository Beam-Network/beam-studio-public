import { randomUUID } from "node:crypto";
import {
  roomStorageBindingInputSchema,
  roomStorageBindingUpdateSchema,
  type RoomStorageBindingInput,
  type RoomStorageBindingUpdate,
} from "@beam-studio/shared";
import type { CoordinatorRoomClient } from "./coordinator-client.js";
import {
  createRoomStorageBinding,
  listRoomStorageBindings,
  requireRoomStorageCredential,
  revokeRoomStorageBinding,
  roomStorageResourceId,
  updateRoomStorageBinding,
} from "../studio/store.js";

type JsonObject = Record<string, unknown>;

export type RoomStorageTarget = {
  coordinator: CoordinatorRoomClient;
  token: string;
  templateKey: string;
};

export async function listStorageMembers(input: {
  organizationId: string;
  roomId: string;
  target: RoomStorageTarget;
}) {
  return listRoomStorageBindings(
    input.organizationId,
    input.target.templateKey,
    input.roomId,
  );
}

export async function attachStorageMember(input: {
  organizationId: string;
  roomId: string;
  target: RoomStorageTarget;
  value: unknown;
}) {
  const parsed = roomStorageBindingInputSchema.parse({
    ...(object(input.value) as Record<string, unknown>),
    roomId: input.roomId,
    environmentTemplateKey: input.target.templateKey,
  });
  const credential = await requireRoomStorageCredential(
    input.organizationId,
    parsed.credentialId,
  );
  const snapshot = await input.target.coordinator.organizationRoomSnapshot(
    input.organizationId,
    input.roomId,
    input.target.token,
  );
  validateRoomStorageAttachment(snapshot, parsed);
  const resourceId = roomStorageResourceId({
    organizationId: input.organizationId,
    environmentTemplateKey: input.target.templateKey,
    credentialId: parsed.credentialId,
    providerProfileId: credential.providerProfileId,
    bucket: parsed.bucket,
  });
  const { attached, attemptId, memberId } =
    await attachAndAuthorizeCoordinatorStorageMember({
      organizationId: input.organizationId,
      roomId: input.roomId,
      resourceId,
      parsed,
      target: input.target,
    });
  try {
    const binding = await createRoomStorageBinding({
      organizationId: input.organizationId,
      environmentTemplateKey: input.target.templateKey,
      roomId: input.roomId,
      credentialId: parsed.credentialId,
      providerProfileId: credential.providerProfileId,
      bucket: parsed.bucket,
      coordinatorMemberId: memberId,
      displayName: parsed.displayName,
      objectChannelIds: parsed.objectChannelIds,
      destinationPrefix: parsed.destinationPrefix,
      destinationLayout: parsed.destinationLayout,
      collisionPolicy: parsed.collisionPolicy,
      sourceDelegateMemberIds: parsed.sourceDelegateMemberIds,
      sourceDelegateRoleIds: parsed.sourceDelegateRoleIds,
    });
    return { binding, membership: attached.membership };
  } catch (error) {
    if (attached.created) {
      await input.target.coordinator
        .mutateOrganizationRoom(
          input.organizationId,
          "room.membership.remove",
          { room_id: input.roomId, member_id: memberId },
          `storage-attach-rollback:${resourceId}:${attemptId}`,
          input.target.token,
        )
        .catch(() => undefined);
    }
    throw error;
  }
}

export async function attachAndAuthorizeCoordinatorStorageMember(input: {
  organizationId: string;
  roomId: string;
  resourceId: string;
  parsed: RoomStorageBindingInput;
  target: RoomStorageTarget;
  attemptId?: string;
}) {
  const attemptId = input.attemptId ?? randomUUID();
  const attached = await input.target.coordinator.attachOrganizationRoomStorage(
    input.organizationId,
    input.roomId,
    {
      resourceId: input.resourceId,
      displayName: input.parsed.displayName,
      objectCapabilities: ["source", "destination"],
      available: true,
    },
    `storage-member:${input.resourceId}:${attemptId}`,
    input.target.token,
  );
  const memberId = optionalText(object(attached.membership).member_id);
  if (!memberId) {
    throw serviceError(
      "coordinator_storage_member_invalid",
      "Coordinator omitted the storage member identity.",
      502,
    );
  }
  try {
    const authorizationSnapshot =
      await input.target.coordinator.organizationRoomSnapshot(
        input.organizationId,
        input.roomId,
        input.target.token,
      );
    validateRoomStorageAttachment(authorizationSnapshot, input.parsed);
    await applyStorageAuthorization({
      organizationId: input.organizationId,
      roomId: input.roomId,
      memberId,
      resourceId: input.resourceId,
      parsed: input.parsed,
      snapshot: authorizationSnapshot,
      attemptId,
      target: input.target,
    });
    return { attached, attemptId, memberId };
  } catch (error) {
    if (attached.created) {
      await input.target.coordinator
        .mutateOrganizationRoom(
          input.organizationId,
          "room.membership.remove",
          { room_id: input.roomId, member_id: memberId },
          `storage-attach-rollback:${input.resourceId}:${attemptId}`,
          input.target.token,
        )
        .catch(() => undefined);
    }
    throw error;
  }
}

export async function updateStorageMember(input: {
  organizationId: string;
  roomId: string;
  bindingId: string;
  target: RoomStorageTarget;
  value: unknown;
}) {
  const parsed = roomStorageBindingUpdateSchema.parse(input.value);
  const bindings = await listStorageMembers(input);
  const binding = bindings.find(
    (candidate) => candidate.id === input.bindingId,
  );
  if (!binding) throw bindingNotFound();
  const snapshot = await input.target.coordinator.organizationRoomSnapshot(
    input.organizationId,
    input.roomId,
    input.target.token,
  );
  validateDelegates(
    snapshot,
    parsed.sourceDelegateMemberIds,
    parsed.sourceDelegateRoleIds,
  );
  const updated = await updateRoomStorageBinding({
    organizationId: input.organizationId,
    bindingId: input.bindingId,
    ...parsed,
  });
  if (!updated) throw bindingNotFound();
  return updated;
}

export async function removeStorageMember(input: {
  organizationId: string;
  roomId: string;
  bindingId: string;
  target: RoomStorageTarget;
}) {
  const bindings = await listStorageMembers(input);
  const binding = bindings.find(
    (candidate) => candidate.id === input.bindingId,
  );
  if (!binding) throw bindingNotFound();
  await input.target.coordinator.mutateOrganizationRoom(
    input.organizationId,
    "room.membership.remove",
    { room_id: input.roomId, member_id: binding.coordinatorMemberId },
    `storage-remove:${binding.id}`,
    input.target.token,
  );
  const revoked = await revokeRoomStorageBinding(
    input.organizationId,
    binding.id,
  );
  if (!revoked) throw bindingNotFound();
}

async function applyStorageAuthorization(input: {
  organizationId: string;
  roomId: string;
  memberId: string;
  resourceId: string;
  parsed: RoomStorageBindingInput;
  snapshot: JsonObject;
  attemptId: string;
  target: RoomStorageTarget;
}) {
  let authorizationEpoch = numeric(
    object(input.snapshot.room).authorization_epoch,
  );
  const channelRevisions = new Map(
    array(input.snapshot.channels).map((value) => [
      requiredText(value.channel_id),
      numeric(value.channel_revision),
    ]),
  );
  for (const roleId of input.parsed.roleIds) {
    const result = await input.target.coordinator.mutateOrganizationRoom(
      input.organizationId,
      "room.role.assign",
      {
        room_id: input.roomId,
        member_id: input.memberId,
        role_id: roleId,
        expected_authorization_epoch: authorizationEpoch,
      },
      `storage-role:${input.resourceId}:${input.attemptId}:${roleId}`,
      input.target.token,
    );
    authorizationEpoch = mutationAuthorizationEpoch(result, authorizationEpoch);
  }
  for (const channelId of input.parsed.objectChannelIds) {
    const result = await input.target.coordinator.mutateOrganizationRoom(
      input.organizationId,
      "room.grant.put",
      {
        room_id: input.roomId,
        channel_id: channelId,
        subject_type: "member",
        subject_id: input.memberId,
        actions: ["discover", "publish", "subscribe"],
        expected_authorization_epoch: authorizationEpoch,
        expected_channel_revision: channelRevisions.get(channelId) ?? 0,
      },
      `storage-grant:${input.resourceId}:${input.attemptId}:${channelId}`,
      input.target.token,
    );
    authorizationEpoch = mutationAuthorizationEpoch(result, authorizationEpoch);
    channelRevisions.set(
      channelId,
      numeric(object(result.channel).channel_revision),
    );
  }
}

function validateRoomStorageAttachment(
  snapshot: JsonObject,
  input: Pick<
    RoomStorageBindingInput,
    | "objectChannelIds"
    | "roleIds"
    | "sourceDelegateMemberIds"
    | "sourceDelegateRoleIds"
  >,
) {
  const channels = new Map(
    array(snapshot.channels).map((channel) => [
      optionalText(channel.channel_id),
      channel,
    ]),
  );
  for (const channelId of input.objectChannelIds) {
    const channel = channels.get(channelId);
    if (
      !channel ||
      optionalText(channel.kind) !== "object" ||
      optionalText(channel.state) !== "active"
    ) {
      throw serviceError(
        "invalid_storage_channel",
        "Storage members can bind only to active object channels.",
      );
    }
  }
  validateDelegates(
    snapshot,
    input.sourceDelegateMemberIds,
    input.sourceDelegateRoleIds,
    input.roleIds,
  );
}

function validateDelegates(
  snapshot: JsonObject,
  memberIds: string[],
  delegateRoleIds: string[],
  bindingRoleIds: string[] = [],
) {
  const roles = new Set(
    array(snapshot.roles)
      .filter((role) => optionalText(role.state) !== "revoked")
      .map((role) => optionalText(role.role_id)),
  );
  for (const roleId of [...bindingRoleIds, ...delegateRoleIds]) {
    if (!roles.has(roleId)) {
      throw serviceError(
        "invalid_storage_role",
        "A selected room role no longer exists.",
      );
    }
  }
  const members = new Map(
    array(snapshot.memberships)
      .filter((member) => optionalText(member.state) === "active")
      .map((member) => [optionalText(member.member_id), member]),
  );
  for (const memberId of memberIds) {
    const member = members.get(memberId);
    if (!member || optionalText(member.kind) === "object_storage") {
      throw serviceError(
        "invalid_storage_delegate",
        "Bucket-source delegates must be active agent members.",
      );
    }
  }
}

function bindingNotFound() {
  return serviceError(
    "room_storage_binding_not_found",
    "Storage member binding not found.",
    404,
  );
}

function serviceError(code: string, message: string, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredText(value: unknown) {
  const result = optionalText(value);
  if (!result)
    throw serviceError(
      "invalid_coordinator_snapshot",
      "Coordinator returned an invalid room snapshot.",
      502,
    );
  return result;
}

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mutationAuthorizationEpoch(result: JsonObject, fallback: number) {
  return (
    numeric(result.authorization_epoch) ||
    numeric(object(result.room).authorization_epoch) ||
    fallback
  );
}
