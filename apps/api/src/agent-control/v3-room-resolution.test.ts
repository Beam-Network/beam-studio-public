import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { FrozenWorkflowDefinition, PgClient } from "@beam-studio/db";
import { isRuntimeArtifactMethod, sandboxRpcMethodsForAction } from "@beam-studio/action-runtime";
import {
  roomActionContentType,
  roomActionMinimumChannelPayloadBytes,
} from "@beam-studio/shared";
import {
  assertProtectedRoomChannel,
  assertV3ArtifactRouteChannels,
  assertV3LaunchReady,
  assertV3LaunchShape,
  resolveV3Members,
} from "./v3-room-resolution.js";

test("V3 artifact routes require an object channel and exact member grants", () => {
  const members = ["alice", "bob"];
  const batch = {
    name: "batch", kind: "artifact", cardinality: "one",
    format: "application/octet-stream",
  } as const;
  const graph = {
    version: "workflow-graph/v3" as const,
    controls: [],
    edges: [{ from: "map", to: "consume" }],
    distribution: {
      partitions: [{ id: "participants", members: {
        kind: "explicit" as const, memberIds: members,
      }, order: "declared" as const }],
      steps: [
        { stepId: "map", partitionId: "participants",
          placement: "room-member" as const, inputs: [], outputs: [batch] },
        { stepId: "consume", partitionId: "participants",
          placement: "room-member" as const, inputs: [batch], outputs: [] },
      ],
      routes: [{ from: { stepId: "map", port: "batch" },
        to: { stepId: "consume", port: "batch" },
        association: { kind: "identity" as const } }],
    },
  };
  const steps = [
    { id: "map", enabled: true, executionTarget: {
      kind: "room-member", artifactChannelId: "objects",
    } },
    { id: "consume", enabled: true },
  ];
  const snapshot = {
    memberships: members.map((member_id) => ({ member_id, state: "active" })),
    channels: [{ channel_id: "objects", kind: "object", state: "active",
      rotation_required: false }],
    grants: members.flatMap((subject_id) => [
      { channel_id: "objects", subject_type: "member", subject_id,
        actions: ["publish", "subscribe"], state: "active" },
    ]),
  };
  const input = { graph, steps, snapshot, roomId: "room",
    membersByPartition: { participants: members.map((memberId) => ({ memberId })) } };
  assert.doesNotThrow(() => assertV3ArtifactRouteChannels(input));
  delete (steps[0]!.executionTarget as { artifactChannelId?: string }).artifactChannelId;
  assert.throws(() => assertV3ArtifactRouteChannels(input),
    /v3_artifact_channel_required/);
  steps[0]!.executionTarget!.artifactChannelId = "objects";
  snapshot.channels[0]!.kind = "request-reply";
  assert.throws(() => assertV3ArtifactRouteChannels(input),
    /v3_artifact_channel_unavailable/);
  snapshot.channels[0]!.kind = "object";
  snapshot.grants[1]!.state = "revoked";
  assert.throws(() => assertV3ArtifactRouteChannels(input),
    /v3_artifact_channel_unauthorized/);
});

test("terminal V3 artifact outputs require a source publication grant", () => {
  const input = {
    graph: {
      version: "workflow-graph/v3" as const, controls: [], edges: [],
      distribution: {
        partitions: [{ id: "participants", members: {
          kind: "explicit" as const, memberIds: ["alice"],
        }, order: "declared" as const }],
        steps: [{ stepId: "reduce", partitionId: "participants",
          placement: "room-member" as const, inputs: [],
          outputs: [{ name: "counts", kind: "artifact" as const,
            cardinality: "one" as const, format: "application/json" }] }],
        routes: [],
      },
    },
    steps: [{ id: "reduce", enabled: true, executionTarget: {
      kind: "room-member", artifactChannelId: "objects",
    } }],
    snapshot: {
      memberships: [{ member_id: "alice", state: "active" }],
      channels: [{ channel_id: "objects", kind: "object", state: "active" }],
      grants: [{ channel_id: "objects", subject_type: "member",
        subject_id: "alice", actions: ["publish"], state: "active" }],
    },
    roomId: "room",
    membersByPartition: { participants: [{ memberId: "alice" }] },
  };
  assert.doesNotThrow(() => assertV3ArtifactRouteChannels(input));
  input.snapshot.grants[0]!.actions = ["subscribe"];
  assert.throws(() => assertV3ArtifactRouteChannels(input),
    /v3_artifact_channel_unauthorized/);
  input.snapshot.grants[0]!.actions = ["publish"];
  input.steps[0]!.executionTarget.artifactChannelId = "";
  assert.throws(() => assertV3ArtifactRouteChannels(input),
    /v3_artifact_channel_required/);
});

