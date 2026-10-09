import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { eligibleRoomMemberExecutors } from "./action-executors.js";

function fixture() {
  return {
    target: {
      kind: "room-member" as const,
      memberIds: ["executor"],
      requesterMemberId: "requester",
      channelId: "channel",
    },
    roomId: "room",
    now: 100_000,
    snapshot: {
      room: { room_id: "room", state: "active" },
      memberships: [
        {
          member_id: "executor",
          room_id: "room",
          kind: "agent",
          agent_id: "agent",
          state: "active",
        },
        {
          member_id: "requester",
          room_id: "room",
          kind: "agent",
          agent_id: "requesting-agent",
          state: "active",
        },
      ],
      channels: [
        {
          channel_id: "channel",
          room_id: "room",
          kind: "request-reply",
          state: "active",
        },
      ],
      grants: [
        {
          channel_id: "channel",
          room_id: "room",
          subject_type: "member",
          subject_id: "executor",
          actions: ["respond"],
          state: "active",
        },
        {
          channel_id: "channel",
          room_id: "room",
          subject_type: "member",
          subject_id: "requester",
          actions: ["request"],
          state: "active",
        },
      ],
    },
    agents: [
      {
        id: "agent",
        status: "online",
        heartbeat_at: new Date(100_000),
        capabilities_json: ["action-execution/v1"],
        action_execution_json: {
          protocol: "action-execution/v1",
          processOwnership: "action-process-ownership/v1",
          runtimes: [{ name: "node", version: "22.20.0" }],
          isolations: ["sandboxed-esm"],
          hostOperations: ["state.patch"],
          permissions: ["storage:read"],
          allowedActions: ["@test/transform"],
          capacity: 2,
          maxLeaseSeconds: 60,
          maxArtifactBytes: 128 * 1024,
        },
        policy_json: {},
      },
    ] as Record<string, any>[],
    manifest: {
      apiVersion: "workflow-actions/v1" as const,
      name: "@test/transform",
      version: "1.0.0",
      runtime: { placements: ["room-members" as const] },
      execution: {
        runtime: "node" as const,
        isolation: "sandboxed-esm" as const,
      },
      permissions: ["storage:read" as const],
      inputs: {},
      outputs: {},
    },
    requiredHostOperations: ["state.patch"],
  };
}

