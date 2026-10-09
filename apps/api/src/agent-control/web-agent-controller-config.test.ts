import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseWebAgentControllerBindings,
  requireWebAgentControllerBinding,
} from "./web-agent-controller-config.js";

const binding = {
  organizationId: "org",
  roomId: "room",
  agentId: "agent",
  memberId: "controller",
  url: "wss://agent.example/v1/connect",
  origin: "https://studio.example",
  credential: "a".repeat(32),
  channels: { executor: "pairwise" },
};

test("controller binding selects one configured room and recipient", () => {
  const bindings = parseWebAgentControllerBindings(JSON.stringify([binding]));
  const selected = requireWebAgentControllerBinding(bindings, "org", "room", "executor");
  assert.equal(selected.binding.agentId, "agent");
  assert.equal(selected.controlChannelId, "pairwise");
  assert.throws(
    () => requireWebAgentControllerBinding(bindings, "org", "room", "other"),
    { code: "room_action_controller_unavailable" },
  );
});

test("controller configuration rejects insecure and ambiguous bindings", () => {
  const parse = (value: unknown) =>
    parseWebAgentControllerBindings(JSON.stringify([value]));
  assert.throws(() => parse({ ...binding, url: "ws://agent.example/v1/connect" }));
  assert.throws(() => parse({ ...binding, url: "wss://secret@agent.example/v1/connect" }));
  assert.throws(() => parse({ ...binding, channels: { controller: "pairwise" } }));
  assert.throws(() =>
    parseWebAgentControllerBindings(JSON.stringify([binding, binding])),
  );
});
