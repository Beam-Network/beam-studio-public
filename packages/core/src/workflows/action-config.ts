import {
  ActionInputError,
  ActionRuntimeCompatibilityError,
  validateActionManifest,
  type ActionJson,
  type ActionManifest,
} from "./actions.js";
import { resolveActionRoomContext } from "@beam-studio/shared";

/** Saved child definitions may require inherited room fields; runnable calls must resolve them. */
export function assertWorkflowActionConfig(
  manifest: ActionManifest,
  config: Record<string, ActionJson>,
  room: unknown,
  requireResolvedRoom = true,
  target?: import("@beam-studio/shared").ActionExecutionTarget,
  allowRegistryV2RoomExecution = false,
  allowGeneratedV3RingConfig = false,
) {
  if (manifest.apiVersion === "workflow-actions/v2") {
    validateActionManifest(manifest);
    if (
      requireResolvedRoom &&
      (!allowRegistryV2RoomExecution || target?.kind !== "room-member")
    )
      throw new ActionRuntimeCompatibilityError(
        "Registry v2 execution requires a V3 room-member target with a verified action runtime.",
      );
  }
  const resolved = resolveActionRoomContext({
    workflowRoom: room,
    actionRoom: target?.kind === "room-member" ? target.room : undefined,
    actionPackage: manifest.name,
    config,
  });
  if (requireResolvedRoom && target?.kind === "room-member" && !resolved.room)
    throw new Error(
      "A room-member execution target requires an effective room. Select a workflow room or a room on this action target.",
    );
  if (
    !requireResolvedRoom &&
    !resolved.room &&
    manifest.name === "@beam/room-transfer"
  ) {
    const schema = objectSchema(manifest.configSchema) ?? {};
    assertActionConfig(
      {
        ...manifest,
        configSchema: {
          ...schema,
          required: (Array.isArray(schema.required)
            ? schema.required
            : []
          ).filter(
            (key) => key !== "roomId" && key !== "environmentTemplateKey",
          ),
        } as ActionManifest["configSchema"],
      },
      resolved.config,
    );
  } else if (
    allowGeneratedV3RingConfig &&
    manifest.apiVersion === "workflow-actions/v2" &&
    target?.kind === "room-member" &&
    (manifest.name === "@beam/ring-batch-seed" ||
      manifest.name === "@beam/ring-batch-transform")
  ) {
    if (Object.keys(resolved.config).length)
      throw new ActionInputError(
        `Config for action "${manifest.name}" is generated from its frozen V3 member task; save an empty step config.`,
      );
    assertActionConfig(
      manifest,
      manifest.name === "@beam/ring-batch-seed"
        ? { memberId: "member_a", batchId: "batch-seed", lotId: "lot-seed" }
        : {
            sourceMemberId: "member_a",
            targetMemberId: "member_b",
            iteration: 1,
          },
    );
  } else assertActionConfig(manifest, resolved.config);
  return resolved;
}

type JsonSchema = Record<string, unknown>;

/** Validate a step before it is saved or frozen into an execution snapshot. */
export function assertActionConfig(
  manifest: ActionManifest,
  config: Record<string, ActionJson>,
) {
  const schema = objectSchema(manifest.configSchema);
  if (!schema) return;

  const errors: string[] = [];
  const properties = objectSchema(schema.properties) ?? {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];

  for (const key of required) {
    if (
      !Object.hasOwn(config, key) ||
      config[key] === null ||
      config[key] === ""
    ) {
      errors.push(`config.${key} is required`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(properties, key))
        errors.push(`config.${key} is not allowed`);
    }
  }

  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === "") continue;
    const property = objectSchema(properties[key]);
    if (!property) continue;
    const expected = typeof property.type === "string" ? property.type : "";
    if (expected && !matchesType(value, expected)) {
      errors.push(`config.${key} must be ${article(expected)} ${expected}`);
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value)) {
      errors.push(`config.${key} must be one of: ${property.enum.join(", ")}`);
    }
  }

  if (errors.length) {
    throw new ActionInputError(
      `Invalid config for action "${manifest.name}": ${errors.join("; ")}.`,
    );
  }
}

function objectSchema(value: unknown): JsonSchema | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;
}

function matchesType(value: ActionJson, expected: string) {
  if (expected === "array") return Array.isArray(value);
  if (expected === "object")
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer")
    return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number";
  if (expected === "string") return typeof value === "string";
  if (expected === "boolean") return typeof value === "boolean";
  return true;
}

function article(word: string) {
  return /^[aeiou]/.test(word) ? "an" : "a";
}
