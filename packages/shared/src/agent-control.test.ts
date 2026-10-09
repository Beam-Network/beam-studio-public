import assert from "node:assert/strict";
import test from "node:test";
import {
  agentControlMaxMessageBytes,
  agentHelloEnvelopeSchema,
  parseAgentControlMessage,
  serverChannelPublishEnvelopeSchema,
  serverCommandEnvelopeSchema,
} from "./agent-control.js";

test("agent hello validates protocol ranges", () => {
  const base = {
    protocolVersion: 1 as const,
    type: "agent.hello" as const,
    messageId: "msg_hello",
    sentAt: "2026-08-08T20:00:00.000Z",
    payload: {
      agentId: "agt_1",
      bootId: "boot_1",
      daemonVersion: "dev",
      protocolMin: 1,
      protocolMax: 1,
      capabilities: ["endpoints"],
      platform: "darwin",
      architecture: "arm64",
      lastCommandSequence: 0,
      lastEventSequence: 0,
    },
  };
  assert.equal(agentHelloEnvelopeSchema.parse(base).payload.agentId, "agt_1");
  assert.throws(() =>
    agentHelloEnvelopeSchema.parse({
      ...base,
      payload: { ...base.payload, protocolMin: 2 },
    }),
  );
});

test("ephemeral channel publications stay outside command envelopes", () => {
  const publication = serverChannelPublishEnvelopeSchema.parse({
    protocolVersion: 1,
    type: "channel.publish",
    messageId: "msg_publish",
    sentAt: "2026-08-12T20:00:00.000Z",
    payload: {
      subscriptionId: "sub_1",
      clientMessageId: "client_1",
      roomId: "room_1",
      channelId: "channel_1",
      contentType: "application/vnd.beam.channel-message+json; version=1",
      payloadBase64: "eyJ0ZXh0IjoiaGVsbG8ifQ==",
    },
  });
  assert.equal(publication.type, "channel.publish");
  assert.equal("commandId" in publication.payload, false);
});

test("server commands reject unsupported operations", () => {
  const command = {
    protocolVersion: 1 as const,
    type: "command" as const,
    messageId: "msg_command",
    sentAt: "2026-08-08T20:00:00.000Z",
    payload: {
      commandId: "cmd_1",
      sequence: 1,
      idempotencyKey: "cmd_1",
      sessionGeneration: 1,
      operation: "tunnel.create",
      expiresAt: "2026-08-08T20:05:00.000Z",
      payload: { kind: "http", target: "127.0.0.1:3000" },
    },
  };
  assert.equal(
    serverCommandEnvelopeSchema.parse(command).payload.operation,
    "tunnel.create",
  );
  assert.throws(() =>
    serverCommandEnvelopeSchema.parse({
      ...command,
      payload: { ...command.payload, operation: "daemon.shutdown" },
    }),
  );
});

test("parser rejects oversized messages before JSON decoding", () => {
  assert.throws(
    () =>
      parseAgentControlMessage(
        "x".repeat(agentControlMaxMessageBytes + 1),
        "agent-to-studio",
      ),
    /exceeds/,
  );
});