test("room executor placement requires an active capable managed member and independent request/respond grants", () => {
  const input = fixture();
  const result = eligibleRoomMemberExecutors(input);
  assert.equal(result.eligible.length, 1);
  assert.deepEqual(result.rejected, []);
  input.snapshot.grants[0]!.state = "revoked";
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_respond_permission_denied",
  );
  input.snapshot.grants[1]!.state = "revoked";
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_request_permission_denied",
  );
});
test("membership, storage capability and advertised but incompatible runtimes never qualify", () => {
  const input = fixture();
  input.agents[0]!.capabilities_json = [
    "room-transfers",
    "room-storage-publish",
  ];
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_not_opted_in",
  );
  input.agents[0]!.capabilities_json = ["action-execution/v1"];
  input.agents[0]!.action_execution_json.runtimes[0].version = "20.0.0";
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_runtime_incompatible",
  );
  input.agents[0]!.action_execution_json.runtimes[0].version = "22.20.0";
  input.agents[0]!.action_execution_json.hostOperations = [];
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_host_capability_denied",
  );
});
test("organization policy only restricts local action allowlist and capacity", () => {
  const input = fixture();
  input.agents[0]!.policy_json = {
    action_execution: {
      allowed_actions: ["@test/transform", "@extra/action"],
      capacity: 64,
    },
  };
  const result = eligibleRoomMemberExecutors(input);
  assert.equal(result.eligible[0]?.capabilities.capacity, 2);
  assert.deepEqual(result.eligible[0]?.capabilities.allowedActions, [
    "@test/transform",
  ]);
  input.agents[0]!.policy_json = { action_execution: { allowed_actions: [] } };
  assert.equal(eligibleRoomMemberExecutors(input).eligible.length, 0);
});
test("artifact-port actions require an installed compatible member runtime", () => {
  const input = fixture();
  input.manifest.outputs = { result: { type: "artifact", required: true } };
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_artifact_ports_unavailable",
  );
  input.agents[0]!.action_execution_json.artifactPorts =
    "action-artifact-ports/v1";
  assert.equal(eligibleRoomMemberExecutors(input).eligible.length, 1);
  input.agents[0]!.policy_json = {
    action_execution: { max_artifact_bytes: 0 },
  };
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_artifact_storage_denied",
  );
});
test("Registry v2 placement requires exact runtime advertisement and compatible limits", () => {
  const input = fixture();
  input.manifest = JSON.parse(
    readFileSync(
      new URL(
        "../../../../packages/core/src/workflows/fixtures/registry-v2/v2-single.valid.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  input.agents[0]!.action_execution_json.allowedActions = [input.manifest.name];
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_artifact_ports_unavailable",
  );
  input.agents[0]!.action_execution_json.artifactPorts =
    "action-artifact-ports/v1";
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_manifest_v2_unavailable",
  );
  input.agents[0]!.action_execution_json.manifestApiVersions = [
    "workflow-actions/v2",
  ];
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_host_capability_denied",
  );
  input.agents[0]!.action_execution_json.permissions = [
    "storage:read", "storage:write",
  ];
  input.agents[0]!.action_execution_json.hostOperations = [
    "state.patch", "storage.getJson", "storage.putJson",
  ];
  input.requiredHostOperations = [];
  assert.equal(eligibleRoomMemberExecutors(input).eligible.length, 1);
  const registry = input.manifest as typeof input.manifest & {
    runtime: { minStudioVersion?: string };
    contracts: { resources: { cpuMillis: number }; recovery: { retry: string } };
    execution: { requiredCapabilities: string[] };
  };
  registry.runtime.minStudioVersion = "1.0.0";
  assert.equal(eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_manifest_v2_unavailable");
  delete registry.runtime.minStudioVersion;
  registry.contracts.resources.cpuMillis = 999;
  assert.equal(eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_manifest_v2_unavailable");
  registry.contracts.resources.cpuMillis = 1_000;
  registry.contracts.recovery.retry = "never";
  assert.equal(eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_manifest_v2_unavailable");
  registry.contracts.recovery.retry = "idempotent";
  registry.execution.requiredCapabilities.push("host:beam.rooms.create");
  assert.equal(eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_host_capability_denied");
  registry.execution.requiredCapabilities.pop();
  input.agents[0]!.action_execution_json.maxLeaseSeconds = 30;
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_runtime_incompatible",
  );
  input.agents[0]!.action_execution_json.maxLeaseSeconds = 60;
  input.agents[0]!.action_execution_json.runtimes[0].version = "21.99.0";
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_runtime_incompatible",
  );
});
test("trusted Registry v2 requires frozen first-party public Registry provenance", () => {
  const input = fixture();
  input.manifest = JSON.parse(readFileSync(new URL(
    "../../../../packages/core/src/workflows/fixtures/registry-v2/v2-single.valid.json",
    import.meta.url,
  ), "utf8"));
  const registry = input.manifest as unknown as {
    name: string;
    trustLevel: string;
    execution: { isolation: string };
  };
  registry.name = "@beam/normalize";
  registry.trustLevel = "verified";
  registry.execution.isolation = "trusted-node";
  input.agents[0]!.action_execution_json = {
    ...input.agents[0]!.action_execution_json,
    artifactPorts: "action-artifact-ports/v1",
    manifestApiVersions: ["workflow-actions/v2"],
    isolations: ["trusted-node"],
    hostOperations: ["storage.getJson", "storage.putJson"],
    permissions: ["storage:read", "storage:write"],
    allowedActions: [registry.name],
  };
  input.requiredHostOperations = [];
  assert.equal(eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_manifest_v2_unavailable");
  assert.equal(eligibleRoomMemberExecutors({
    ...input, sourceRegistry: "local-registry",
  }).rejected[0]?.code, "executor_manifest_v2_unavailable");
  assert.equal(eligibleRoomMemberExecutors({
    ...input, sourceRegistry: "public-registry",
  }).eligible.length, 1);
});
test("offline members and storage resources report availability separately from execution permission", () => {
  const input = fixture();
  input.agents[0]!.heartbeat_at = new Date(0);
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_offline",
  );
  input.snapshot.memberships[0]!.kind = "storage";
  assert.equal(
    eligibleRoomMemberExecutors(input).rejected[0]?.code,
    "executor_membership_unavailable",
  );
});
