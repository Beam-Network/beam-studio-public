import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionExecutionTargetSchema,
  actionTargetPlacement,
} from "./action-execution.js";
import { resolveActionRoomContext } from "./workflow-room-context.js";

const room = {
  environmentTemplateKey: "dev",
  roomId: "btr_room_" + "a".repeat(26),
};
test("room-member targets require explicit members, request channel and requester", () => {
  assert.equal(
    actionExecutionTargetSchema.safeParse({
      kind: "room-member",
      memberIds: ["m"],
    }).success,
    false,
  );
  const target = actionExecutionTargetSchema.parse({
    kind: "room-member",
    memberIds: ["m"],
    channelId: "c",
    artifactChannelId: "object",
    requesterMemberId: "r",
    room,
  });
  assert.equal(actionTargetPlacement(target), "room-members");
  assert.equal(target.kind === "room-member" && target.artifactChannelId, "object");
  assert.equal(
    actionTargetPlacement({ kind: "external-worker" }),
    "external-workers",
  );
});
test("action target room remains local and cannot conflict with a shared workflow room", () => {
  const config = { value: 1 };
  assert.deepEqual(
    resolveActionRoomContext({
      workflowRoom: null,
      actionRoom: room,
      actionPackage: "@test/action",
      config,
    }),
    { room, config },
  );
  assert.deepEqual(
    resolveActionRoomContext({
      workflowRoom: null,
      actionPackage: "@test/sibling",
      config,
    }),
    { room: null, config },
  );
  assert.throws(
    () =>
      resolveActionRoomContext({
        workflowRoom: room,
        actionRoom: { ...room, environmentTemplateKey: "prod" },
        actionPackage: "@test/action",
        config,
      }),
    /conflicts/,
  );
});
