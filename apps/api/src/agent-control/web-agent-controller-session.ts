import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { roomActionContentType } from "@beam-studio/shared";
import type { WebAgentControllerBinding } from "./web-agent-controller-config.js";

type Json = Record<string, unknown>;
type Delivery = {
  roomId: string;
  channelId: string;
  publisherMemberId: string;
  publicationId: string;
  contentType: string;
  payload: Buffer;
};
type Pending = {
  resolve(value: Json): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** One server-owned Web Agent session. Reconnect creates new resource IDs; the
 * durable command journal, not this socket, decides what may be retried. */
export class WebAgentControllerSession {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private ready = false;
  private readonly pending = new Map<string, Pending>();
  private readonly resources = new Map<string, string>();
  private readonly subscriptions = new Map<string, string>();
  private readonly openingSubscriptions = new Map<string, Promise<void>>();
  private readonly subscriptionWaiters = new Map<string, Pending>();
  private readonly earlyResourceEvents = new Map<string, "ready" | "error">();
  private lastBootId: string | null = null;

  constructor(
    readonly binding: WebAgentControllerBinding,
    private readonly onDelivery: (delivery: Delivery) => Promise<void>,
  ) {}

  get connected() {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  get bootId() {
    return this.lastBootId;
  }

  async connect() {
    if (this.connected) return;
    if (this.opening) return this.opening;
    this.opening = this.open();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  private async open() {
    const socket = new WebSocket(this.binding.url, "beam.web-agent.v1", {
      origin: this.binding.origin,
      handshakeTimeout: 5_000,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    });
    this.socket = socket;
    this.ready = false;
    this.resources.clear();
    this.subscriptions.clear();
    this.earlyResourceEvents.clear();
    socket.on("message", (data, isBinary) => {
      if (socket !== this.socket) return;
      if (isBinary || Buffer.byteLength(data.toString()) > 256 * 1024) {
        socket.close(1008, "invalid control frame");
        return;
      }
      try {
        this.receive(JSON.parse(data.toString()) as Json);
      } catch {
        socket.close(1008, "invalid control frame");
      }
    });
    socket.on("close", () => this.closed(socket));
    socket.on("error", () => this.closed(socket));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("Web Agent connection timed out."));
      }, 8_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Web Agent disconnected before authentication."));
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Web Agent connection failed."));
      });
    });
    try {
      const data = await this.call("session.authenticate", {
        token: this.binding.credential,
      }, 5_000, true);
      const status = object(data.status);
      if (
        data.protocol !== "beam.web-agent.v1" ||
        status.agentId !== this.binding.agentId ||
        typeof status.bootId !== "string" || !status.bootId ||
        status.connected !== true
      )
        throw new Error("Web Agent controller identity or readiness changed.");
      this.lastBootId = status.bootId;
      this.ready = true;
    } catch (error) {
      socket.close(1008, "controller identity mismatch");
      throw error;
    }
  }

  async subscribe(channelId: string, peerMemberId: string) {
    await this.connect();
    if (this.subscriptions.has(channelId)) return;
    const opening = this.openingSubscriptions.get(channelId);
    if (opening) return opening;
    const pending = this.openSubscription(channelId, peerMemberId);
    this.openingSubscriptions.set(channelId, pending);
    try {
      await pending;
    } finally {
      if (this.openingSubscriptions.get(channelId) === pending)
        this.openingSubscriptions.delete(channelId);
    }
  }

  private async openSubscription(channelId: string, peerMemberId: string) {
    const result = await this.call("channel.subscribe.private", {
      roomId: this.binding.roomId,
      channelId,
      peerMemberId,
    });
    const resourceId = result.resourceId;
    if (typeof resourceId !== "string" || !resourceId)
      throw new Error("Web Agent returned no subscription identity.");
    this.resources.set(resourceId, channelId);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.subscriptionWaiters.delete(resourceId);
          reject(new Error("Web Agent subscription was not ready."));
        }, 35_000);
        this.subscriptionWaiters.set(resourceId, { resolve: () => resolve(), reject, timer });
        const early = this.earlyResourceEvents.get(resourceId);
        this.earlyResourceEvents.delete(resourceId);
        if (early) this.subscriptionEvent(resourceId, early);
      });
      this.subscriptions.set(channelId, resourceId);
    } catch (error) {
      this.resources.delete(resourceId);
      this.earlyResourceEvents.delete(resourceId);
      void this.call("channel.unsubscribe", { resourceId }, 5_000).catch(() => {});
      throw error;
    }
  }

  /** Call only after the journal has persisted the command and resolved any
   * earlier uncertain publication. This sends no implicit retry. */
  async publishPrivate(input: {
    channelId: string;
    recipientMemberId: string;
    payload: Buffer;
    idempotencyKey: string;
    beforeSend: () => Promise<boolean>;
  }) {
    await this.subscribe(input.channelId, input.recipientMemberId);
    if (!await input.beforeSend()) return null;
    return this.call("message.publish.private", {
      roomId: this.binding.roomId,
      channelId: input.channelId,
      recipientMemberId: input.recipientMemberId,
      payload: input.payload.toString("base64"),
      contentType: roomActionContentType,
      idempotencyKey: input.idempotencyKey,
    }, 30_000);
  }

  close() {
    this.socket?.close(1000, "controller stopping");
    this.closed(this.socket);
  }

  private call(
    type: string,
    fields: Json,
    timeoutMs = 30_000,
    authenticating = false,
  ): Promise<Json> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || (!authenticating && !this.ready))
      return Promise.reject(new Error("Web Agent controller is disconnected."));
    const requestId = `studio_${randomUUID().replaceAll("-", "")}`;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Web Agent request outcome is uncertain."));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ type, requestId, ...fields }), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(requestId);
          pending.reject(new Error("Web Agent request was not sent."));
        }
      });
    });
  }

  private receive(wire: Json) {
    const type = wire.type;
    if (type === "session.ready" || type === "response") {
      const requestId = wire.requestId;
      if (typeof requestId !== "string") throw new Error("Missing response ID.");
      const pending = this.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      if (wire.error) {
        const error = object(wire.error);
        pending.reject(Object.assign(new Error(String(error.message ?? "Web Agent rejected request.")), {
          code: String(error.code ?? "web_agent_rejected"),
        }));
      } else pending.resolve(object(wire.data));
      return;
    }
    if (type === "connection.state") {
      const status = object(wire.data);
      if (
        (status.agentId && status.agentId !== this.binding.agentId) ||
        (this.lastBootId && status.bootId && status.bootId !== this.lastBootId) ||
        (this.ready && status.connected === false)
      )
        this.socket?.close(1008, "controller identity changed");
      return;
    }
    const resourceId = wire.resourceId;
    if (typeof resourceId !== "string") return;
    const channelId = this.resources.get(resourceId);
    if (type === "subscription.ready") {
      if (!channelId) this.rememberEarlyResourceEvent(resourceId, "ready");
      else this.subscriptionEvent(resourceId, "ready");
      return;
    }
    if (type === "resource.error") {
      if (!channelId) this.rememberEarlyResourceEvent(resourceId, "error");
      else this.subscriptionEvent(resourceId, "error");
      return;
    }
    if (!channelId) return;
    if (type !== "message.delivery.private") return;
    const data = object(wire.data);
    if (
      typeof data.publisherMemberId !== "string" ||
      typeof data.publicationId !== "string" ||
      typeof data.contentType !== "string" ||
      typeof data.payload !== "string"
    )
      throw new Error("Invalid Web Agent delivery.");
    void this.onDelivery({
      roomId: this.binding.roomId,
      channelId,
      publisherMemberId: data.publisherMemberId,
      publicationId: data.publicationId,
      contentType: data.contentType,
      payload: Buffer.from(data.payload, "base64"),
    }).catch(() => {});
  }

  private closed(socket: WebSocket | null) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.ready = false;
    this.resources.clear();
    this.subscriptions.clear();
    this.openingSubscriptions.clear();
    this.earlyResourceEvents.clear();
    for (const pending of [...this.pending.values(), ...this.subscriptionWaiters.values()]) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Web Agent disconnected; outcome requires reconciliation."));
    }
    this.pending.clear();
    this.subscriptionWaiters.clear();
  }

  private subscriptionEvent(resourceId: string, event: "ready" | "error") {
    const pending = this.subscriptionWaiters.get(resourceId);
    if (event === "error") {
      const channelId = this.resources.get(resourceId);
      this.resources.delete(resourceId);
      if (channelId) this.subscriptions.delete(channelId);
    }
    if (!pending) return;
    clearTimeout(pending.timer);
    this.subscriptionWaiters.delete(resourceId);
    if (event === "ready") pending.resolve({});
    else pending.reject(new Error("Web Agent subscription failed."));
  }

  private rememberEarlyResourceEvent(resourceId: string, event: "ready" | "error") {
    if (this.earlyResourceEvents.size >= 128)
      throw new Error("Too many unclaimed Web Agent resource events.");
    this.earlyResourceEvents.set(resourceId, event);
  }
}

function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Web Agent response.");
  return value as Json;
}
