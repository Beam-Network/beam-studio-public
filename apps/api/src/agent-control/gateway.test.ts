import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { WebSocket } from "ws";
import {
  InMemoryAgentConnectionRegistry,
  type AgentConnection,
} from "./connection-registry.js";
import { AgentGateway } from "./gateway.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];

  send(value: string) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit("close");
  }
}

test("channel clients use ephemeral envelopes without a repository write", () => {
  const registry = new InMemoryAgentConnectionRegistry();
  const agentSocket = new FakeSocket();
  registry.set("agt_1", {
    agentId: "agt_1",
    sessionId: "session_1",
    generation: 1,
    capabilities: ["rooms", "room-messages"],
    socket: agentSocket as unknown as WebSocket,
    messageCount: 0,
    channelMessageCount: 0,
    rateWindowStartedAt: Date.now(),
    processing: Promise.resolve(),
  });
  const gateway = new AgentGateway(
    {} as never,
    { info() {}, warn() {}, error() {} },
    registry,
  );
  const browserSocket = new FakeSocket();

  gateway.acceptChannelClient(browserSocket as unknown as WebSocket, {
    agentId: "agt_1",
    roomId: "room_1",
    channelId: "channel_1",
  });
  const subscribe = agentSocket.sent.find(
    (message) => message.type === "channel.subscribe",
  );
  assert.ok(subscribe);
  const subscriptionId = String(
    (subscribe.payload as Record<string, unknown>).subscriptionId,
  );

  (
    gateway as unknown as {
      forwardChannelEnvelope(envelope: Record<string, unknown>): void;
    }
  ).forwardChannelEnvelope({
    type: "channel.subscribed",
    payload: {
      agentId: "agt_1",
      subscriptionId,
      roomId: "room_1",
      channelId: "channel_1",
    },
  });
  browserSocket.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "channel.publish",
        clientMessageId: "client_1",
        text: "hello",
      }),
    ),
    false,
  );

  const publication = agentSocket.sent.find(
    (message) => message.type === "channel.publish",
  );
  assert.ok(publication);
  assert.equal(
    (publication.payload as Record<string, unknown>).clientMessageId,
    "client_1",
  );
  assert.ok(
    browserSocket.sent.some(
      (message) => message.type === "channel.local_message",
    ),
  );

  browserSocket.close();
  assert.ok(
    agentSocket.sent.some((message) => message.type === "channel.unsubscribe"),
  );
});

test("a new channel client retries a failed managed-agent subscription", () => {
  const registry = new InMemoryAgentConnectionRegistry();
  const agentSocket = new FakeSocket();
  registry.set("agt_1", {
    agentId: "agt_1",
    sessionId: "session_1",
    generation: 1,
    capabilities: ["rooms", "room-messages"],
    socket: agentSocket as unknown as WebSocket,
    messageCount: 0,
    channelMessageCount: 0,
    rateWindowStartedAt: Date.now(),
    processing: Promise.resolve(),
  });
  const gateway = new AgentGateway(
    {} as never,
    { info() {}, warn() {}, error() {} },
    registry,
  );
  const firstBrowserSocket = new FakeSocket();

  gateway.acceptChannelClient(firstBrowserSocket as unknown as WebSocket, {
    agentId: "agt_1",
    roomId: "room_1",
    channelId: "channel_1",
  });
  const firstSubscribe = agentSocket.sent.find(
    (message) => message.type === "channel.subscribe",
  );
  assert.ok(firstSubscribe);
  const subscriptionId = String(
    (firstSubscribe.payload as Record<string, unknown>).subscriptionId,
  );
  (
    gateway as unknown as {
      forwardChannelEnvelope(envelope: Record<string, unknown>): void;
    }
  ).forwardChannelEnvelope({
    type: "channel.error",
    payload: {
      agentId: "agt_1",
      subscriptionId,
      code: "listen_failed",
      message: "worker unavailable",
      retryable: true,
    },
  });

  const secondBrowserSocket = new FakeSocket();
  gateway.acceptChannelClient(secondBrowserSocket as unknown as WebSocket, {
    agentId: "agt_1",
    roomId: "room_1",
    channelId: "channel_1",
  });

  assert.equal(
    agentSocket.sent.filter((message) => message.type === "channel.subscribe")
      .length,
    2,
  );
  assert.deepEqual(secondBrowserSocket.sent.at(-1), {
    type: "channel.status",
    payload: { state: "connecting" },
  });
  assert.equal(
    secondBrowserSocket.sent.some(
      (message) => message.type === "channel.error",
    ),
    false,
  );
});

