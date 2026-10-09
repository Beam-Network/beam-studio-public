import assert from "node:assert/strict";
import test from "node:test";
import { RoomConsumerAttacher } from "./room-consumer-attach.js";
import {
  createRoomWithConsumer,
  roomConsumerUnavailableCode,
  roomConsumerUnavailableMessage,
  type RoomCreateCoordinator,
} from "./room-create.js";
import type { CoordinatorRoomClient } from "./coordinator-client.js";

const agent = (
  id: string,
  status = "online",
  capabilities = ["studio-room-consumer"],
) => ({ id, status, capabilities, sessionGeneration: 1 });

type Call = { method: string; args: unknown[] };

function fakeCoordinator(options: { authorized?: string[] } = {}) {
  const calls: Call[] = [];
  const authorized = new Set(options.authorized ?? []);
  const coordinator: RoomCreateCoordinator &
    Pick<CoordinatorRoomClient, "attachOrganizationRoomConsumer"> = {
    async listRooms(...args: Parameters<RoomCreateCoordinator["listRooms"]>) {
      calls.push({ method: "listRooms", args });
      if (!authorized.has(args[1])) throw new Error("permission denied");
      return { rooms: [] };
    },
    async mutateOrganizationRoom(
      ...args: Parameters<RoomCreateCoordinator["mutateOrganizationRoom"]>
    ) {
      calls.push({ method: "mutateOrganizationRoom", args });
      return {
        room: {
          room: { room_id: "room_new" },
          membership: { member_id: "member_owner" },
        },
      };
    },
    async attachOrganizationRoomConsumer(
      ...args: Parameters<
        CoordinatorRoomClient["attachOrganizationRoomConsumer"]
      >
    ) {
      calls.push({ method: "attachOrganizationRoomConsumer", args });
      return { membership: { member_id: "member_consumer" } };
    },
  };
  return { coordinator, calls };
}

/** The consumer attach path with an agent that answers `room.refresh`. */
function consumerAttach(
  coordinator: ReturnType<typeof fakeCoordinator>["coordinator"],
  calls: Call[],
  refreshError?: { code: string; message: string },
) {
  const attacher = new RoomConsumerAttacher(
    {
      async createCommand(input) {
        calls.push({ method: "createCommand", args: [input] });
        return { id: `cmd-${calls.length}` };
      },
    },
    {
      isConnected: () => true,
      async dispatchAndWait(agentId, commandId) {
        calls.push({ method: "dispatchAndWait", args: [agentId, commandId] });
        return refreshError
          ? { state: "failed", error: refreshError }
          : { state: "completed" };
      },
    },
  );
  return (consumer: ReturnType<typeof agent>, roomId: string) =>
    attacher.attach({
      coordinator,
      token: baseInput.token,
      organizationId: baseInput.organizationId,
      roomId,
      consumer,
      idempotencyKey: `studio-consumer:${consumer.id}:${roomId}`,
    });
}

const baseInput = {
  organizationId: "org-a",
  token: "session-token",
  payload: { lease_ttl_seconds: 60 },
  idempotencyKey: "create-1",
  apiKey: "beam_sk_test",
};

test("no enrolled consumer: the billable create is never requested", async () => {
  const { coordinator, calls } = fakeCoordinator();
  const outcome = await createRoomWithConsumer({
    ...baseInput,
    coordinator,
    attachConsumer: consumerAttach(coordinator, calls),
    agents: [
      agent("worker", "online", ["rooms"]),
      agent("old-consumer", "revoked"),
    ],
  });
  assert.deepEqual(outcome, { created: false, reason: "not_enrolled" });
  // No coordinator call at all, so no room and no credit hold or commit.
  assert.deepEqual(calls, []);
});

test("consumer not authorized for the organization: no create and no charge", async () => {
  const { coordinator, calls } = fakeCoordinator({ authorized: [] });
  const outcome = await createRoomWithConsumer({
    ...baseInput,
    coordinator,
    attachConsumer: consumerAttach(coordinator, calls),
    agents: [agent("foreign-consumer")],
  });
  assert.deepEqual(outcome, { created: false, reason: "not_authorized" });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["listRooms"],
  );
  assert.equal(
    calls.some((call) => call.method === "mutateOrganizationRoom"),
    false,
  );
});

