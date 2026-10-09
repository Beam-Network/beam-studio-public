import { randomUUID } from "node:crypto";
import type { CoordinatorRoomClient } from "./coordinator-client.js";
import { maxAgentMessagesPerMinute } from "./gateway.js";

type JsonObject = Record<string, unknown>;

export type AttachableRoomConsumer = {
  id: string;
  status: string;
  sessionGeneration: number;
};

export type RoomConsumerErrorCode =
  | "room_consumer_offline"
  | "room_consumer_not_ready";

/**
 * A consumer that cannot serve the room it was asked to attach to. Thrown
 * from a route, the API error handler answers with its code, message,
 * details and status.
 */
export class RoomConsumerError extends Error {
  readonly retryable = true;
  readonly expose = true;

  constructor(
    readonly code: RoomConsumerErrorCode,
    message: string,
    readonly statusCode: number,
    readonly details: JsonObject,
  ) {
    super(message);
    this.name = "RoomConsumerError";
  }
}

export function roomConsumerOffline(agentId: string, roomId: string) {
  return new RoomConsumerError(
    "room_consumer_offline",
    "The Studio room consumer is offline. Rooms open once it reconnects to Studio.",
    409,
    { agentId, roomId },
  );
}

function roomConsumerNotReady(
  agentId: string,
  roomId: string,
  cause: string,
  agentErrorCode?: string,
) {
  return new RoomConsumerError(
    "room_consumer_not_ready",
    `The Studio room agent has not loaded the Room: ${cause}`,
    503,
    { agentId, roomId, ...(agentErrorCode ? { agentErrorCode } : {}) },
  );
}

export type RoomRefreshCommands = {
  createCommand(input: {
    organizationId: string;
    agentId: string;
    operation: "room.refresh";
    payload: JsonObject;
    idempotencyKey: string;
    ttlSeconds: number;
  }): Promise<{ id: string }>;
};

export type RoomRefreshGateway = {
  isConnected(agentId: string): boolean;
  dispatchAndWait(
    agentId: string,
    commandId: string,
    timeoutMs: number,
  ): Promise<{ state: string; error?: Record<string, unknown> }>;
};

export type RoomConsumerAttachInput = {
  coordinator: Pick<CoordinatorRoomClient, "attachOrganizationRoomConsumer">;
  token: string;
  organizationId: string;
  roomId: string;
  consumer: AttachableRoomConsumer;
  idempotencyKey: string;
};

type Clock = { now(): number; sleep(ms: number): Promise<void> };

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const refreshTimeoutMs = 30_000;
/** As long as the coordinator's consumer lease. */
const refreshReuseMs = 60_000;
const refreshWindowMs = 60_000;
/**
 * Each command costs the agent three control messages (accepted, running,
 * completed), and the gateway disconnects an agent that exceeds its
 * per-minute message limit. Refreshes use at most half of that limit, leaving
 * the rest for heartbeats, events and other commands.
 */
export const roomRefreshesPerMinute = Math.floor(maxAgentMessagesPerMinute / 6);

/**
 * Attaches a consumer agent to an organization room and makes the agent load
 * that room.
 *
 * The coordinator membership alone never reaches the agent: until the agent
 * runs `room.refresh`, its room manager does not know the room and the media,
 * channel and object paths fail later for lack of a room key. Every attach
 * therefore waits for the agent's refresh and reports its failure explicitly.
 *
 * Attaches of the same consumer session and room share one refresh while it
 * runs and for one consumer lease after it succeeds; a new agent session
 * refreshes again. Refreshes for one agent stay within `roomRefreshesPerMinute`.
 */
export class RoomConsumerAttacher {
  private readonly refreshes = new Map<
    string,
    { promise: Promise<void>; reusableUntil: number | null }
  >();
  private readonly dispatches = new Map<string, number[]>();

  constructor(
    private readonly commands: RoomRefreshCommands,
    private readonly gateway: RoomRefreshGateway,
    private readonly clock: Clock = systemClock,
  ) {}

  async attach(input: RoomConsumerAttachInput): Promise<JsonObject> {
    const { consumer, roomId } = input;
    if (
      consumer.status !== "online" ||
      !this.gateway.isConnected(consumer.id)
    ) {
      throw roomConsumerOffline(consumer.id, roomId);
    }
    const key = `${consumer.id}\u0000${consumer.sessionGeneration}\u0000${roomId}`;
    const shared = this.reusableRefresh(key);
    if (shared) {
      const membership = await this.attachMembership(input);
      await shared;
      return membership;
    }
    // The refresh budget is reserved before the coordinator attach, so the
    // membership and the agent's refresh stay close together under the lease.
    const membership = this.reserveRefresh(consumer.id).then(() =>
      this.attachMembership(input),
    );
    const refreshed = membership.then(() => this.refresh(input));
    this.remember(key, refreshed);
    await refreshed;
    return membership;
  }

  private attachMembership(input: RoomConsumerAttachInput) {
    return input.coordinator.attachOrganizationRoomConsumer(
      input.organizationId,
      input.roomId,
      input.consumer.id,
      input.idempotencyKey,
      input.token,
    );
  }

  private async refresh({
    organizationId,
    consumer,
    roomId,
  }: RoomConsumerAttachInput) {
    if (!this.gateway.isConnected(consumer.id)) {
      throw roomConsumerOffline(consumer.id, roomId);
    }
    const command = await this.commands.createCommand({
      organizationId,
      agentId: consumer.id,
      operation: "room.refresh",
      payload: { room_id: roomId },
      idempotencyKey: `studio-consumer-refresh:${randomUUID()}`,
      ttlSeconds: refreshTimeoutMs / 1_000,
    });
    let terminal: Awaited<ReturnType<RoomRefreshGateway["dispatchAndWait"]>>;
    try {
      terminal = await this.gateway.dispatchAndWait(
        consumer.id,
        command.id,
        refreshTimeoutMs,
      );
    } catch (error) {
      throw roomConsumerNotReady(
        consumer.id,
        roomId,
        error instanceof Error ? error.message : "the refresh did not finish.",
      );
    }
    if (terminal.state !== "completed") {
      throw roomConsumerNotReady(
        consumer.id,
        roomId,
        text(terminal.error?.message) ?? `the refresh ended ${terminal.state}.`,
        text(terminal.error?.code),
      );
    }
  }

  private reusableRefresh(key: string) {
    const entry = this.refreshes.get(key);
    if (!entry) return null;
    if (entry.reusableUntil === null || entry.reusableUntil > this.clock.now())
      return entry.promise;
    this.refreshes.delete(key);
    return null;
  }

  private remember(key: string, promise: Promise<void>) {
    const now = this.clock.now();
    for (const [candidate, entry] of this.refreshes) {
      if (entry.reusableUntil !== null && entry.reusableUntil <= now)
        this.refreshes.delete(candidate);
    }
    const entry = { promise, reusableUntil: null as number | null };
    this.refreshes.set(key, entry);
    promise.then(
      () => {
        entry.reusableUntil = this.clock.now() + refreshReuseMs;
      },
      () => {
        if (this.refreshes.get(key) === entry) this.refreshes.delete(key);
      },
    );
  }

  private async reserveRefresh(agentId: string) {
    for (;;) {
      const now = this.clock.now();
      const recent = (this.dispatches.get(agentId) ?? []).filter(
        (at) => now - at < refreshWindowMs,
      );
      if (recent.length < roomRefreshesPerMinute) {
        recent.push(now);
        this.dispatches.set(agentId, recent);
        return;
      }
      this.dispatches.set(agentId, recent);
      await this.clock.sleep(recent[0]! + refreshWindowMs - now);
    }
  }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
