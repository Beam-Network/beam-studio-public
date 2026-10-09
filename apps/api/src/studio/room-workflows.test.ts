import assert from "node:assert/strict";
import test from "node:test";
import { assertRoomWorkflowServicesAvailable } from "./room-workflows.js";

const roomStep = {
  actionPackageName: "@beam/room-transfer",
  config: {
    environmentTemplateKey: "prod",
    source: {
      memberId: "btr_member_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      locator: { type: "agent_path", path: "/data/source" },
    },
    roomId: `btr_room_${"a".repeat(26)}`,
    channelId: "btr_channel_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
};

test("room workflow preflight validates the room binding without a service credential", () => {
  // Coordinator access is authorized per request with the user's session, so
  // no organization/template credential binding is required to start a run.
  assert.doesNotThrow(() =>
    assertRoomWorkflowServicesAvailable({ steps: [roomStep] }),
  );
  assert.throws(() =>
    assertRoomWorkflowServicesAvailable({
      steps: [{ ...roomStep, config: { ...roomStep.config, roomId: "" } }],
    }),
  );
});

test("non-room workflows do not require room bindings", () => {
  assert.doesNotThrow(() =>
    assertRoomWorkflowServicesAvailable({
      steps: [{ actionPackageName: "@beam/transfer", config: {} }],
    }),
  );
});

test("workflow room supplies omitted action fields while explicit conflicts fail", () => {
  const { roomId, environmentTemplateKey, ...config } = roomStep.config;
  assert.doesNotThrow(() =>
    assertRoomWorkflowServicesAvailable({
      template: { room: { roomId, environmentTemplateKey } },
      steps: [{ ...roomStep, config }],
    }),
  );
  assert.throws(() =>
    assertRoomWorkflowServicesAvailable({
      template: { room: { roomId, environmentTemplateKey: "dev" } },
      steps: [roomStep],
    }),
  );
});
