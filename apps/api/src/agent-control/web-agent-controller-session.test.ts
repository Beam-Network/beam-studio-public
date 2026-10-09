import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { roomActionContentType } from "@beam-studio/shared";
import { WebAgentControllerSession } from "./web-agent-controller-session.js";
import type { WebAgentControllerBinding } from "./web-agent-controller-config.js";

async function fixture(agentId = "agent") {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || !address)
    throw new Error("Missing test listener.");
  const binding: WebAgentControllerBinding = {
    organizationId: "org",
    roomId: "room",
    agentId: "agent",
    memberId: "controller",
    url: `ws://127.0.0.1:${address.port}/v1/connect`,
    origin: "http://127.0.0.1",
    credential: "a".repeat(32),
    channels: new Map([["executor", "pairwise"]]),
  };
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.origin, binding.origin);
    assert.equal(request.headers["sec-websocket-protocol"], "beam.web-agent.v1");
    socket.on("message", (raw) => {
      const command = JSON.parse(raw.toString()) as Record<string, any>;
      if (command.type === "session.authenticate") {
        assert.equal(command.token, binding.credential);
        socket.send(JSON.stringify({
          type: "session.ready", requestId: command.requestId,
          data: {
            protocol: "beam.web-agent.v1",
            status: { agentId, bootId: "boot", connected: true },
          },
        }));
      } else if (command.type === "channel.subscribe.private") {
        assert.equal(command.peerMemberId, "executor");
        // Deliberately deliver readiness before the subscription response.
        socket.send(JSON.stringify({
          type: "subscription.ready", resourceId: "resource_1", data: {},
        }));
        socket.send(JSON.stringify({
          type: "response", requestId: command.requestId,
          data: { resourceId: "resource_1", kind: "message", state: "preparing" },
        }));
      } else if (command.type === "message.publish.private") {
        assert.equal(command.recipientMemberId, "executor");
        assert.equal(command.contentType, roomActionContentType);
        assert.equal(command.idempotencyKey, "command_1");
        assert.equal(Buffer.from(command.payload, "base64").toString(), "protected body");
        socket.send(JSON.stringify({
          type: "response", requestId: command.requestId,
          data: { publicationId: "publication_1" },
        }));
        socket.send(JSON.stringify({
          type: "message.delivery.private", resourceId: "resource_1",
          data: {
            publicationId: "reply_publication", publisherMemberId: "executor",
            contentType: roomActionContentType,
            payload: Buffer.from("reply").toString("base64"),
          },
        }));
      }
    });
  });
  return { server, binding };
}

test("server controller authenticates, handles early readiness, and receives private delivery", async () => {
  const { server, binding } = await fixture();
  let received = "";
  const controller = new WebAgentControllerSession(binding, async (delivery) => {
    assert.equal(delivery.publisherMemberId, "executor");
    received = delivery.payload.toString();
  });
  try {
    await controller.connect();
    await controller.subscribe("pairwise", "executor");
    const result = await controller.publishPrivate({
      channelId: "pairwise",
      recipientMemberId: "executor",
      payload: Buffer.from("protected body"),
      idempotencyKey: "command_1",
      beforeSend: async () => true,
    });
    assert.ok(result);
    assert.equal(result.publicationId, "publication_1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(received, "reply");
    assert.equal(controller.bootId, "boot");
  } finally {
    controller.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("server controller rejects a replaced Web Agent identity", async () => {
  const { server, binding } = await fixture("different_agent");
  const controller = new WebAgentControllerSession(binding, async () => {});
  try {
    await assert.rejects(controller.connect(), /identity or readiness changed/);
    assert.equal(controller.connected, false);
  } finally {
    controller.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