test("V3 loop carry checks the transform artifact channel", () => {
  const members = ["alice", "bob"];
  const batch = { name: "batch", kind: "artifact", cardinality: "one",
    format: "application/octet-stream" } as const;
  const graph = {
    version: "workflow-graph/v3" as const,
    controls: [{ id: "ring", kind: "loop", iterations: 2,
      body: { stepIds: ["transform"], entryStepId: "transform",
        outputStepId: "transform", edges: [] },
      initial: { routes: [{ from: { stepId: "seed", port: "batch" },
        to: { stepId: "transform", port: "batch" }, association: "identity" }] },
      carry: { routes: [{ from: { stepId: "transform", port: "batch" },
        to: { stepId: "transform", port: "batch" },
        association: "ring-successor" }] } }],
    edges: [],
    distribution: {
      partitions: [{ id: "participants", members: {
        kind: "explicit", memberIds: members,
      }, order: "declared" }],
      steps: [
        { stepId: "seed", partitionId: "participants",
          placement: "room-member", inputs: [], outputs: [batch] },
        { stepId: "transform", partitionId: "participants",
          placement: "room-member", inputs: [batch,
            { name: "source", kind: "member-id", cardinality: "one" },
            { name: "recipients", kind: "member-id-list", cardinality: "many" }],
          outputs: [batch], transfer: { topology: "ring",
            sourceInput: "source", recipientsInput: "recipients" } },
      ],
      routes: [],
    },
  } as Parameters<typeof assertV3ArtifactRouteChannels>[0]["graph"];
  const steps = ["seed", "transform"].map((id) => ({ id, enabled: true,
    executionTarget: { kind: "room-member", artifactChannelId: "objects" } }));
  const snapshot = {
    memberships: members.map((member_id) => ({ member_id, state: "active" })),
    channels: [{ channel_id: "objects", kind: "object", state: "active" }],
    grants: members.map((subject_id) => ({ channel_id: "objects",
      subject_type: "member", subject_id, actions: ["publish", "subscribe"] })),
  };
  const input = { graph, steps, snapshot, roomId: "room",
    membersByPartition: { participants: members.map((memberId) => ({ memberId })) } };
  assert.doesNotThrow(() => assertV3ArtifactRouteChannels(input));
  delete (steps[1]!.executionTarget as { artifactChannelId?: string }).artifactChannelId;
  assert.throws(() => assertV3ArtifactRouteChannels(input),
    /v3_artifact_channel_required/);
});

const definition = {
  organizationId: "org",
  snapshot: {
    graphVersion: "workflow-graph/v3",
    controls: [],
    edges: [],
    decisions: [],
    distribution: {
      partitions: [],
      steps: [{ stepId: "step", placement: "room-member" }],
      routes: [],
    },
  },
  resolvedSteps: [{ id: "step", enabled: true, kind: "action" }],
} as unknown as FrozenWorkflowDefinition;
const distribution = definition.snapshot.distribution as Record<string, unknown>;

test("V3 launch rejects unsupported graph shapes before reading room state", async () => {
  const client = {
    query() {
      throw new Error("room query reached");
    },
  } as unknown as PgClient;
  const controller = {
    configured() {
      throw new Error("controller reached");
    },
  } as unknown as Parameters<typeof assertV3LaunchReady>[2];
  for (const changed of [
    { ...definition, snapshot: { ...definition.snapshot, controls: [{}] } },
    { ...definition, snapshot: { ...definition.snapshot, controls: [
      { id: "loop", kind: "loop", iterations: "${input.count}",
        body: { stepIds: ["step"] } },
    ] } },
    { ...definition, snapshot: { ...definition.snapshot, controls: [
      { id: "loop", kind: "loop", iterations: 1_001,
        body: { stepIds: ["step"] } },
    ] } },
    { ...definition, snapshot: { ...definition.snapshot, controls: [
      { id: "loop", kind: "loop", iterations: 5,
        body: { stepIds: ["other"] } },
    ] } },
    { ...definition, snapshot: { ...definition.snapshot, decisions: [{}] } },
    { ...definition, resolvedSteps: [
      ...definition.resolvedSteps,
      { id: "unplanned", enabled: true, kind: "action" },
    ] },
    { ...definition, resolvedSteps: [{ id: "step", enabled: true, kind: "workflow" }] },
    { ...definition, snapshot: {
      ...definition.snapshot,
      distribution: {
        ...distribution,
        steps: [{ stepId: "step", placement: "studio" }],
      },
    } },
  ]) {
    await assert.rejects(
      assertV3LaunchReady(client, changed as FrozenWorkflowDefinition, controller),
      /v3_launch_shape_unsupported/,
    );
  }
});

