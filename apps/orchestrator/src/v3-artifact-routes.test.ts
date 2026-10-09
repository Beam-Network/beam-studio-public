import assert from "node:assert/strict";
import { test } from "node:test";
import { frozenV3RoutedInputsPg } from "./postgresOrchestration.js";

test("V3 output publication uses the object channel rather than the command channel", async () => {
  type Args = Parameters<typeof frozenV3RoutedInputsPg>;
  const step = {
    id: "seed",
    executionTarget: {
      kind: "room-member",
      channelId: "request-reply",
      artifactChannelId: "objects",
    },
  } as Args[2];
  const invoke = () => frozenV3RoutedInputsPg(
    { query() { throw new Error("unexpected database access"); } } as unknown as Args[0],
    { id: "run", execution_context_json: { room: { roomId: "room" } } },
    step,
    { stepId: "seed", partitionId: "participants", placement: "room-member",
      inputs: [], outputs: [{ name: "batch", kind: "artifact",
        cardinality: "one", format: "application/octet-stream" }] },
    [
      { stepId: "seed", memberId: "alice", index: 0,
        placement: "room-member" },
      { stepId: "transform", memberId: "bob", index: 0,
        placement: "room-member" },
    ],
    [{ from: { stepId: "seed", memberId: "alice", port: "batch" },
      to: { stepId: "transform", memberId: "bob", port: "batch" } }],
    new Map(),
    {} as Args[7],
    {},
  );
  const result = await invoke();
  const route = result?.metadata["member:alice"]?.v3OutputRoutes as
    | { batch: { channelId: string; targetMemberIds: string[];
        availability: string } }
    | undefined;
  assert.equal(route?.batch.channelId, "objects");
  assert.deepEqual(
    route?.batch.targetMemberIds,
    ["bob"],
  );
  assert.equal(route?.batch.availability, "temporary");
  if (step.executionTarget?.kind !== "room-member")
    throw new Error("Expected a room member target.");
  step.executionTarget.artifactChannelId = undefined;
  await assert.rejects(invoke(), /V3 artifact outputs require an object channel/);
});

test("terminal V3 artifact output gets a bounded local publication", async () => {
  type Args = Parameters<typeof frozenV3RoutedInputsPg>;
  const step = { id: "reduce", executionTarget: {
    kind: "room-member", channelId: "request-reply",
    artifactChannelId: "objects",
  } } as Args[2];
  const invoke = () => frozenV3RoutedInputsPg(
    { query() { throw new Error("unexpected database access"); } } as unknown as Args[0],
    { id: "run", execution_context_json: { room: { roomId: "room" } } },
    step,
    { stepId: "reduce", partitionId: "participants", placement: "room-member",
      inputs: [], outputs: [
        { name: "counts", kind: "artifact", cardinality: "one",
          format: "application/json" },
        { name: "summary", kind: "json", cardinality: "one" },
      ] },
    [{ stepId: "reduce", memberId: "alice", index: 0,
      placement: "room-member" }],
    [], new Map(), {} as Args[7], {},
  );
  const result = await invoke();
  const routes = result?.metadata["member:alice"]?.v3OutputRoutes as
    | Record<string, { channelId: string; targetMemberIds: string[];
        retentionObligationId: string; availability: string;
        requiredUntil: string }>
    | undefined;
  assert.deepEqual(Object.keys(routes ?? {}), ["counts"]);
  assert.equal(routes?.counts?.channelId, "objects");
  assert.deepEqual(routes?.counts?.targetMemberIds, []);
  assert.equal(routes?.counts?.availability, "temporary");
  assert.match(routes?.counts?.retentionObligationId ?? "", /^v3-[a-f0-9]{64}$/);
  assert.ok(Date.parse(routes?.counts?.requiredUntil ?? "") > Date.now());
  if (step.executionTarget?.kind !== "room-member")
    throw new Error("Expected a room member target.");
  step.executionTarget.artifactChannelId = undefined;
  await assert.rejects(invoke(), /V3 artifact outputs require an object channel/);
});

test("a ring step publishes carried and terminal artifact ports separately", async () => {
  type Args = Parameters<typeof frozenV3RoutedInputsPg>;
  const result = await frozenV3RoutedInputsPg(
    { query() { throw new Error("unexpected database access"); } } as unknown as Args[0],
    { id: "run", execution_context_json: { room: { roomId: "room" } } },
    { id: "transform", executionTarget: {
      kind: "room-member", artifactChannelId: "objects",
    } } as Args[2],
    { stepId: "transform", partitionId: "participants",
      placement: "room-member", inputs: [], outputs: [
        { name: "batch", kind: "artifact", cardinality: "one",
          format: "application/octet-stream" },
        { name: "counts", kind: "artifact", cardinality: "one",
          format: "application/json" },
      ] },
    ["alice", "bob"].map((memberId, index) => ({
      stepId: "transform", memberId, index, placement: "room-member",
    })),
    [], new Map(), {} as Args[7], {},
    { incoming: [], outgoing: [{
      from: { stepId: "transform", memberId: "alice", port: "batch" },
      to: { stepId: "transform", memberId: "bob", port: "batch" },
    }], scopeId: "run:ring:final", iteration: 2 },
  );
  const alice = result?.metadata["member:alice"]?.v3OutputRoutes as
    Record<string, { targetMemberIds: string[]; retentionObligationId: string }>;
  const bob = result?.metadata["member:bob"]?.v3OutputRoutes as
    Record<string, { targetMemberIds: string[]; retentionObligationId: string }>;
  assert.deepEqual(alice.batch!.targetMemberIds, ["bob"]);
  assert.deepEqual(alice.counts!.targetMemberIds, []);
  assert.deepEqual(bob.batch!.targetMemberIds, []);
  assert.notEqual(alice.batch!.retentionObligationId,
    alice.counts!.retentionObligationId);
});
