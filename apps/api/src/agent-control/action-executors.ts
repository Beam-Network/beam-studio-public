import {
  actionExecutionCapabilitiesSchema,
  type ActionExecutionCapabilities,
  type ActionExecutionTarget,
} from "@beam-studio/shared";
import {
  supportedPlacements,
  validateActionManifest,
  type ActionManifest,
  type ActionManifestV2,
} from "@beam-studio/core";
import {
  actionArtifactPortsRequired,
  artifactPortLimits,
} from "@beam-studio/action-runtime";
import { roomMemberCan } from "./room-workflow-options.js";
import { assertFrozenRoomArtifactPlansAuthorized } from "./room-artifact-authorization.js";

type Row = Record<string, any>;
export const artifactStorageReservationBytes =
  artifactPortLimits.maxTotalBytes * 2;
export type ExecutorRejection = {
  memberId: string;
  agentId?: string;
  code: string;
  message: string;
};

/** Pure placement check; capacity is rechecked under the agent row lock at assignment. */
export function eligibleRoomMemberExecutors(input: {
  target: Extract<ActionExecutionTarget, { kind: "room-member" }>;
  roomId: string;
  snapshot: Row;
  agents: Row[];
  manifest: ActionManifest;
  sourceRegistry?: unknown;
  requiredHostOperations: string[];
  artifactMetadata?: unknown;
  now?: number;
}) {
  const rejected: ExecutorRejection[] = [];
  const eligible: Array<{
    memberId: string;
    agent: Row;
    capabilities: ActionExecutionCapabilities;
  }> = [];
  const channel = ((input.snapshot.channels as Row[]) ?? []).find(
    (value) => value.channel_id === input.target.channelId,
  );
  if (
    !channel ||
    channel.kind !== "request-reply" ||
    channel.state !== "active"
  )
    return {
      eligible,
      rejected: input.target.memberIds.map((memberId) => ({
        memberId,
        code: "executor_request_channel_unavailable",
        message: "Select an active request/reply channel for action execution.",
      })),
    };
  if (
    !roomMemberCan(
      input.snapshot,
      input.roomId,
      input.target.channelId,
      input.target.requesterMemberId,
      "request",
    )
  )
    return {
      eligible,
      rejected: input.target.memberIds.map((memberId) => ({
        memberId,
        code: "executor_request_permission_denied",
        message: "The requesting member has no current request grant.",
      })),
    };
  for (const memberId of [...new Set(input.target.memberIds)]) {
    const member = ((input.snapshot.memberships as Row[]) ?? []).find(
      (value) => value.member_id === memberId,
    );
    const agent = input.agents.find((value) => value.id === member?.agent_id);
    const reject = (code: string, message: string) =>
      rejected.push({ memberId, agentId: agent?.id, code, message });
    if (
      !member ||
      member.state !== "active" ||
      member.kind !== "agent" ||
      !agent ||
      agent.revoked_at
    ) {
      reject(
        "executor_membership_unavailable",
        "The selected member is not an active managed agent.",
      );
      continue;
    }
    if (
      !roomMemberCan(
        input.snapshot,
        input.roomId,
        input.target.channelId,
        memberId,
        "respond",
      )
    ) {
      reject(
        "executor_respond_permission_denied",
        "The selected member has no current respond grant.",
      );
      continue;
    }
    try {
      assertFrozenRoomArtifactPlansAuthorized(
        input.snapshot,
        input.roomId,
        memberId,
        input.artifactMetadata,
      );
    } catch (error) {
      reject(
        (error as { code?: string }).code ??
          "executor_artifact_permission_denied",
        error instanceof Error ? error.message : "Artifact access denied.",
      );
      continue;
    }
    const heartbeat = agent.heartbeat_at
      ? new Date(agent.heartbeat_at).getTime()
      : 0;
    if (
      agent.status !== "online" ||
      heartbeat < (input.now ?? Date.now()) - 45_000
    ) {
      reject(
        "executor_offline",
        "The managed agent has no current authenticated control session.",
      );
      continue;
    }
    if (
      !Array.isArray(agent.capabilities_json) ||
      !agent.capabilities_json.includes("action-execution/v1")
    ) {
      reject(
        "executor_not_opted_in",
        "Room membership and storage capability do not enable action execution.",
      );
      continue;
    }
    const parsed = actionExecutionCapabilitiesSchema.safeParse(
      agent.action_execution_json,
    );
    if (!parsed.success) {
      reject(
        "executor_capabilities_invalid",
        "The agent has not advertised a valid installed action runtime.",
      );
      continue;
    }
    const capabilities = restrictCapabilities(
      parsed.data,
      agent.policy_json?.action_execution,
    );
    if (!capabilities) {
      reject(
        "executor_policy_denied",
        "Organization policy disables this execution capability.",
      );
      continue;
    }
    if (
      actionArtifactPortsRequired(input.manifest) &&
      capabilities.artifactPorts !== "action-artifact-ports/v1"
    ) {
      reject(
        "executor_artifact_ports_unavailable",
        "The member does not advertise artifact port support.",
      );
      continue;
    }
    if (input.manifest.apiVersion === "workflow-actions/v2") {
      try {
        validateActionManifest(input.manifest);
      } catch {
        reject(
          "executor_manifest_v2_unavailable",
          "The frozen Registry v2 manifest is invalid.",
        );
        continue;
      }
      if (!capabilities.manifestApiVersions?.includes("workflow-actions/v2")) {
        reject(
          "executor_manifest_v2_unavailable",
          "The installed runtime does not advertise verified Registry v2 execution.",
        );
        continue;
      }
      const registry = input.manifest as ActionManifestV2;
      const resources = registry.contracts?.resources;
      if (
        registry.runtime.minStudioVersion !== undefined ||
        (registry.execution.isolation === "trusted-node" &&
          input.sourceRegistry !== "public-registry") ||
        !supportedPlacements(registry).includes("room-members") ||
        registry.contracts?.recovery?.retry !== "idempotent" ||
        registry.contracts?.recovery?.externalEffects !== "none" ||
        !resources || resources.cpuMillis < 1_000 ||
        resources.cpuMillis > 2 ** 40 || resources.memoryMiB > 2 ** 20 ||
        resources.maxOutputBytes > (capabilities.maxArtifactBytes ?? 0)
      ) {
        reject(
          "executor_manifest_v2_unavailable",
          "The Registry v2 contract exceeds the verified room-member runtime subset.",
        );
        continue;
      }
      const minimum = input.manifest.execution?.minRuntimeVersion;
      const installed = capabilities.runtimes[0]!.version;
      if (
        (minimum && (/[+-]/.test(minimum) ||
          !runtimeVersionAtLeast(installed, minimum))) ||
        (input.manifest.execution?.requiredResources?.leaseSeconds ?? 0) >
          capabilities.maxLeaseSeconds
      ) {
        reject(
          "executor_runtime_incompatible",
          "The installed runtime or lease limit does not meet the Registry v2 requirement.",
        );
        continue;
      }
      if (
        !registry.execution.requiredCapabilities.every((name) =>
          registryCapabilityAvailable(name, registry, capabilities)) ||
        [
          ...registry.permissions ?? [],
          ...registry.inputPermissions ?? [],
          ...registry.outputPermissions ?? [],
        ].some((permission) =>
          !registryPermissionAvailable(permission, registry, capabilities))
      ) {
        reject(
          "executor_host_capability_denied",
          "The member cannot satisfy every Registry v2 capability and permission.",
        );
        continue;
      }
    }
    if (
      actionArtifactPortsRequired(input.manifest) &&
      (capabilities.maxArtifactBytes ?? 0) < artifactStorageReservationBytes
    ) {
      reject(
        "executor_artifact_storage_denied",
        "The member has not opted into the required artifact storage budget.",
      );
      continue;
    }
    if (!capabilities.allowedActions.includes(input.manifest.name)) {
      reject(
        "executor_action_not_allowlisted",
        "The action package is outside the member’s effective local allowlist.",
      );
      continue;
    }
    if (
      (input.manifest.execution?.runtime !== undefined &&
        input.manifest.execution.runtime !== "node") ||
      Number(capabilities.runtimes[0]!.version.split(".")[0]) < 22 ||
      !capabilities.isolations.includes(
        input.manifest.execution?.isolation ?? "sandboxed-esm",
      )
    ) {
      reject(
        "executor_runtime_incompatible",
        "The installed runtime or enabled isolation does not match the action.",
      );
      continue;
    }
    if (
      input.requiredHostOperations.some(
        (method) => !capabilities.hostOperations.includes(method),
      ) ||
      (input.manifest.permissions ?? []).some(
        (permission) =>
          !capabilities.permissions.some((allowed) =>
            permissionMatches(allowed, permission),
          ),
      )
    ) {
      reject(
        "executor_host_capability_denied",
        "The member does not allow every host operation and permission required by the action.",
      );
      continue;
    }
    eligible.push({ memberId, agent, capabilities });
  }
  return { eligible, rejected };
}