test("available consumer: the room is created with the key and the consumer attached", async () => {
  const { coordinator, calls } = fakeCoordinator({ authorized: ["prod"] });
  const outcome = await createRoomWithConsumer({
    ...baseInput,
    coordinator,
    attachConsumer: consumerAttach(coordinator, calls),
    agents: [agent("dev"), agent("prod")],
  });
  assert.equal(outcome.created, true);
  if (!outcome.created) return;
  assert.equal(outcome.consumer.id, "prod");
  assert.deepEqual(outcome.membership, {
    membership: { member_id: "member_consumer" },
  });
  assert.equal(outcome.consumerAttachmentError, null);
  assert.deepEqual(outcome.result, {
    room: {
      room: { room_id: "room_new" },
      membership: { member_id: "member_owner" },
    },
  });

  const create = calls.filter(
    (call) => call.method === "mutateOrganizationRoom",
  );
  assert.deepEqual(create, [
    {
      method: "mutateOrganizationRoom",
      args: [
        "org-a",
        "room.create",
        { lease_ttl_seconds: 60 },
        "create-1",
        "session-token",
        "beam_sk_test",
      ],
    },
  ]);
  const attach = calls.filter(
    (call) => call.method === "attachOrganizationRoomConsumer",
  );
  assert.deepEqual(attach, [
    {
      method: "attachOrganizationRoomConsumer",
      args: [
        "org-a",
        "room_new",
        "prod",
        "studio-consumer:prod:room_new",
        "session-token",
      ],
    },
  ]);
  // The consumer is told to load the new room right after the attach.
  const attachIndex = calls.findIndex(
    (call) => call.method === "attachOrganizationRoomConsumer",
  );
  const refreshIndex = calls.findIndex(
    (call) => call.method === "createCommand",
  );
  assert.ok(attachIndex >= 0 && refreshIndex > attachIndex);
  assert.deepEqual(calls[refreshIndex]!.args[0], {
    organizationId: "org-a",
    agentId: "prod",
    operation: "room.refresh",
    payload: { room_id: "room_new" },
    idempotencyKey: (calls[refreshIndex]!.args[0] as { idempotencyKey: string })
      .idempotencyKey,
    ttlSeconds: 30,
  });
  assert.equal(
    calls.filter((call) => call.method === "dispatchAndWait").length,
    1,
  );
  // Consumer resolution happens strictly before the billable create.
  const firstCreate = calls.findIndex(
    (call) => call.method === "mutateOrganizationRoom",
  );
  const probes = calls
    .map((call, index) => (call.method === "listRooms" ? index : -1))
    .filter((index) => index >= 0);
  assert.ok(probes.length > 0);
  assert.ok(Math.max(...probes) < firstCreate);
});

test("offline consumers only: no create, no charge, and an explicit offline code", async () => {
  const { coordinator, calls } = fakeCoordinator({ authorized: ["prod"] });
  const outcome = await createRoomWithConsumer({
    ...baseInput,
    coordinator,
    attachConsumer: consumerAttach(coordinator, calls),
    agents: [agent("prod", "offline")],
  });
  assert.deepEqual(outcome, { created: false, reason: "offline" });
  assert.equal(roomConsumerUnavailableCode("offline"), "room_consumer_offline");
  assert.equal(
    calls.some(
      (call) =>
        call.method === "mutateOrganizationRoom" ||
        call.method === "attachOrganizationRoomConsumer",
    ),
    false,
  );
});

test("attachment failure after create is reported, not thrown", async () => {
  const { coordinator, calls } = fakeCoordinator({ authorized: ["prod"] });
  coordinator.attachOrganizationRoomConsumer = async () => {
    throw new Error("coordinator busy");
  };
  const failures: string[] = [];
  const outcome = await createRoomWithConsumer(
    {
      ...baseInput,
      coordinator,
      attachConsumer: consumerAttach(coordinator, calls),
      agents: [agent("prod")],
    },
    (consumer, roomId) => failures.push(`${consumer.id}:${roomId}`),
  );
  assert.equal(outcome.created, true);
  if (!outcome.created) return;
  assert.equal(outcome.membership, null);
  assert.equal(outcome.consumerAttachmentError, "coordinator busy");
  assert.deepEqual(failures, ["prod:room_new"]);
  assert.equal(
    calls.some((call) => call.method === "createCommand"),
    false,
    "no refresh is sent for a failed attach",
  );
});

test("a consumer that cannot load the new room is reported as not ready", async () => {
  const { coordinator, calls } = fakeCoordinator({ authorized: ["prod"] });
  const failures: unknown[] = [];
  const outcome = await createRoomWithConsumer(
    {
      ...baseInput,
      coordinator,
      attachConsumer: consumerAttach(coordinator, calls, {
        code: "room_not_found",
        message: "room manager: room not found",
      }),
      agents: [agent("prod")],
    },
    (_consumer, _roomId, error) => failures.push(error),
  );
  assert.equal(outcome.created, true);
  if (!outcome.created) return;
  assert.equal(outcome.membership, null);
  assert.equal(
    outcome.consumerAttachmentError,
    "The Studio room agent has not loaded the Room: room manager: room not found",
  );
  assert.equal(
    (failures[0] as { code?: unknown }).code,
    "room_consumer_not_ready",
  );
});

test("refusal messages state that nothing was charged", () => {
  for (const reason of ["not_enrolled", "not_authorized", "offline"] as const) {
    assert.match(
      roomConsumerUnavailableMessage(reason),
      /no credit was charged/,
    );
  }
  assert.equal(
    roomConsumerUnavailableCode("not_enrolled"),
    "room_consumer_unavailable",
  );
  assert.equal(
    roomConsumerUnavailableCode("not_authorized"),
    "room_consumer_unavailable",
  );
});