test("V3 launch shape admits one literal bounded loop over the distributed steps", () => {
  const loop = {
    id: "loop", kind: "loop", iterations: 5,
    body: { stepIds: ["step"] },
    initial: { routes: [{
      from: { stepId: "seed", port: "batch" },
      to: { stepId: "step", port: "batch" },
      association: "identity",
    }] },
  };
  const seeded = {
    ...definition,
    snapshot: {
      ...definition.snapshot,
      controls: [loop],
      distribution: {
        ...distribution,
        steps: [
          { stepId: "seed", placement: "room-member" },
          { stepId: "step", placement: "room-member" },
        ],
      },
    },
    resolvedSteps: [
      { id: "seed", enabled: true, kind: "action" },
      { id: "step", enabled: true, kind: "action" },
    ],
  } as FrozenWorkflowDefinition;
  assert.doesNotThrow(() => assertV3LaunchShape(seeded));
  assert.throws(() => assertV3LaunchShape({
    ...seeded,
    snapshot: { ...seeded.snapshot, controls: [loop, loop] },
  } as FrozenWorkflowDefinition), /v3_launch_shape_unsupported/);
  assert.throws(() => assertV3LaunchShape({
    ...seeded,
    snapshot: { ...seeded.snapshot, controls: [
      { id: "fan", kind: "fan-out", items: [1], body: loop.body },
    ] },
  } as FrozenWorkflowDefinition), /v3_launch_shape_unsupported/);
  assert.throws(() => assertV3LaunchShape({
    ...seeded,
    snapshot: { ...seeded.snapshot, controls: [{ ...loop, initial: undefined }] },
  } as FrozenWorkflowDefinition), /v3_launch_shape_unsupported/);
  assert.throws(() => assertV3LaunchShape({
    ...definition,
    resolvedSteps: [{ id: "step", enabled: true, kind: "action",
      executionTarget: { kind: "studio" },
      manifestSnapshot: { apiVersion: "workflow-actions/v2" } }],
    snapshot: {
      ...definition.snapshot,
      distribution: { ...distribution, steps: [
        { stepId: "step", placement: "studio", transfer: {
          topology: "ring", sourceInput: "sender", recipientsInput: "recipients",
        } },
      ] },
    },
  } as FrozenWorkflowDefinition), /v3_launch_shape_unsupported/);
});

test("pairwise action channel reserves ciphertext headroom", () => {
  const controller = {
    configured() {
      return {
        binding: { agentId: "controller_agent", memberId: "controller" },
        controlChannelId: "private",
      };
    },
  } as unknown as Parameters<typeof assertProtectedRoomChannel>[6];
  const snapshot = {
    room: { owner_member_id: "controller" },
    memberships: [
      { member_id: "controller", agent_id: "controller_agent", state: "active" },
      { member_id: "executor", agent_id: "executor_agent", state: "active" },
    ],
    channels: [
      {
        channel_id: "private", kind: "message", state: "active",
        visibility: "restricted",
        content_type: roomActionContentType,
        limits: { max_payload_bytes: roomActionMinimumChannelPayloadBytes },
      },
      { channel_id: "request", kind: "request-reply", state: "active" },
    ],
    grants: [
      { channel_id: "private", subject_type: "member", subject_id: "controller", state: "active", actions: ["discover", "publish", "subscribe", "manage"] },
      { channel_id: "private", subject_type: "member", subject_id: "executor", state: "active", actions: ["discover", "publish", "subscribe"] },
      { channel_id: "request", subject_type: "member", subject_id: "controller", actions: ["request"] },
      { channel_id: "request", subject_type: "member", subject_id: "executor", actions: ["respond"] },
    ],
  };
  assert.doesNotThrow(() => assertProtectedRoomChannel(
    snapshot, "org", "room", "controller", "executor", "request", controller,
  ));
  snapshot.channels[0]!.limits!.max_payload_bytes--;
  assert.throws(() => assertProtectedRoomChannel(
    snapshot, "org", "room", "controller", "executor", "request", controller,
  ), /v3_private_channel_unauthorized/);
});