function registryCapabilityAvailable(
  name: string,
  manifest: ActionManifestV2,
  capabilities: ActionExecutionCapabilities,
) {
  if (["action-execution/v1", "action-artifact-ports/v1",
    "action-process-ownership/v1", "runtime:node"].includes(name))
    return true;
  if (name === "partitioned-reduce/v1")
    return manifest.execution.taskMode === "distributed-workers";
  if (name.startsWith("isolation:"))
    return capabilities.isolations.includes(
      name.slice("isolation:".length) as "sandboxed-esm" | "trusted-node",
    );
  if (name.startsWith("host:")) {
    const method = name.slice("host:".length);
    const permission = hostOperationPermission[method];
    return capabilities.hostOperations.includes(method) &&
      (!permission || (manifest.permissions ?? []).some((declared) =>
        permissionMatches(declared, permission)));
  }
  if (name.startsWith("permission:"))
    return registryPermissionAvailable(
      name.slice("permission:".length), manifest, capabilities);
  return false;
}

const hostOperationPermission: Record<string, string> = {
  "storage.getJson": "storage:read",
  "storage.putJson": "storage:write",
  "secrets.get": "secrets:read",
  "beam.rooms.publish": "beam:room-publish",
  "beam.rooms.status": "beam:room-status",
  "beam.rooms.cancel": "beam:room-cancel",
};

