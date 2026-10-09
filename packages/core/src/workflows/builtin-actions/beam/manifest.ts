import type {
  ActionCatalogMetadata,
  ActionDistribution,
  ActionManifest,
  ActionPermission,
  ActionTaskMode,
} from "../../actions.js";

const version = "1.0.0";

export function beamActionManifest(input: {
  name: string;
  displayName: string;
  description: string;
  configSchema?: Record<string, unknown>;
  inputs?: Record<string, Record<string, unknown>>;
  outputs?: Record<string, Record<string, unknown>>;
  permissions?: ActionPermission[];
  taskMode?: ActionTaskMode;
  distribution?: ActionDistribution;
  catalog: Omit<ActionCatalogMetadata, "owner" | "changelog"> & {
    changelog?: ActionCatalogMetadata["changelog"];
  };
}) {
  return {
    name: input.name,
    version,
    displayName: input.displayName,
    description: input.description,
    author: "Beam",
    apiVersion: "workflow-actions/v1",
    runtime: { placements: ["local-workers"] },
    execution: {
      taskMode: input.taskMode ?? "single-worker",
      ...(input.distribution ? { distribution: input.distribution } : {}),
    },
    configSchema: input.configSchema ?? {
      type: "object",
      additionalProperties: true,
    },
    inputs: input.inputs ?? {},
    outputs: input.outputs ?? {},
    permissions: input.permissions ?? [],
    trustLevel: input.catalog.maturity === "blocked" ? "blocked" : "builtin",
    catalog: {
      ...input.catalog,
      owner: "Beam",
      changelog: input.catalog.changelog ?? [
        {
          version,
          notes: [`Initial ${input.displayName} builtin action.`],
        },
      ],
    },
  } satisfies ActionManifest;
}