test("V3 resolves Registry v2 members only with live verified runtime support", async () => {
  const manifest = JSON.parse(readFileSync(new URL(
    "../../../../packages/core/src/workflows/fixtures/registry-v2/v2-single.valid.json",
    import.meta.url,
  ), "utf8"));
  const now = new Date();
  const agent = {
    id: "agent", status: "online", heartbeat_at: now,
    capabilities_json: ["action-execution/v1"],
    action_execution_json: {
      protocol: "action-execution/v1",
      artifactPorts: "action-artifact-ports/v1",
      processOwnership: "action-process-ownership/v1",
      runtimes: [{ name: "node", version: "22.20.0" }],
      isolations: ["sandboxed-esm"],
      hostOperations: sandboxRpcMethodsForAction(manifest).filter(
        (method) => !isRuntimeArtifactMethod(method)),
      permissions: ["storage:read", "storage:write"],
      allowedActions: [manifest.name], capacity: 1,
      maxLeaseSeconds: 60, maxArtifactBytes: 128 * 1024,
    },
    policy_json: {},
  };
  const client = {
    async query() { return { rows: [agent] }; },
  } as unknown as PgClient;
  const snapshot = {
    room: { owner_member_id: "controller" },
    memberships: [
      { member_id: "controller", agent_id: "controller-agent", kind: "agent", state: "active" },
      { member_id: "executor", agent_id: "agent", kind: "agent", state: "active" },
    ],
    channels: [
      { channel_id: "request", kind: "request-reply", state: "active" },
      { channel_id: "objects", kind: "object", state: "active" },
      { channel_id: "private", kind: "message", state: "active",
        visibility: "restricted",
        content_type: roomActionContentType,
        limits: { max_payload_bytes: roomActionMinimumChannelPayloadBytes } },
    ],
    grants: [
      { channel_id: "request", subject_type: "member", subject_id: "controller", actions: ["request"] },
      { channel_id: "request", subject_type: "member", subject_id: "executor", actions: ["respond"] },
      { channel_id: "private", subject_type: "member", subject_id: "controller", state: "active", actions: ["discover", "publish", "subscribe", "manage"] },
      { channel_id: "private", subject_type: "member", subject_id: "executor", state: "active", actions: ["discover", "publish", "subscribe"] },
      { channel_id: "objects", subject_type: "member", subject_id: "executor", actions: ["publish"] },
    ],
  };
  const input = {
    organizationId: "org", roomId: "room", snapshot,
    graph: {
      version: "workflow-graph/v3" as const,
      controls: [], edges: [],
      distribution: {
        partitions: [{ id: "partition", members: { kind: "explicit" as const,
          memberIds: ["executor"] }, order: "declared" as const }],
        steps: [{ stepId: "step", partitionId: "partition",
          placement: "room-member" as const,
          inputs: [{ name: "source", kind: "artifact" as const,
            cardinality: "one" as const, format: "application/json" }],
          outputs: [{ name: "result", kind: "artifact" as const,
            cardinality: "one" as const, format: "application/json" }] }],
        routes: [],
      },
    },
    steps: [{ id: "step", enabled: true, kind: "action",
      executionTarget: { kind: "room-member", memberIds: ["executor"],
        channelId: "request", artifactChannelId: "objects",
        requesterMemberId: "controller" },
      manifestSnapshot: manifest }],
  };
  const controller = { configured() { return {
    binding: { agentId: "controller-agent", memberId: "controller" },
    controlChannelId: "private",
  }; } } as unknown as Parameters<typeof resolveV3Members>[2];
  const wrongPort = structuredClone(input);
  wrongPort.graph.distribution.steps[0]!.outputs[0]!.format = "text/plain";
  await assert.rejects(resolveV3Members(client, wrongPort, controller),
    /v3_registry_contract_invalid/);
  const wrongPlacement = structuredClone(input);
  Object.assign(wrongPlacement.steps[0]!, { resolvedPlacement: "local-workers" });
  await assert.rejects(resolveV3Members(client, wrongPlacement, controller),
    /v3_launch_shape_unsupported/);
  await assert.rejects(resolveV3Members(client, input, controller),
    /v3_registry_executor_unavailable/);
  agent.action_execution_json = {
    ...agent.action_execution_json,
    manifestApiVersions: ["workflow-actions/v2"],
  } as typeof agent.action_execution_json;
  assert.deepEqual((await resolveV3Members(client, input, controller))
    .membersByPartition.partition, [{ memberId: "executor" }]);
  const transfer = structuredClone(input);
  transfer.graph.distribution.steps[0] = {
    ...transfer.graph.distribution.steps[0]!,
    inputs: [
      ...transfer.graph.distribution.steps[0]!.inputs,
      { name: "sender", kind: "member-id", cardinality: "one" },
      { name: "recipients", kind: "member-id-list", cardinality: "many" },
    ],
    transfer: {
      topology: "ring", sourceInput: "sender", recipientsInput: "recipients",
    },
  } as typeof transfer.graph.distribution.steps[number];
  await assert.rejects(resolveV3Members(client, transfer, controller),
    /needs at least two members/);
  agent.heartbeat_at = new Date(0);
  await assert.rejects(resolveV3Members(client, input, controller),
    /v3_registry_executor_unavailable/);
});
