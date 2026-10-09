import assert from "node:assert/strict";
import test from "node:test";
import { sortAgentsForInventory } from "./agent-inventory.ts";

test("heartbeat updates and API reordering do not move agent rows", () => {
  const agents = [
    { id: "a10", machineName: "room-member-10", status: "online" },
    { id: "a2", machineName: "room-member-2", status: "offline" },
    { id: "a1", machineName: "room-member-1", status: "online" },
  ];
  const nextRefresh = [...agents].reverse().map((agent) => ({
    ...agent,
    heartbeatAt: "2026-09-12T10:00:00Z",
    updatedAt: "2026-09-12T10:00:00Z",
  }));

  assert.deepEqual(
    sortAgentsForInventory(agents).map(({ id }) => id),
    ["a1", "a10", "a2"],
  );
  assert.deepEqual(
    sortAgentsForInventory(nextRefresh).map(({ id }) => id),
    ["a1", "a10", "a2"],
  );
  assert.deepEqual(
    agents.map(({ id }) => id),
    ["a10", "a2", "a1"],
  );
});

test("duplicate names have the same order regardless of API order", () => {
  const agents = [
    { id: "agent-b", machineName: "Production" },
    { id: "agent-a", machineName: "production" },
  ];
  assert.deepEqual(
    sortAgentsForInventory(agents).map(({ id }) => id),
    ["agent-a", "agent-b"],
  );
  assert.deepEqual(
    sortAgentsForInventory([...agents].reverse()),
    sortAgentsForInventory(agents),
  );
});

test("sort uses the displayed identity when machine names are missing", () => {
  const agents = Object.freeze([
    { id: "z", machineName: "Alpha", name: "Zulu" },
    { id: "Charlie", machineName: null, name: null },
    { id: "a", machineName: "", name: "Bravo" },
  ]);
  assert.deepEqual(
    sortAgentsForInventory(agents).map(({ id }) => id),
    ["a", "Charlie", "z"],
  );
  assert.deepEqual(sortAgentsForInventory([]), []);
});

test("online agents come first and each group is sorted by name", () => {
  const agents = [
    { id: "offline-b", name: "Bravo", status: "offline" },
    { id: "online-z", name: "Zulu", status: "online" },
    { id: "revoked-a", name: "Alpha", status: "revoked" },
    { id: "online-c", name: "Charlie", status: "online" },
  ];
  assert.deepEqual(
    sortAgentsForInventory(agents).map(({ id }) => id),
    ["online-c", "online-z", "revoked-a", "offline-b"],
  );

  const reconnected = agents.map((agent) =>
    agent.id === "offline-b" ? { ...agent, status: "online" } : agent,
  );
  assert.deepEqual(
    sortAgentsForInventory(reconnected).map(({ id }) => id),
    ["offline-b", "online-c", "online-z", "revoked-a"],
  );
});
