import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  agentControlMaxMessageBytes,
  agentControlProtocolVersion,
  agentToStudioEnvelopeSchema,
  type AgentHelloPayload,
  type AgentToStudioEnvelope,
  type StudioToAgentEnvelope,
} from "@beam-studio/shared";
import { AgentControlRepository } from "./repository.js";
import {
  InMemoryAgentConnectionRegistry,
  type AgentConnection,
  type AgentConnectionRegistry,
} from "./connection-registry.js";

const heartbeatIntervalSeconds = 15;
/** Control messages (not channel traffic) an agent may send per minute. */
export const maxAgentMessagesPerMinute = 240;
const maxChannelMessagesPerMinute = 2_400;
const maxBrowserMessageBytes = 64 * 1024;
const maxBrowserBufferedBytes = 512 * 1024;
const maxChannelGroupsPerAgent = 16;
const maxBrowserClientsPerChannel = 64;
const channelMessageContentType =
  "application/vnd.beam.channel-message+json; version=1";

type BrowserChannelClient = {
  id: string;
  socket: WebSocket;
  messageCount: number;
  rateWindowStartedAt: number;
};

type BrowserChannelGroup = {
  key: string;
  subscriptionId: string;
  agentId: string;
  roomId: string;
  channelId: string;
  kind: "message" | "datagram" | "command" | "stream" | "media" | "object";
  state: "connecting" | "live" | "offline" | "error";
  lastError?: Record<string, unknown>;
  clients: Map<string, BrowserChannelClient>;
  objectRequests: Map<string, string>;
};

