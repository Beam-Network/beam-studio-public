import assert from "node:assert/strict";
import test from "node:test";
import {
  RoomConsumerAttacher,
  RoomConsumerError,
  roomRefreshesPerMinute,
  type RoomConsumerAttachInput,
  type RoomRefreshGateway,
} from "./room-consumer-attach.js";

type Call = { method: string; args: unknown[]; at: number };

function harness(
  options: {
    connected?: boolean;
    dispatch?: RoomRefreshGateway["dispatchAndWait"];
  } = {},
) {
  let now = 1_000_000;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const sleepers: (() => void)[] = [];
  const record = (method: string, ...args: unknown[]) =>
    calls.push({ method, args, at: now });
  const attacher = new RoomConsumerAttacher(
    {
      async createCommand(input) {
        record("createCommand", input);
        return { id: `cmd-${calls.length}` };
      },
    },
    {
      isConnected: () => options.connected ?? true,
      async dispatchAndWait(agentId, commandId, timeoutMs) {
        record("dispatchAndWait", agentId, commandId, timeoutMs);
        return options.dispatch
          ? options.dispatch(agentId, commandId, timeoutMs)
          : { state: "completed", result: {} };
      },
    },
    {
      now: () => now,
      sleep(ms) {
        sleeps.push(ms);
        return new Promise<void>((resolve) => sleepers.push(resolve));
      },
    },
  );
  const coordinator = {
    async attachOrganizationRoomConsumer(...args: unknown[]) {
      record("attachOrganizationRoomConsumer", ...args);
      return { membership: { member_id: `member-${String(args[1])}` } };
    },
  } as RoomConsumerAttachInput["coordinator"];
  const attach = (
    roomId = "room-1",
    consumer: Partial<RoomConsumerAttachInput["consumer"]> = {},
  ) =>
    attacher.attach({
      coordinator,
      token: "org-token",
      organizationId: "org-a",
      roomId,
      consumer: {
        id: "consumer-1",
        status: "online",
        sessionGeneration: 1,
        ...consumer,
      },
      idempotencyKey: `studio-media-consumer:consumer-1:${roomId}`,
    });
  const methods = () => calls.map((call) => call.method);
  const count = (method: string) =>
    calls.filter((call) => call.method === method).length;
  return {
    attach,
    calls,
    count,
    methods,
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
    wake: () => sleepers.splice(0).forEach((resolve) => resolve()),
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RoomConsumerError, String(error));
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test("the consumer is told to load the room right after the coordinator attach", async () => {
  const h = harness();
  const membership = await h.attach("room-1");
  assert.deepEqual(membership, { membership: { member_id: "member-room-1" } });
  assert.deepEqual(h.methods(), [
    "attachOrganizationRoomConsumer",
    "createCommand",
    "dispatchAndWait",
  ]);
  assert.deepEqual(h.calls[0]!.args, [
    "org-a",
    "room-1",
    "consumer-1",
    "studio-media-consumer:consumer-1:room-1",
    "org-token",
  ]);
  const command = h.calls[1]!.args[0] as Record<string, unknown>;
  assert.equal(command.organizationId, "org-a");
  assert.equal(command.agentId, "consumer-1");
  assert.equal(command.operation, "room.refresh");
  assert.deepEqual(command.payload, { room_id: "room-1" });
  assert.match(String(command.idempotencyKey), /^studio-consumer-refresh:/);
  assert.equal(h.calls[2]!.args[0], "consumer-1");
  assert.equal(h.calls[2]!.args[1], "cmd-2");
});

test("a refresh failure surfaces room_consumer_not_ready and is retried on the next attach", async () => {
  let failures = 1;
  const h = harness({
    dispatch: async () =>
      failures-- > 0
        ? {
            state: "failed",
            error: {
              code: "room_not_found",
              message: "room manager: room not found",
            },
          }
        : { state: "completed" },
  });
  const error = await rejectsWith(h.attach(), "room_consumer_not_ready");
  assert.equal(
    error.message,
    "The Studio room agent has not loaded the Room: room manager: room not found",
  );
  assert.equal(error.statusCode, 503);
  assert.equal(error.retryable, true);
  assert.deepEqual(error.details, {
    agentId: "consumer-1",
    roomId: "room-1",
    agentErrorCode: "room_not_found",
  });
  await h.attach();
  assert.equal(h.count("createCommand"), 2, "a failed refresh is not reused");
});

test("an unanswered refresh surfaces room_consumer_not_ready", async () => {
  const h = harness({
    dispatch: async () => {
      throw new Error("Timed out waiting for the agent endpoint command.");
    },
  });
  const error = await rejectsWith(h.attach(), "room_consumer_not_ready");
  assert.match(error.message, /has not loaded the Room: Timed out/);
});

test("an offline consumer is refused before anything is attached", async () => {
  const offline = harness();
  const error = await rejectsWith(
    offline.attach("room-1", { status: "offline" }),
    "room_consumer_offline",
  );
  assert.equal(error.statusCode, 409);
  assert.deepEqual(offline.calls, []);

  const disconnected = harness({ connected: false });
  await rejectsWith(disconnected.attach("room-1"), "room_consumer_offline");
  assert.deepEqual(disconnected.calls, []);
});

test("attaches of one consumer session and room share a refresh instead of sending one per request", async () => {
  const h = harness();
  await Promise.all([h.attach(), h.attach(), h.attach()]);
  assert.equal(h.count("attachOrganizationRoomConsumer"), 3);
  assert.equal(h.count("createCommand"), 1);

  await h.attach();
  assert.equal(h.count("createCommand"), 1, "reused within the lease");

  await h.attach("room-2");
  assert.equal(h.count("createCommand"), 2, "another room refreshes");

  await h.attach("room-1", { sessionGeneration: 2 });
  assert.equal(h.count("createCommand"), 3, "a new agent session refreshes");

  h.advance(60_000);
  await h.attach();
  assert.equal(h.count("createCommand"), 4, "refreshed again after the lease");
});

test("refreshes stay within the per-agent budget below the gateway rate limit", async () => {
  assert.ok(roomRefreshesPerMinute * 3 <= 240 / 2);
  const h = harness();
  const rooms = Array.from(
    { length: roomRefreshesPerMinute + 1 },
    (_, index) => `room-${index}`,
  );
  const attached = Promise.all(rooms.map((roomId) => h.attach(roomId)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.count("createCommand"), roomRefreshesPerMinute);
  assert.equal(
    h.count("attachOrganizationRoomConsumer"),
    roomRefreshesPerMinute,
  );
  assert.deepEqual(h.sleeps, [60_000]);

  h.advance(60_000);
  h.wake();
  await attached;
  const commands = h.calls.filter((call) => call.method === "createCommand");
  assert.equal(commands.length, rooms.length);
  assert.equal(commands.at(-1)!.at, commands[0]!.at + 60_000);
  // The delayed room is attached only once its refresh can be sent.
  const attaches = h.calls.filter(
    (call) => call.method === "attachOrganizationRoomConsumer",
  );
  assert.equal(attaches.at(-1)!.at, commands[0]!.at + 60_000);
});
