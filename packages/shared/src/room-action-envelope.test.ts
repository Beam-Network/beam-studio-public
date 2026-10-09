import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRoomActionReply,
  roomActionCommandSchema,
  roomActionReplySchema,
} from "./room-action-envelope.js";

const command = roomActionCommandSchema.parse({
  version: "room-action/v1",
  kind: "command",
  commandId: "command_1",
  operation: "action.invoke",
  controllerMemberId: "controller",
  recipientMemberId: "executor",
  roomId: "room",
  controlChannelId: "pairwise",
  requestReplyChannelId: "requests",
  workflowRunId: "run",
  stepRunId: "step_run",
  taskId: "task",
  assignmentId: "assignment",
  attempt: 2,
  authorityGeneration: 4,
  deadline: "2026-09-20T02:00:00.000Z",
  payload: { invocation: { inputs: { text: "secret" } } },
});
const { payload: _payload, ...replyIdentity } = command;
const reply = roomActionReplySchema.parse({
  ...replyIdentity,
  kind: "reply",
  replyId: "reply_1",
  replyDeadline: "2026-09-20T01:01:00.000Z",
  state: "completed",
  result: { assignmentId: "assignment", attempt: 2, cleanupConfirmed: true },
});
const delivery = {
  publisherMemberId: "executor",
  roomId: "room",
  channelId: "pairwise",
  currentAuthorityGeneration: 4,
  now: Date.parse("2026-09-20T01:00:00.000Z"),
};

test("a reply is bound to the delivered member and frozen attempt", () => {
  assert.doesNotThrow(() => assertRoomActionReply(reply, command, delivery));
  assert.throws(
    () => assertRoomActionReply({ ...reply, attempt: 3 }, command, delivery),
    { code: "room_action_identity_mismatch" },
  );
  assert.throws(
    () =>
      assertRoomActionReply(reply, command, {
        ...delivery,
        publisherMemberId: "another_member",
      }),
    { code: "room_action_sender_mismatch" },
  );
  assert.throws(
    () =>
      assertRoomActionReply(reply, command, {
        ...delivery,
        currentAuthorityGeneration: 5,
      }),
    { code: "room_action_authority_fenced" },
  );
  assert.throws(
    () =>
      assertRoomActionReply(reply, command, {
        ...delivery,
        now: Date.parse(reply.replyDeadline),
      }),
    { code: "room_action_reply_deadline_invalid" },
  );
});

test("room action envelopes reject unbound fields", () => {
  assert.equal(
    roomActionCommandSchema.safeParse({ ...command, extra: "ignored" }).success,
    false,
  );
  assert.equal(
    roomActionReplySchema.safeParse({ ...reply, authorityGeneration: 0 }).success,
    false,
  );
});