export class AgentGateway {
  private readonly owner = `api_${randomUUID()}`;
  private readonly channelGroups = new Map<string, BrowserChannelGroup>();
  private readonly channelGroupsBySubscription = new Map<
    string,
    BrowserChannelGroup
  >();
  private readonly commandWaiters = new Map<
    string,
    {
      agentId: string;
      resolve(value: {
        state: string;
        result?: Record<string, unknown>;
        error?: Record<string, unknown>;
      }): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private roomStorageRequestHandler:
    | ((
        agentId: string,
        request: Extract<
          AgentToStudioEnvelope,
          { type: "room.storage.request" }
        >["payload"],
      ) => Promise<{
        publicationId?: string;
        status?: Record<string, unknown>;
      }>)
    | null = null;

  constructor(
    private readonly repository: AgentControlRepository,
    private readonly logger: {
      info(payload: unknown, message: string): void;
      warn(payload: unknown, message: string): void;
      error(payload: unknown, message: string): void;
    },
    private readonly connections: AgentConnectionRegistry = new InMemoryAgentConnectionRegistry(),
  ) {}

  setRoomStorageRequestHandler(
    handler: NonNullable<AgentGateway["roomStorageRequestHandler"]>,
  ) {
    this.roomStorageRequestHandler = handler;
  }

  async accept(socket: WebSocket, accessToken: string) {
    let token: ReturnType<AgentControlRepository["verifyAccessToken"]>;
    try {
      token = this.repository.verifyAccessToken(accessToken);
    } catch (error) {
      this.logger.warn({ code: errorCode(error) }, "Rejected agent WebSocket");
      socket.close(1008, "authentication failed");
      return false;
    }

    // Install the hello listener before the asynchronous credential lookup.
    // An outbound agent is allowed to send hello immediately after upgrade.
    const helloPromise = this.awaitHello(socket, token.agentId);
    try {
      await this.repository.assertAgentActive(
        token.agentId,
        token.credentialId,
      );
    } catch (error) {
      this.logger.warn({ code: errorCode(error) }, "Rejected agent WebSocket");
      socket.close(1008, "authentication failed");
      return false;
    }

    const hello = await helloPromise;
    if (!hello) return false;
    if (
      hello.protocolMin > agentControlProtocolVersion ||
      hello.protocolMax < agentControlProtocolVersion
    ) {
      this.logger.warn(
        {
          agentId: token.agentId,
          min: hello.protocolMin,
          max: hello.protocolMax,
        },
        "Rejected incompatible agent protocol",
      );
      socket.close(1002, "protocol incompatible");
      return false;
    }

    let opened: Awaited<ReturnType<AgentControlRepository["openSession"]>>;
    try {
      opened = await this.repository.openSession(
        token.agentId,
        hello,
        this.owner,
      );
    } catch (error) {
      this.logger.warn(
        { code: errorCode(error) },
        "Failed to open agent session",
      );
      socket.close(1008, "session rejected");
      return false;
    }

    const previous = this.connections.get(token.agentId);
    if (previous) {
      send(previous.socket, {
        protocolVersion: agentControlProtocolVersion,
        type: "session.replaced",
        messageId: messageId(),
        sentAt: new Date().toISOString(),
        payload: {
          sessionGeneration: opened.generation,
          reason: "A newer authenticated session connected.",
        },
      });
      previous.socket.close(1008, "session replaced");
    }

    const connection: AgentConnection = {
      agentId: token.agentId,
      sessionId: opened.sessionId,
      generation: opened.generation,
      capabilities: hello.capabilities,
      socket,
      messageCount: 0,
      channelMessageCount: 0,
      rateWindowStartedAt: Date.now(),
      processing: Promise.resolve(),
    };
    this.connections.set(token.agentId, connection);
    send(socket, {
      protocolVersion: agentControlProtocolVersion,
      type: "server.welcome",
      messageId: messageId(),
      sentAt: new Date().toISOString(),
      payload: {
        connectionId: opened.sessionId,
        sessionGeneration: opened.generation,
        heartbeatIntervalSeconds,
        commandSequence: opened.commandSequence,
        policyRevision: opened.policyRevision,
      },
    });
    if (Object.keys(opened.policy).length) {
      send(socket, {
        protocolVersion: agentControlProtocolVersion,
        type: "policy.updated",
        messageId: messageId(),
        sentAt: new Date().toISOString(),
        payload: { revision: opened.policyRevision, policy: opened.policy },
      });
    }
    this.logger.info(
      { agentId: token.agentId, generation: opened.generation },
      "Agent connected",
    );
    socket.on("message", (data, isBinary) => {
      connection.processing = connection.processing
        .then(() => this.onMessage(connection, data, isBinary))
        .catch((error: unknown) => {
          this.logger.warn(
            { agentId: connection.agentId, code: errorCode(error) },
            "Rejected agent message",
          );
          socket.close(1008, "invalid message");
        });
    });
    socket.once("close", () => {
      connection.closing = connection.processing
        .then(() => this.closed(connection))
        .catch((error: unknown) => {
          this.logger.warn(
            { agentId: connection.agentId, code: errorCode(error) },
            "Failed to persist closed agent session",
          );
        });
    });
    socket.once("error", (error) => {
      this.logger.warn(
        { agentId: connection.agentId, error: error.message },
        "Agent WebSocket error",
      );
    });

    this.resubscribeAgentChannels(connection);
    await this.dispatchAgent(token.agentId);
    return true;
  }

  isConnected(agentId: string) {
    const connection = this.connections.get(agentId);
    return Boolean(
      connection && connection.socket.readyState === connection.socket.OPEN,
    );
  }

  async dispatchAgent(agentId: string) {
    const connection = this.connections.get(agentId);
    if (
      !connection ||
      connection.socket.readyState !== connection.socket.OPEN
    ) {
      return false;
    }
    const commands = await this.repository.pendingCommands(
      agentId,
      connection.generation,
    );
    for (const command of commands) {
      if (
        !(await this.repository.markDispatched(
          agentId,
          command.id,
          connection.generation,
        ))
      ) {
        continue;
      }
      send(connection.socket, {
        protocolVersion: agentControlProtocolVersion,
        type: "command",
        messageId: messageId(),
        sentAt: new Date().toISOString(),
        payload: {
          commandId: command.id,
          sequence: command.sequence,
          idempotencyKey: command.idempotencyKey,
          sessionGeneration: connection.generation,
          operation: command.operation,
          expiresAt: command.expiresAt!,
          payload: command.payload,
        },
      });
    }
    return true;
  }

  async dispatchAndWait(agentId: string, commandId: string, timeoutMs: number) {
    if (this.commandWaiters.has(commandId)) {
      throw new Error("Agent command already has an active result waiter.");
    }
    const result = new Promise<{
      state: string;
      result?: Record<string, unknown>;
      error?: Record<string, unknown>;
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commandWaiters.delete(commandId);
        reject(new Error("Timed out waiting for the agent endpoint command."));
      }, timeoutMs);
      this.commandWaiters.set(commandId, { agentId, resolve, reject, timer });
    });
    if (!(await this.dispatchAgent(agentId))) {
      const waiter = this.commandWaiters.get(commandId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.commandWaiters.delete(commandId);
        waiter.reject(new Error("The selected agent is offline."));
      }
    }
    return result;
  }

  acceptChannelClient(
    socket: WebSocket,
    input: {
      agentId: string;
      roomId: string;
      channelId: string;
      kind?: "message" | "datagram" | "command" | "stream" | "media" | "object";
    },
  ) {
    const key = channelGroupKey(input);
    let group = this.channelGroups.get(key);
    if (!group) {
      const groupCount = [...this.channelGroups.values()].filter(
        (candidate) => candidate.agentId === input.agentId,
      ).length;
      if (groupCount >= maxChannelGroupsPerAgent) {
        socket.close(1013, "agent channel subscription limit reached");
        return;
      }
      group = {
        ...input,
        kind: input.kind ?? "message",
        key,
        subscriptionId: `sub_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        state: "connecting",
        clients: new Map(),
        objectRequests: new Map(),
      };
      this.channelGroups.set(key, group);
      this.channelGroupsBySubscription.set(group.subscriptionId, group);
    }
    if (group.clients.size >= maxBrowserClientsPerChannel) {
      socket.close(1013, "channel browser client limit reached");
      return;
    }

    const client: BrowserChannelClient = {
      id: `client_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      socket,
      messageCount: 0,
      rateWindowStartedAt: Date.now(),
    };
    const shouldSubscribe =
      group.clients.size === 0 ||
      group.state === "offline" ||
      group.state === "error";
    group.clients.set(client.id, client);
    sendBrowser(socket, {
      type: "channel.client",
      payload: { clientId: client.id },
    });
    if (shouldSubscribe) {
      this.subscribeChannelGroup(group);
    } else {
      sendBrowser(socket, {
        type: "channel.status",
        payload: { state: group.state },
      });
      if (group.lastError) {
        sendBrowser(socket, {
          type: "channel.error",
          payload: group.lastError,
        });
      }
    }

    socket.on("message", (data, isBinary) => {
      try {
        this.onBrowserChannelMessage(group!, client, data, isBinary);
      } catch (error) {
        sendBrowser(socket, {
          type: "channel.error",
          payload: {
            code: "invalid_browser_message",
            message: error instanceof Error ? error.message : "Invalid message",
            retryable: false,
          },
        });
      }
    });
    socket.once("close", () => this.removeChannelClient(group!, client));
    socket.once("error", () => this.removeChannelClient(group!, client));
  }

  revoke(agentId: string) {
    const connection = this.connections.get(agentId);
    if (!connection) return;
    connection.socket.close(1008, "agent revoked");
  }

  async close() {
    const connections = [...this.connections.values()];
    for (const connection of connections) {
      connection.socket.close(1001, "server shutting down");
    }
    await Promise.allSettled(
      connections.map(async (connection) => {
        await waitForSocketClose(connection.socket);
        await connection.closing;
      }),
    );
  }

  private subscribeChannelGroup(group: BrowserChannelGroup) {
    group.lastError = undefined;
    const connection = this.connections.get(group.agentId);
    if (
      !connection ||
      connection.socket.readyState !== connection.socket.OPEN ||
      (!connection.capabilities.includes("room-messages") &&
        !connection.capabilities.includes("room-workloads"))
    ) {
      group.state = "offline";
      this.broadcastChannel(group, {
        type: "channel.status",
        payload: { state: "offline" },
      });
      return;
    }
    group.state = "connecting";
    this.broadcastChannel(group, {
      type: "channel.status",
      payload: { state: "connecting" },
    });
    send(connection.socket, {
      protocolVersion: agentControlProtocolVersion,
      type: "channel.subscribe",
      messageId: messageId(),
      sentAt: new Date().toISOString(),
      payload: {
        subscriptionId: group.subscriptionId,
        roomId: group.roomId,
        channelId: group.channelId,
        kind: group.kind,
      },
    });
  }

  private resubscribeAgentChannels(connection: AgentConnection) {
    for (const group of this.channelGroups.values()) {
      if (group.agentId === connection.agentId && group.clients.size > 0) {
        this.subscribeChannelGroup(group);
      }
    }
  }

  private onBrowserChannelMessage(
    group: BrowserChannelGroup,
    client: BrowserChannelClient,
    data: WebSocket.RawData,
    isBinary: boolean,
  ) {
    checkBrowserRate(client);
    if (isBinary || rawDataLength(data) > maxBrowserMessageBytes) {
      throw new Error(
        "Channel messages must be text and no larger than 64 KiB.",
      );
    }
    const input = JSON.parse(rawDataText(data)) as Record<string, unknown>;
    if (group.kind === "media") {
      if (input.type !== "media.offer" && input.type !== "media.close") {
        throw new Error("Unsupported media signaling message.");
      }
      const connection = this.connections.get(group.agentId);
      if (
        group.state !== "live" ||
        !connection ||
        connection.socket.readyState !== connection.socket.OPEN
      ) {
        throw new Error("The managed media consumer is offline.");
      }
      const common = {
        protocolVersion: agentControlProtocolVersion,
        messageId: messageId(),
        sentAt: new Date().toISOString(),
      } as const;
      if (input.type === "media.offer") {
        const workloadId =
          input.workloadId === undefined
            ? undefined
            : requiredBrowserText(input.workloadId, "workloadId", 160);
        send(connection.socket, {
          ...common,
          type: "media.offer",
          payload: {
            subscriptionId: group.subscriptionId,
            clientId: client.id,
            ...(workloadId ? { workloadId } : {}),
            sdp: requiredBrowserText(input.sdp, "sdp", 192 * 1024),
          },
        });
      } else {
        send(connection.socket, {
          ...common,
          type: "media.close",
          payload: {
            subscriptionId: group.subscriptionId,
            clientId: client.id,
          },
        });
      }
      return;
    }
    if (group.kind === "object") {
      if (input.type !== "object.download") {
        throw new Error("Unsupported object inbox message.");
      }
      const requestId = requiredBrowserText(input.requestId, "requestId", 160);
      const transferId = requiredBrowserText(
        input.transferId,
        "transferId",
        160,
      );
      const connection = this.connections.get(group.agentId);
      if (
        group.state !== "live" ||
        !connection ||
        connection.socket.readyState !== connection.socket.OPEN
      ) {
        throw new Error("The managed object inbox is offline.");
      }
      group.objectRequests.set(requestId, client.id);
      send(connection.socket, {
        protocolVersion: agentControlProtocolVersion,
        type: "object.download",
        messageId: messageId(),
        sentAt: new Date().toISOString(),
        payload: {
          subscriptionId: group.subscriptionId,
          requestId,
          transferId,
        },
      });
      return;
    }
    if (group.kind !== "message") {
      throw new Error("This Studio consumer channel is observation-only.");
    }
    if (input.type !== "channel.publish") {
      throw new Error("Unsupported channel message type.");
    }
    const clientMessageId = requiredBrowserText(
      input.clientMessageId,
      "clientMessageId",
      160,
    );
    const text = requiredBrowserText(input.text, "text", 32 * 1024);
    const connection = this.connections.get(group.agentId);
    if (
      group.state !== "live" ||
      !connection ||
      connection.socket.readyState !== connection.socket.OPEN
    ) {
      sendBrowser(client.socket, {
        type: "channel.error",
        payload: {
          clientMessageId,
          code: "channel_offline",
          message: "The managed agent is not listening to this channel.",
          retryable: true,
        },
      });
      return;
    }

    const sentAt = new Date().toISOString();
    this.broadcastChannel(group, {
      type: "channel.local_message",
      payload: { clientMessageId, text, sentAt },
    });
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        type: "message.created",
        text,
        replyTo: null,
      }),
    ).toString("base64");
    send(connection.socket, {
      protocolVersion: agentControlProtocolVersion,
      type: "channel.publish",
      messageId: messageId(),
      sentAt,
      payload: {
        subscriptionId: group.subscriptionId,
        clientMessageId,
        roomId: group.roomId,
        channelId: group.channelId,
        contentType: channelMessageContentType,
        payloadBase64: payload,
      },
    });
  }

  private removeChannelClient(
    group: BrowserChannelGroup,
    client: BrowserChannelClient,
  ) {
    for (const [requestId, clientId] of group.objectRequests) {
      if (clientId === client.id) group.objectRequests.delete(requestId);
    }
    if (!group.clients.delete(client.id) || group.clients.size > 0) return;
    this.channelGroups.delete(group.key);
    this.channelGroupsBySubscription.delete(group.subscriptionId);
    const connection = this.connections.get(group.agentId);
    if (connection && connection.socket.readyState === connection.socket.OPEN) {
      send(connection.socket, {
        protocolVersion: agentControlProtocolVersion,
        type: "channel.unsubscribe",
        messageId: messageId(),
        sentAt: new Date().toISOString(),
        payload: { subscriptionId: group.subscriptionId },
      });
    }
  }

  private forwardChannelEnvelope(
    envelope: Extract<
      ReturnType<typeof agentToStudioEnvelopeSchema.parse>,
      { type: `channel.${string}` }
    >,
  ) {
    const group = this.channelGroupsBySubscription.get(
      envelope.payload.subscriptionId,
    );
    if (!group || group.agentId !== envelope.payload.agentId) return;
    if (envelope.type === "channel.subscribed") {
      group.state = "live";
      group.lastError = undefined;
      this.broadcastChannel(group, {
        type: "channel.status",
        payload: { state: "live" },
      });
      return;
    }
    if (
      envelope.type === "channel.error" &&
      !envelope.payload.clientMessageId
    ) {
      group.state = "error";
      group.lastError = envelope.payload;
    }
    if (envelope.type === "channel.error" && envelope.payload.clientMessageId) {
      if (group.kind === "media") {
        const client = group.clients.get(envelope.payload.clientMessageId);
        if (client) {
          sendBrowser(client.socket, {
            type: envelope.type,
            payload: envelope.payload,
          });
          return;
        }
      }
      const clientId = group.objectRequests.get(
        envelope.payload.clientMessageId,
      );
      const client = clientId ? group.clients.get(clientId) : null;
      if (client) {
        group.objectRequests.delete(envelope.payload.clientMessageId);
        sendBrowser(client.socket, {
          type: envelope.type,
          payload: envelope.payload,
        });
        return;
      }
    }
    this.broadcastChannel(group, {
      type: envelope.type,
      payload: envelope.payload,
    });
  }

  private forwardMediaAnswer(
    envelope: Extract<
      ReturnType<typeof agentToStudioEnvelopeSchema.parse>,
      { type: "media.answer" }
    >,
  ) {
    const group = this.channelGroupsBySubscription.get(
      envelope.payload.subscriptionId,
    );
    if (!group || group.agentId !== envelope.payload.agentId) return;
    const client = group.clients.get(envelope.payload.clientId);
    if (client) {
      sendBrowser(client.socket, {
        type: "media.answer",
        payload: { sdp: envelope.payload.sdp },
      });
    }
  }

  private async forwardObjectChunk(
    envelope: Extract<
      ReturnType<typeof agentToStudioEnvelopeSchema.parse>,
      { type: "object.chunk" }
    >,
  ) {
    const group = this.channelGroupsBySubscription.get(
      envelope.payload.subscriptionId,
    );
    if (!group || group.agentId !== envelope.payload.agentId) return;
    const clientId = group.objectRequests.get(envelope.payload.requestId);
    const client = clientId ? group.clients.get(clientId) : null;
    if (!client) return;
    await sendBrowserWithBackpressure(client.socket, {
      type: "object.chunk",
      payload: envelope.payload,
    });
    if (envelope.payload.eof)
      group.objectRequests.delete(envelope.payload.requestId);
  }

  private broadcastChannel(group: BrowserChannelGroup, message: unknown) {
    for (const client of group.clients.values()) {
      sendBrowser(client.socket, message);
    }
  }

  private async awaitHello(socket: WebSocket, expectedAgentId: string) {
    return new Promise<AgentHelloPayload | null>((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        socket.close(1008, "hello timeout");
        resolve(null);
      }, 10_000);
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        cleanup();
        if (isBinary || rawDataLength(data) > agentControlMaxMessageBytes) {
          socket.close(1009, "message too large or binary");
          resolve(null);
          return;
        }
        try {
          const parsed = agentToStudioEnvelopeSchema.parse(
            JSON.parse(rawDataText(data)),
          );
          if (
            parsed.type !== "agent.hello" ||
            parsed.payload.agentId !== expectedAgentId ||
            parsed.payload.protocolMin > agentControlProtocolVersion ||
            parsed.payload.protocolMax < agentControlProtocolVersion
          ) {
            throw new Error("incompatible hello");
          }
          resolve(parsed.payload);
        } catch {
          socket.close(1008, "invalid hello");
          resolve(null);
        }
      };
      const onClose = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        socket.off("close", onClose);
      };
      socket.once("message", onMessage);
      socket.once("close", onClose);
    });
  }

  private async onMessage(
    connection: AgentConnection,
    data: WebSocket.RawData,
    isBinary: boolean,
  ) {
    if (isBinary || rawDataLength(data) > agentControlMaxMessageBytes) {
      connection.socket.close(1009, "message too large or binary");
      return;
    }
    const envelope = agentToStudioEnvelopeSchema.parse(
      JSON.parse(rawDataText(data)),
    );
    this.checkRate(
      connection,
      envelope.type.startsWith("channel.") ||
        envelope.type === "object.chunk" ||
        envelope.type === "media.answer",
    );
    if (envelope.payload.agentId !== connection.agentId) {
      throw new Error("agent identity mismatch");
    }
    switch (envelope.type) {
      case "agent.heartbeat":
        if (
          envelope.payload.sessionGeneration !== connection.generation ||
          envelope.payload.bootId.length === 0
        ) {
          throw new Error("stale heartbeat");
        }
        await this.repository.heartbeat(
          connection.agentId,
          connection.sessionId,
          connection.generation,
        );
        await this.dispatchAgent(connection.agentId);
        return;
      case "command.accepted":
      case "command.progress":
      case "command.completed":
      case "command.failed":
      case "command.cancelled":
        await this.repository.applyCommandEvent(
          connection.sessionId,
          envelope.type,
          envelope.payload,
        );
        if (
          ["completed", "failed", "cancelled"].includes(envelope.payload.state)
        ) {
          const waiter = this.commandWaiters.get(envelope.payload.commandId);
          if (waiter && waiter.agentId === connection.agentId) {
            clearTimeout(waiter.timer);
            this.commandWaiters.delete(envelope.payload.commandId);
            waiter.resolve({
              state: envelope.payload.state,
              result: envelope.payload.result,
              error: envelope.payload.error,
            });
          }
        }
        return;
      case "agent.event":
        await this.repository.appendAgentEvent(connection.sessionId, {
          agentId: connection.agentId,
          generation: connection.generation,
          sequence: envelope.payload.sequence,
          eventType: envelope.payload.category,
          payload: envelope.payload.data,
        });
        return;
      case "agent.goodbye":
        if (envelope.payload.sessionGeneration !== connection.generation) {
          throw new Error("stale goodbye");
        }
        connection.socket.close(1000, "agent goodbye");
        return;
      case "channel.subscribed":
      case "channel.delivery":
      case "channel.publication":
      case "channel.error":
        this.forwardChannelEnvelope(envelope);
        return;
      case "media.answer":
        this.forwardMediaAnswer(envelope);
        return;
      case "object.chunk":
        await this.forwardObjectChunk(envelope);
        return;
      case "room.storage.request":
        this.handleRoomStorageRequest(connection, envelope.payload);
        return;
      case "agent.hello":
        throw new Error("duplicate hello");
    }
  }

  private handleRoomStorageRequest(
    connection: AgentConnection,
    request: Extract<
      AgentToStudioEnvelope,
      { type: "room.storage.request" }
    >["payload"],
  ) {
    if (
      !connection.capabilities.includes("room-storage-publish") ||
      !this.roomStorageRequestHandler
    ) {
      send(connection.socket, {
        protocolVersion: agentControlProtocolVersion,
        type: "room.storage.response",
        messageId: messageId(),
        sentAt: new Date().toISOString(),
        payload: {
          requestId: request.requestId,
          operation: request.operation,
          state: "failed",
          error: {
            code: "room_storage_unavailable",
            message: "Studio room storage control is unavailable.",
            retryable: true,
          },
        },
      });
      return;
    }
    void this.completeRoomStorageRequest(connection, request);
  }

  private async completeRoomStorageRequest(
    connection: AgentConnection,
    request: Extract<
      AgentToStudioEnvelope,
      { type: "room.storage.request" }
    >["payload"],
  ) {
    try {
      const result = await this.roomStorageRequestHandler!(
        connection.agentId,
        request,
      );
      send(connection.socket, {
        protocolVersion: agentControlProtocolVersion,
        type: "room.storage.response",
        messageId: messageId(),
        sentAt: new Date().toISOString(),
        payload: {
          requestId: request.requestId,
          operation: request.operation,
          state: "completed",
          ...result,
        },
      });
    } catch (error) {
      const candidate = error as {
        code?: unknown;
        statusCode?: unknown;
        retryable?: unknown;
        message?: unknown;
      };
      send(connection.socket, {
        protocolVersion: agentControlProtocolVersion,
        type: "room.storage.response",
        messageId: messageId(),
        sentAt: new Date().toISOString(),
        payload: {
          requestId: request.requestId,
          operation: request.operation,
          state: "failed",
          error: {
            code:
              typeof candidate.code === "string"
                ? candidate.code.slice(0, 160)
                : "room_storage_request_failed",
            message:
              typeof candidate.message === "string"
                ? candidate.message.slice(0, 500)
                : "Room storage request failed.",
            retryable:
              typeof candidate.retryable === "boolean"
                ? candidate.retryable
                : Number(candidate.statusCode ?? 500) >= 500,
          },
        },
      });
    }
  }

  private checkRate(connection: AgentConnection, channelMessage: boolean) {
    const now = Date.now();
    if (now - connection.rateWindowStartedAt >= 60_000) {
      connection.rateWindowStartedAt = now;
      connection.messageCount = 0;
      connection.channelMessageCount = 0;
    }
    if (channelMessage) {
      connection.channelMessageCount += 1;
      if (connection.channelMessageCount > maxChannelMessagesPerMinute) {
        throw new Error("agent channel message rate exceeded");
      }
    } else {
      connection.messageCount += 1;
      if (connection.messageCount > maxAgentMessagesPerMinute) {
        throw new Error("agent message rate exceeded");
      }
    }
  }

  private async closed(connection: AgentConnection) {
    const wasCurrent = this.connections.deleteIfCurrent(
      connection.agentId,
      connection,
    );
    await this.repository.closeSession(
      connection.sessionId,
      connection.agentId,
      connection.generation,
      "websocket closed",
    );
    // A replaced socket closes after its successor is already registered. It
    // must not mark that newer live session (or its channel groups) offline.
    if (!wasCurrent) return;
    for (const group of this.channelGroups.values()) {
      if (group.agentId !== connection.agentId) continue;
      group.state = "offline";
      this.broadcastChannel(group, {
        type: "channel.status",
        payload: { state: "offline" },
      });
    }
    this.logger.info(
      { agentId: connection.agentId, generation: connection.generation },
      "Agent disconnected",
    );
  }
}