function registryPermissionAvailable(
  permission: string,
  manifest: ActionManifestV2,
  capabilities: ActionExecutionCapabilities,
) {
  if (!capabilities.permissions.some((allowed) =>
    permissionMatches(allowed, permission))) return false;
  if (permission === "network:http")
    return manifest.execution.isolation === "trusted-node";
  const operation = Object.entries(hostOperationPermission).find(
    ([, value]) => value === permission,
  )?.[0];
  return !!operation && capabilities.hostOperations.includes(operation);
}

function runtimeVersionAtLeast(installed: string, minimum: string) {
  const parts = (version: string) => version.split(/[+-]/, 1)[0]!
    .split(".").map(Number);
  const actual = parts(installed);
  const required = parts(minimum);
  if (installed.includes("-")) return false;
  for (let index = 0; index < 3; index++) {
    if (actual[index]! !== required[index]!)
      return actual[index]! > required[index]!;
  }
  return true;
}

function restrictCapabilities(
  local: ActionExecutionCapabilities,
  remote: unknown,
): ActionExecutionCapabilities | null {
  if (remote === undefined || remote === null) return local;
  if (typeof remote !== "object" || Array.isArray(remote)) return null;
  const policy = remote as Row;
  const allowedKeys = [
    "enabled",
    "capacity",
    "max_lease_seconds",
    "allowed_actions",
    "isolations",
    "host_operations",
    "permissions",
    "network_hosts",
    "max_artifact_bytes",
  ];
  if (
    Object.keys(policy).some((key) => !allowedKeys.includes(key)) ||
    ("enabled" in policy && policy.enabled !== true)
  )
    return null;
  const result = { ...local };
  for (const [field, key] of [
    ["allowedActions", "allowed_actions"],
    ["isolations", "isolations"],
    ["hostOperations", "host_operations"],
    ["permissions", "permissions"],
  ] as const) {
    if (!(key in policy)) continue;
    if (
      !Array.isArray(policy[key]) ||
      policy[key].some((value: unknown) => typeof value !== "string")
    )
      return null;
    (result as Row)[field] = local[field].filter((value) =>
      policy[key].includes(value),
    );
  }
  if ("max_artifact_bytes" in policy) {
    if (
      !Number.isSafeInteger(policy.max_artifact_bytes) ||
      policy.max_artifact_bytes < 0
    )
      return null;
    result.maxArtifactBytes = Math.min(
      local.maxArtifactBytes ?? 0,
      policy.max_artifact_bytes,
    );
  }
  for (const [field, key] of [
    ["capacity", "capacity"],
    ["maxLeaseSeconds", "max_lease_seconds"],
  ] as const) {
    if (!(key in policy)) continue;
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) return null;
    result[field] = Math.min(local[field], policy[key]);
  }
  return actionExecutionCapabilitiesSchema.safeParse(result).success
    ? result
    : null;
}

function permissionMatches(allowed: string, required: string) {
  const [category, operation] = allowed.split(":", 2),
    [requiredCategory, requiredOperation] = required.split(":", 2);
  return (
    category === requiredCategory &&
    !!operation &&
    !!requiredOperation &&
    (operation === requiredOperation ||
      operation === "*" ||
      (operation.endsWith("*") &&
        requiredOperation.startsWith(operation.slice(0, -1))))
  );
}
