import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveActionRoomContext,
  resolveWorkflowRoomContext,
} from "./workflow-room-context.js";
const a = {
  environmentTemplateKey: "dev",
  roomId: `btr_room_${"a".repeat(26)}`,
};
const b = { ...a, roomId: `btr_room_${"b".repeat(26)}` };
test("optional rooms resolve through subtrees without promoting action selections", () => {
  assert.equal(resolveWorkflowRoomContext(null, null), null);
  assert.deepEqual(resolveWorkflowRoomContext(null, a), a);
  const child = resolveWorkflowRoomContext(a, null);
  assert.deepEqual(resolveWorkflowRoomContext(child, null), a);
  assert.deepEqual(resolveWorkflowRoomContext(a, a), a);
  assert.throws(() => resolveWorkflowRoomContext(a, b), /conflicts/);
  assert.throws(
    () =>
      resolveWorkflowRoomContext(a, { ...a, environmentTemplateKey: "prod" }),
    /conflicts/,
  );
  assert.deepEqual(
    resolveActionRoomContext({
      workflowRoom: null,
      actionPackage: "@beam/room-transfer",
      config: a,
    }).room,
    a,
  );
  assert.equal(
    resolveActionRoomContext({
      workflowRoom: null,
      actionPackage: "@beam/wait",
      config: {},
    }).room,
    null,
  );
});
test("inherited fields resolve before validation and incompatible explicit fields fail", () => {
  const config = { channelId: "channel", source: { memberId: "member" } };
  const resolved = resolveActionRoomContext({
    workflowRoom: a,
    actionPackage: "@beam/room-transfer",
    config,
  });
  assert.deepEqual(resolved.config, { ...config, ...a });
  assert.deepEqual(config, {
    channelId: "channel",
    source: { memberId: "member" },
  });
  assert.throws(
    () =>
      resolveActionRoomContext({
        workflowRoom: a,
        actionPackage: "@beam/room-transfer",
        config: b,
      }),
    /conflicts/,
  );
  assert.deepEqual(
    resolveActionRoomContext({
      workflowRoom: a,
      actionPackage: "@beam/wait",
      config: {},
    }),
    { room: a, config: {} },
  );
});
