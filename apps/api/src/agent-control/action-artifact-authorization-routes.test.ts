import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  WorkflowAuthorizationError,
  WorkflowAuthorityUnavailableError,
  type PgPool,
} from "@beam-studio/db";
import { registerRoomMemberActionHost } from "./action-host.js";
import type { RoomMemberActionAssignments } from "./action-assignments.js";
import type { RoomStorageTransferManager } from "./room-storage-transfer-manager.js";
import { expectedActionArtifactId } from "./room-artifact-copy-source.js";

const hash = `sha256:${"a".repeat(64)}`;
const roomId = "room";
const publication = {
  roomId,
  channelId: "objects",
  sourceMemberId: "executor",
  targetMemberIds: ["reader"],
  retentionObligationId: "obligation",
  requiredUntil: "2099-01-01T00:00:00Z",
  availability: "durable",
};
const input = {
  manifestId: "manifest",
  artifactId: "artifact",
  sha256: hash,
  sizeBytes: 3,
  mediaType: "application/octet-stream",
  location: {
    kind: "member",
    roomId,
    channelId: "objects",
    sourceMemberId: "reader",
    memberId: "executor",
    transferId: "transfer",
  },
};
function snapshot() {
  return {
    room: { room_id: roomId, api_key_id: "room-key", state: "active" },
    memberships: ["executor", "reader"].map((member_id) => ({
      member_id,
      room_id: roomId,
      state: "active",
    })),
    channels: [{ room_id: roomId, channel_id: "objects", kind: "object",
      state: "active" }],
    grants: [
      {
        room_id: roomId,
        channel_id: "objects",
        subject_type: "member",
        subject_id: "executor",
        actions: ["publish", "subscribe"],
        state: "active",
      },
      {
        room_id: roomId,
        channel_id: "objects",
        subject_type: "member",
        subject_id: "reader",
        actions: ["publish", "subscribe"],
        state: "active",
      },
    ],
  };
}

test("scoped artifact endpoints distinguish access denial, authority outage and lease expiry", async () => {
  const live = snapshot();
  let failure: Error | null = null;
  let localSource = false;
  const storageRequests: Record<string, unknown>[] = [];
  let cleanup = false;
  const assignments = {
    async authorizeAssignment(
      _assignmentId: string,
      _bearer: string,
      allowCleanup = false,
    ) {
      cleanup = allowCleanup;
      if (failure) throw failure;
      return {
        assignment: {
          id: "assignment",
          attempt: 2,
          executor_id: "agent",
          member_id: "executor",
        },
        run: { id: "run", organization_id: "org" },
        stepRun: { id: "step-run" },
        step: {
          manifestSnapshot: { outputs: { result: { type: "artifact" } } },
          executionRoom: { environmentTemplateKey: "dev", roomId },
        },
        task: {
          metadata_json: {
            artifactPublications: { result: publication },
            artifactInputs: { image: [input] },
          },
        },
        room: { roomId },
        roomSnapshot: live,
      };
    },
  } as unknown as RoomMemberActionAssignments;
  const pool = {
    async query() {
      return {
        rows: [
          {
            status: "accepted",
            sha256: hash,
            size_bytes: 3,
            media_type: "application/octet-stream",
            location_state: "available",
            kind: "member",
            room_id: roomId,
            verified_at: new Date(),
            channel_id: "objects",
            source_member_id: localSource ? "executor" : "reader",
            member_id: "executor",
            transfer_status: localSource ? null : "completed",
            full_delivery_verified: !localSource,
            transfer_room_id: localSource ? null : roomId,
            transfer_channel_id: localSource ? null : "objects",
            transfer_source_member_id: localSource ? null : "reader",
          },
        ],
      };
    },
  } as unknown as PgPool;
  const transfers = {
    async enqueueArtifactCopy(value: Record<string, unknown>) {
      storageRequests.push(value);
      return { publicationId: "publication", status: "queued" };
    },
    async cancelArtifactCopies() {
      return { publicationCancellationConfirmed: true };
    },
  } as unknown as RoomStorageTransferManager;
  const server = Fastify();
  registerRoomMemberActionHost(server, pool, assignments, transfers);
  const output = () =>
    server.inject({
      method: "POST",
      url: "/api/internal/executor-assignments/assignment/artifacts/authorize",
      payload: {
        operation: "output.publish",
        port: "result",
        artifactId: "artifact",
        sha256: hash,
        sizeBytes: 3,
      },
    });
  const read = () =>
    server.inject({
      method: "POST",
      url: "/api/internal/executor-assignments/assignment/inputs/image/0/authorize",
      payload: { operation: "input.copy" },
    });
  const artifactId = expectedActionArtifactId({
    assignmentId: "assignment",
    attempt: 2,
    port: "result",
    index: 0,
    sha256: hash,
  });
  const storage = (id = artifactId) =>
    server.inject({
      method: "POST",
      url: "/api/internal/executor-assignments/assignment/artifacts/storage-publish",
      payload: {
        port: "result",
        index: 0,
        artifactId: id,
        copyId: id,
        sha256: hash,
        sizeBytes: 3,
      },
    });
  try {
    assert.equal((await output()).statusCode, 200);
    assert.equal((await read()).json().artifactId, "artifact");
    assert.equal((await storage("other")).statusCode, 403);
    assert.equal((await storage()).json().publicationId, "publication");
    assert.equal(storageRequests[0]?.roomId, roomId);
    assert.deepEqual(storageRequests[0]?.targetMemberIds, ["reader"]);
    assert.equal(storageRequests[0]?.requiredUntil, publication.requiredUntil);
    assert.equal(storageRequests[0]?.roomApiKeyId, "room-key");
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/api/internal/executor-assignments/assignment/artifacts/storage-cancel",
          payload: { port: "result", index: 0, artifactId },
        })
      ).json().publicationCancellationConfirmed,
      true,
    );
    assert.equal(cleanup, true);
    localSource = true;
    input.location.sourceMemberId = "executor";
    assert.equal(
      (await read()).json().location.verificationBasis,
      "local_hash",
    );
    localSource = false;
    input.location.sourceMemberId = "reader";
    live.grants[1]!.state = "revoked";
    assert.equal((await output()).statusCode, 403);
    assert.equal((await read()).statusCode, 403);
    assert.equal((await storage()).statusCode, 403);
    live.grants[1]!.state = "active";
    failure = new WorkflowAuthorityUnavailableError();
    assert.equal((await output()).statusCode, 503);
    assert.equal((await storage()).statusCode, 503);
    failure = new WorkflowAuthorizationError(
      "executor_lease_expired_or_cancelled",
    );
    assert.equal((await read()).statusCode, 403);
    assert.equal((await storage()).statusCode, 403);
  } finally {
    await server.close();
  }
});