test("closing a replaced agent session keeps channel clients online", async () => {
  const registry = new InMemoryAgentConnectionRegistry();
  const oldAgentSocket = new FakeSocket();
  const oldConnection = {
    agentId: "agt_1",
    sessionId: "session_old",
    generation: 1,
    capabilities: ["rooms", "room-messages"],
    socket: oldAgentSocket as unknown as WebSocket,
    messageCount: 0,
    channelMessageCount: 0,
    rateWindowStartedAt: Date.now(),
    processing: Promise.resolve(),
  };
  registry.set("agt_1", oldConnection);
  const gateway = new AgentGateway(
    { closeSession: async () => {} } as never,
    { info() {}, warn() {}, error() {} },
    registry,
  );
  const browserSocket = new FakeSocket();
  gateway.acceptChannelClient(browserSocket as unknown as WebSocket, {
    agentId: "agt_1",
    roomId: "room_1",
    channelId: "channel_1",
  });
  const replacementSocket = new FakeSocket();
  registry.set("agt_1", {
    ...oldConnection,
    sessionId: "session_new",
    generation: 2,
    socket: replacementSocket as unknown as WebSocket,
  });

  await (
    gateway as unknown as {
      closed(connection: typeof oldConnection): Promise<void>;
    }
  ).closed(oldConnection);

  assert.equal(
    browserSocket.sent.some(
      (message) =>
        message.type === "channel.status" &&
        (message.payload as Record<string, unknown>).state === "offline",
    ),
    false,
  );
  assert.equal(registry.get("agt_1")?.generation, 2);
});

test("room storage requests do not block the agent message queue", async () => {
  let resolveHandler: (
    value: { publicationId?: string; status?: Record<string, unknown> },
  ) => void = () => {};
  let markHandlerStarted: () => void = () => {};
  const handlerStarted = new Promise<void>((resolve) => {
    markHandlerStarted = resolve;
  });
  const gateway = new AgentGateway(
    {} as never,
    { info() {}, warn() {}, error() {} },
  );
  gateway.setRoomStorageRequestHandler(async () => {
    markHandlerStarted();
    return await new Promise((handlerResolve) => {
      resolveHandler = handlerResolve;
    });
  });
  const socket = new FakeSocket();
  const connection: AgentConnection = {
    agentId: "agt_1",
    sessionId: "session_1",
    generation: 1,
    capabilities: ["room-storage-publish"],
    socket: socket as unknown as WebSocket,
    messageCount: 0,
    channelMessageCount: 0,
    rateWindowStartedAt: Date.now(),
    processing: Promise.resolve(),
  };
  const storageMessage = Buffer.from(
    JSON.stringify({
      protocolVersion: 1,
      type: "room.storage.request",
      messageId: "msg_storage",
      sentAt: new Date().toISOString(),
      payload: {
        agentId: "agt_1",
        requestId: "storage_1",
        operation: "publish",
        roomId: "room_1",
        channelId: "channel_1",
        sourceMemberId: "member_source",
        sourceLocator: { type: "agent_path", path: "/data/file.bin" },
        targetMemberIds: ["member_bucket"],
        ttlSeconds: 300,
        idempotencyKey: "idem_storage",
      },
    }),
  );
  const messageReturned = (
    gateway as unknown as {
      onMessage(
        connection: AgentConnection,
        data: Buffer,
        isBinary: boolean,
      ): Promise<void>;
    }
  )
    .onMessage(connection, storageMessage, false)
    .then(() => "returned");

  await handlerStarted;
  assert.equal(socket.sent.length, 0);
  assert.equal(
    await Promise.race([
      messageReturned,
      new Promise((resolve) => setImmediate(() => resolve("blocked"))),
    ]),
    "returned",
  );
  resolveHandler({
    publicationId: "btr_pub_storage",
    status: { state: "active" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const response = socket.sent.find(
    (message) => message.type === "room.storage.response",
  );
  assert.ok(response);
  assert.equal(
    (response.payload as Record<string, unknown>).publicationId,
    "btr_pub_storage",
  );
});
