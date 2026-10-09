import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertFrozenRoomArtifactPlansAuthorized,
  assertRoomArtifactOperationAuthorized,
  frozenArtifactInput,
} from "./room-artifact-authorization.js";

const roomId = "room";
const location = {
  roomId,
  channelId: "objects",
  sourceMemberId: "source",
  recipientMemberIds: ["executor"],
};
function snapshot() {
  return {
    memberships: ["source", "executor"].map((member_id) => ({
      room_id: roomId,
      member_id,
      state: "active",
    })),
    channels: [{ room_id: roomId, channel_id: "objects", kind: "object", state: "active" }],
    grants: [
      {
        room_id: roomId,
        channel_id: "objects",
        subject_type: "member",
        subject_id: "source",
        actions: ["publish"],
        state: "active",
      },
      {
        room_id: roomId,
        channel_id: "objects",
        subject_type: "member",
        subject_id: "executor",
        actions: ["subscribe"],
        state: "active",
      },
    ],
  };
}

test("each protected read, cached copy and recovery rechecks current grants", () => {
  const live = snapshot();
  for (const kind of ["input.read", "input.copy", "input.recover"] as const)
    assert.doesNotThrow(() =>
      assertRoomArtifactOperationAuthorized(live, roomId, {
        kind,
        readerMemberId: "executor",
        location,
      }),
    );
  live.grants[1]!.state = "revoked";
  for (const kind of ["input.read", "input.copy", "input.recover"] as const)
    assert.throws(
      () =>
        assertRoomArtifactOperationAuthorized(live, roomId, {
          kind,
          readerMemberId: "executor",
          location,
        }),
      /executor_artifact_destination_denied/,
    );
});

test("publication checks the source, every destination and room scope", () => {
  const live = snapshot();
  assert.doesNotThrow(() =>
    assertRoomArtifactOperationAuthorized(live, roomId, {
      kind: "output.publish",
      location,
    }),
  );
  live.grants[0]!.state = "revoked";
  assert.throws(
    () =>
      assertRoomArtifactOperationAuthorized(live, roomId, {
        kind: "output.copy",
        location,
      }),
    /executor_artifact_publish_denied/,
  );
  assert.throws(
    () =>
      assertRoomArtifactOperationAuthorized(snapshot(), "another-room", {
        kind: "output.recover",
        location,
      }),
    /executor_artifact_location_invalid/,
  );
});

test("artifact operations refuse request/reply channels even with publish grants", () => {
  const live = snapshot();
  live.channels[0]!.kind = "request-reply";
  assert.throws(() => assertRoomArtifactOperationAuthorized(live, roomId, {
    kind: "output.publish", location,
  }), /executor_artifact_channel_unavailable/);
});

test("frozen plans bind input identity and placement to a selected member", () => {
  const metadata = {
    artifactInputs: {
      image: [
        {
          manifestId: "manifest",
          artifactId: "artifact",
          sha256: `sha256:${"a".repeat(64)}`,
          sizeBytes: 12,
          mediaType: "image/png",
          location: {
            kind: "member",
            roomId,
            channelId: "objects",
            sourceMemberId: "source",
            memberId: "executor",
            transferId: "transfer",
          },
        },
      ],
    },
    artifactPublications: {
      result: {
        roomId,
        channelId: "objects",
        sourceMemberId: "executor",
        targetMemberIds: ["source"],
        retentionObligationId: "retention",
        requiredUntil: "2099-01-01T00:00:00Z",
        availability: "durable",
      },
    },
  };
  assert.equal(
    frozenArtifactInput(metadata, "image", 0).artifactId,
    "artifact",
  );
  const live = snapshot();
  live.grants.push({
    room_id: roomId,
    channel_id: "objects",
    subject_type: "member",
    subject_id: "executor",
    actions: ["publish"],
    state: "active",
  });
  live.grants.push({
    room_id: roomId,
    channel_id: "objects",
    subject_type: "member",
    subject_id: "source",
    actions: ["subscribe"],
    state: "active",
  });
  assert.doesNotThrow(() =>
    assertFrozenRoomArtifactPlansAuthorized(live, roomId, "executor", metadata),
  );
  assert.throws(
    () =>
      assertFrozenRoomArtifactPlansAuthorized(live, roomId, "source", metadata),
    /executor_artifact_reader_denied/,
  );
  live.grants[3]!.state = "revoked";
  assert.throws(
    () =>
      assertFrozenRoomArtifactPlansAuthorized(
        live,
        roomId,
        "executor",
        metadata,
      ),
    /executor_artifact_destination_denied/,
  );
});
