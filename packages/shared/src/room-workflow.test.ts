import assert from "node:assert/strict";
import test from "node:test";
import {
  roomCoordinatorUrl,
  roomTransferActionVersion,
  roomWorkflowConfigSchema,
} from "./room-workflow.js";
import { builtinBeamEnvironmentTemplates } from "./beam-environment-templates.js";

test("room workflows require an explicit environment template and safe immutable configuration", () => {
  assert.equal(roomTransferActionVersion, "2.1.2");
  const config = {
    environmentTemplateKey: "dev",
    source: {
      memberId: "btr_member_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      locator: { type: "agent_path", path: "/data/source" },
    },
    roomId: `btr_room_${"a".repeat(26)}`,
    channelId: "btr_channel_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  assert.equal(roomWorkflowConfigSchema.parse(config).allowPartial, false);
  for (const override of [
    { environment: "dev" },
    { environmentTemplateKey: undefined },
    { environmentTemplateKey: "DEV" },
    { coordinatorUrl: "https://coordinator.example.test" },
    { ttlSeconds: 0 },
    { ttlSeconds: 86401 },
    { targetMemberIds: ["member", "member"] },
    { apiKey: "secret" },
    { source: { ...config.source, locator: { type: "agent_path", path: "" } } },
  ]) {
    assert.equal(
      roomWorkflowConfigSchema.safeParse({ ...config, ...override }).success,
      false,
    );
  }
});

test("room workflow config has no Studio recipient count ceiling", () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const memberId = (index: number) => {
    let value = index;
    let suffix = "";
    do {
      suffix = alphabet[value % alphabet.length] + suffix;
      value = Math.floor(value / alphabet.length);
    } while (value > 0);
    return `btr_member_${suffix.padStart(26, "a")}`;
  };
  const parsed = roomWorkflowConfigSchema.parse({
    environmentTemplateKey: "prod",
    source: {
      memberId: "btr_member_zzzzzzzzzzzzzzzzzzzzzzzzzz",
      locator: { type: "agent_path", path: "/data/source" },
    },
    roomId: `btr_room_${"a".repeat(26)}`,
    channelId: "btr_channel_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    targetMemberIds: Array.from({ length: 1_001 }, (_, index) =>
      memberId(index),
    ),
  });
  assert.equal(parsed.targetMemberIds.length, 1_001);
});

test("room coordinator URLs come from Beam environment templates", () => {
  assert.equal(
    roomCoordinatorUrl("dev"),
    builtinBeamEnvironmentTemplates.dev.coordinatorUrl,
  );
  assert.equal(roomCoordinatorUrl("prod"), "https://coordinator.b1m.ai");
});
