import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilityLabel,
  compactAgentId,
  compactDaemonVersion,
  endpointPermissions,
  isTunnelCapability,
  mergeAgentLogs,
  refreshAfterCommand,
  terminalCommandStates,
} from "./agent-workspace.ts";

test("sidebar identity preserves recognizable ID ends and shortens only long version hashes", () => {
  assert.equal(
    compactAgentId("agt_2c16bf8c9856e07fdefbfbca654e1952"),
    "agt_2c16bf8c…4e1952",
  );
  assert.equal(compactAgentId("agt_short"), "agt_short");
  assert.equal(
    compactDaemonVersion("v0.0.0-dev.cb776a0e0ba312345678"),
    "v0.0.0-dev.cb776a0",
  );
  assert.equal(compactDaemonVersion("v1.2.3"), "v1.2.3");
  assert.equal(compactDaemonVersion("dev"), "dev");
  assert.equal(
    compactDaemonVersion("v1.2.3-rc.2+abcdef0123456789"),
    "v1.2.3-rc.2+abcdef0",
  );
  assert.equal(compactDaemonVersion(null), "Unknown");
});

test("only endpoint changes refresh endpoints and metrics, without refresh loops", () => {
  for (const operation of [
    "tunnel.create",
    "destination.create",
    "endpoint.close",
  ]) {
    assert.deepEqual(refreshAfterCommand(operation), [
      "endpoint.list",
      "metrics.snapshot",
    ]);
  }
  for (const operation of [
    "endpoint.list",
    "metrics.snapshot",
    "logs.subscribe",
  ])
    assert.deepEqual(refreshAfterCommand(operation), []);
  assert.equal(terminalCommandStates.has("running"), false);
  for (const state of ["completed", "failed", "cancelled", "expired"])
    assert.equal(terminalCommandStates.has(state), true);
});

test("endpoint choices honor snake case and camel case Studio restrictions", () => {
  assert.deepEqual(
    endpointPermissions({ tunnel_kinds: ["http"], allow_public: false }).kinds,
    ["http"],
  );
  assert.equal(
    endpointPermissions({ tunnelKinds: ["http"] }).filesAllowed,
    false,
  );
  assert.equal(
    endpointPermissions({ filesystem_roots: [] }).filesAllowed,
    false,
  );
  assert.equal(
    endpointPermissions({ allowPublic: false }).publicAllowed,
    false,
  );
  assert.equal(endpointPermissions({ tunnel_kinds: [] }).kinds.length, 0);
  assert.deepEqual(
    endpointPermissions({ filesystemRoots: ["/srv/beam", 42] }).roots,
    ["/srv/beam"],
  );
  assert.equal(endpointPermissions({}).kinds.length, 5);
});

test("live logs use the gateway log payload and deduplicate snapshots across polls", () => {
  const log = {
    time: "2026-09-12T10:00:00Z",
    level: "INFO",
    message: "Connected",
  };
  const event = { id: "event-1", type: "log", payload: log };
  const first = mergeAgentLogs([], [log], [event]);
  assert.equal(first.length, 1);
  assert.equal(first[0].level, "info");
  const next = mergeAgentLogs(
    first,
    [log],
    [
      event,
      {
        id: "event-2",
        type: "log",
        payload: { ...log, time: "2026-09-12T10:00:01Z", message: "Ready" },
      },
    ],
  );
  assert.equal(next.length, 2);
  assert.equal(next[1].message, "Ready");
  assert.deepEqual(
    mergeAgentLogs(next, null, [
      { id: "bad", type: "log", payload: {} },
      { id: "metrics", type: "metrics", payload: log },
    ]),
    next,
  );
  assert.equal(
    mergeAgentLogs(
      [],
      Array.from({ length: 1500 }, (_, index) => ({
        ...log,
        time: new Date(index * 1000).toISOString(),
      })),
      [],
    ).length,
    1000,
  );
});

test("capabilities use friendly names and preserve readable unknown capabilities", () => {
  assert.equal(capabilityLabel("room-transfers"), "Room file transfers");
  assert.equal(capabilityLabel("future-feature"), "Future feature");
});

test("tunnel runtime capabilities are recognized so they can be hidden", () => {
  for (const capability of ["endpoints", "operations", "tunnels", "bridge"])
    assert.equal(isTunnelCapability(capability), true, capability);
  for (const capability of ["rooms", "room-transfers", "logs", "metrics"])
    assert.equal(isTunnelCapability(capability), false, capability);
});
