import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoomConsumer, selectRoomConsumer } from "./room-consumer.js";

const agent = (
  id: string,
  status = "online",
  capabilities = ["studio-room-consumer"],
) => ({ id, status, capabilities });

test("selection uses successful coordinator identities, not global online ordering", () => {
  const agents = [
    agent("dev"),
    agent("revoked", "revoked"),
    agent("normal", "online", ["rooms"]),
    agent("prod-offline", "offline"),
    agent("prod"),
  ];
  assert.equal(
    selectRoomConsumer(
      agents,
      new Set(["prod-offline", "prod", "revoked", "normal"]),
    ).consumer?.id,
    "prod",
  );
  assert.deepEqual(selectRoomConsumer(agents, new Set()), {
    consumer: null,
    reason: "not_authorized",
  });
  assert.deepEqual(
    selectRoomConsumer(
      [agent("normal", "online", ["rooms"])],
      new Set(["normal"]),
    ),
    {
      consumer: null,
      reason: "not_enrolled",
    },
  );
});

test("offline consumers are never selected, even when they are the only authorized ones", () => {
  const agents = [
    agent("prod-offline", "offline"),
    agent("prod-stale", "stale"),
    agent("dev"),
  ];
  assert.deepEqual(
    selectRoomConsumer(agents, new Set(["prod-offline", "prod-stale"])),
    { consumer: null, reason: "offline" },
  );
  assert.deepEqual(
    selectRoomConsumer([agent("only", "offline")], new Set(["only"])),
    {
      consumer: null,
      reason: "offline",
    },
  );
  assert.equal(
    selectRoomConsumer(
      [agent("prod-offline", "offline"), agent("prod")],
      new Set(["prod-offline", "prod"]),
    ).consumer?.id,
    "prod",
  );
});

test("creation accepts an authorized empty inventory; foreign and unavailable consumers fail closed", async () => {
  const probed: string[] = [];
  const result = await resolveRoomConsumer(
    [agent("dev"), agent("down"), agent("prod"), agent("revoked", "revoked")],
    async (id) => {
      probed.push(id);
      if (id !== "prod")
        throw new Error(id === "dev" ? "permission denied" : "unavailable");
      return { rooms: [] };
    },
  );
  assert.equal(result.consumer?.id, "prod");
  assert.deepEqual(probed.sort(), ["dev", "down", "prod"]);
  assert.deepEqual(
    await resolveRoomConsumer([agent("dev")], async () => {
      throw new Error("denied");
    }),
    { consumer: null, reason: "not_authorized" },
  );
});

test("resolution reports an authorized but offline consumer as offline", async () => {
  assert.deepEqual(
    await resolveRoomConsumer(
      [agent("prod", "offline"), agent("dev")],
      async (id) => {
        if (id !== "prod") throw new Error("permission denied");
        return { rooms: [] };
      },
    ),
    { consumer: null, reason: "offline" },
  );
});