function waitForSocketClose(socket: WebSocket) {
  if (socket.readyState === socket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

function send(socket: WebSocket, message: StudioToAgentEnvelope) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendBrowser(socket: WebSocket, message: unknown) {
  if (socket.readyState === socket.OPEN) {
    if (socket.bufferedAmount > maxBrowserBufferedBytes) {
      socket.close(1013, "channel client is too slow");
      return;
    }
    socket.send(JSON.stringify(message));
  }
}

function sendBrowserWithBackpressure(socket: WebSocket, message: unknown) {
  return new Promise<void>((resolve) => {
    if (socket.readyState !== socket.OPEN) {
      resolve();
      return;
    }
    if (socket.bufferedAmount > maxBrowserBufferedBytes) {
      socket.close(1013, "channel client is too slow");
      resolve();
      return;
    }
    socket.send(JSON.stringify(message), () => resolve());
  });
}

function channelGroupKey(input: {
  agentId: string;
  roomId: string;
  channelId: string;
}) {
  return `${input.agentId}\u0000${input.roomId}\u0000${input.channelId}`;
}

function checkBrowserRate(client: BrowserChannelClient) {
  const now = Date.now();
  if (now - client.rateWindowStartedAt >= 60_000) {
    client.rateWindowStartedAt = now;
    client.messageCount = 0;
  }
  client.messageCount += 1;
  if (client.messageCount > 120) {
    throw new Error("Channel publication rate exceeded.");
  }
}

function requiredBrowserText(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(
      `${name} is required and must not exceed ${max} characters.`,
    );
  }
  return value;
}

function messageId() {
  return `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function errorCode(error: unknown) {
  return (error as { code?: unknown })?.code ?? "agent_gateway_error";
}

function rawDataLength(data: WebSocket.RawData) {
  return Array.isArray(data)
    ? data.reduce((total, item) => total + item.byteLength, 0)
    : data.byteLength;
}

function rawDataText(data: WebSocket.RawData) {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

