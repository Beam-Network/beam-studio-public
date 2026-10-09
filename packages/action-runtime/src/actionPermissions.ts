import {
  ActionPermissionError,
  ActionPlacementError,
  ActionRuntimeCompatibilityError,
  ActionTrustError,
  supportedPlacements,
  validateActionManifest,
  type ActionManifest,
  type ActionPermission,
  type ActionPlacement,
} from "@beam-studio/core";
import { assertRepresentableResourceBudget } from "./resource-budgets.js";

export const defaultAllowedActionPermissions: ActionPermission[] = [
  "storage:read",
  "storage:write",
  "storage:delete",
  "storage:list",
  "network:http",
  "network:nats",
  "secrets:read",
  "beam:room-publish",
  "beam:room-status",
  "beam:room-cancel",
  "beam:transfer-create",
  "beam:transfer-read",
  "beam:transfer-cancel",
];

export function assertExecutorCanLoadAction(
  manifest: ActionManifest,
  options: {
    actionPackage: string;
    resolvedVersion?: string | null;
    allowedActionPermissions?: string[];
    placement?: ActionPlacement;
    v2BudgetsAvailable?: boolean;
  },
) {
  validateActionManifest(manifest);
  if (manifest.name !== options.actionPackage) {
    throw new ActionTrustError(
      `Action artifact manifest name "${manifest.name}" does not match requested package "${options.actionPackage}".`,
    );
  }
  if (options.resolvedVersion && manifest.version !== options.resolvedVersion) {
    throw new ActionTrustError(
      `Action artifact manifest version "${manifest.version}" does not match locked version "${options.resolvedVersion}".`,
    );
  }
  if (
    manifest.trustLevel === "blocked" ||
    manifest.catalog?.maturity === "blocked"
  ) {
    throw new ActionTrustError(
      `Action package "${manifest.name}" is blocked and cannot be executed.`,
    );
  }
  const placement = options.placement ?? "local-workers";
  if (!supportedPlacements(manifest).includes(placement)) {
    throw new ActionPlacementError(
      `Action package "${manifest.name}" is not allowed on ${placement}.`,
    );
  }
  assertActionPermissionsAllowed(
    manifest,
    options.allowedActionPermissions ?? defaultAllowedActionPermissions,
  );
  if (manifest.apiVersion === "workflow-actions/v2") {
    if (!options.v2BudgetsAvailable) {
      throw new ActionRuntimeCompatibilityError(
        "Registry v2 requires enforced CPU and peak-memory limits unavailable in this action runtime.",
      );
    }
    try {
      assertRepresentableResourceBudget(manifest.contracts!.resources);
    } catch {
      throw new ActionRuntimeCompatibilityError(
        "Registry v2 CPU or peak-memory budget cannot be enforced by this runtime.",
      );
    }
  }
}

export function assertActionPermission(
  manifest: ActionManifest,
  permission: ActionPermission,
) {
  if (!permissionMatches(manifest.permissions ?? [], permission)) {
    throw new ActionPermissionError(
      `Action package "${manifest.name}" must declare permission "${permission}".`,
    );
  }
}

export function assertActionPermissions(
  manifest: ActionManifest,
  permissions: ActionPermission[],
) {
  for (const permission of permissions) {
    assertActionPermission(manifest, permission);
  }
}

export function assertAnyActionPermission(
  manifest: ActionManifest,
  permissions: ActionPermission[],
) {
  if (
    permissions.some((permission) =>
      permissionMatches(manifest.permissions ?? [], permission),
    )
  ) {
    return;
  }
  throw new ActionPermissionError(
    `Action package "${manifest.name}" must declare one of permissions: ${permissions.join(", ")}.`,
  );
}

export function actionDeclaresPermission(
  manifest: ActionManifest,
  permission: ActionPermission,
) {
  return permissionMatches(manifest.permissions ?? [], permission);
}

/**
 * RPC methods are capabilities too. Keep the child-facing surface derived from
 * the manifest instead of relying only on checks in individual host adapters.
 */
export function sandboxRpcMethodsForAction(manifest: ActionManifest) {
  const methods = new Set([
    "logger.debug",
    "logger.info",
    "logger.warn",
    "logger.error",
    "state.get",
    "state.set",
    "state.patch",
    "artifacts.publish",
  ]);
  if (actionArtifactPortsRequired(manifest)) {
    methods.add("artifacts.readInput");
    methods.add("artifacts.publishOutput");
  }
  if (actionDeclaresPermission(manifest, "storage:read")) {
    methods.add("storage.getJson");
    methods.add("beam.objectStorage.download");
  }
  if (actionDeclaresPermission(manifest, "storage:write")) {
    methods.add("storage.putJson");
    methods.add("beam.objectStorage.upload");
  }
  if (actionDeclaresPermission(manifest, "storage:delete")) {
    methods.add("beam.objectStorage.delete");
  }
  if (
    actionDeclaresPermission(manifest, "secrets:read") ||
    (manifest.permissions ?? []).some((permission) =>
      permission.startsWith("secrets:"),
    )
  ) {
    methods.add("secrets.get");
  }
  if (actionDeclaresPermission(manifest, "filesystem:read")) {
    methods.add("beam.fileExports.publishLocalFile");
  }
  if (actionDeclaresPermission(manifest, "filesystem:write")) {
    methods.add("beam.files.publishTempFile");
  }
  if (
    (manifest.permissions ?? []).some(
      (permission) =>
        permission === "beam:*" || permission.startsWith("beam:transfer-"),
    )
  ) {
    methods.add("beam.transfer.execute");
  }
  for (const operation of ["publish", "status", "cancel"] as const) {
    if (actionDeclaresPermission(manifest, `beam:room-${operation}`))
      methods.add(`beam.rooms.${operation}`);
  }
  return [...methods];
}

export function isRuntimeArtifactMethod(method: string) {
  return (
    method === "artifacts.readInput" || method === "artifacts.publishOutput"
  );
}

export function actionArtifactPortsRequired(manifest: ActionManifest) {
  if (manifest.apiVersion === "workflow-actions/v2") return true;
  return [
    ...Object.values(manifest.inputs ?? {}),
    ...Object.values(manifest.outputs ?? {}),
  ].some(
    (schema) => schema.type === "artifact" || schema.type === "artifact[]",
  );
}

function assertActionPermissionsAllowed(
  manifest: ActionManifest,
  allowedPermissions: string[],
) {
  for (const permission of manifest.permissions ?? []) {
    if (!permissionMatches(allowedPermissions, permission)) {
      throw new ActionPermissionError(
        `Action package "${manifest.name}" declares permission "${permission}", but this worker does not allow it.`,
      );
    }
  }
}

function permissionMatches(available: readonly string[], required: string) {
  const [requiredCategory, requiredOperation] = splitPermission(required);
  return available.some((candidate) => {
    const [candidateCategory, candidateOperation] = splitPermission(candidate);
    return (
      candidateCategory === requiredCategory &&
      (candidateOperation === "*" ||
        candidateOperation === requiredOperation ||
        (candidateOperation.endsWith("*") &&
          requiredOperation.startsWith(candidateOperation.slice(0, -1))))
    );
  });
}

function splitPermission(permission: string) {
  const [category, operation = ""] = permission.split(":", 2);
  return [category, operation] as const;
}
