import {
  validateWorkflowGraphV3,
  type WorkflowGraphV3Definition,
  type WorkflowGraphV3Distribution,
} from "@beam-studio/core/workflows/graph-v3";
import type { WorkflowGraphV2Control } from "@beam-studio/core/workflows/graph-v2";

export const emptyDistribution = (): WorkflowGraphV3Distribution => ({
  partitions: [],
  steps: [],
  routes: [],
});

/** Run the same structural validator used by the API and MCP authoring paths. */
export function distributionValidationError(input: {
  controls: WorkflowGraphV2Control[];
  distribution: WorkflowGraphV3Distribution;
  edges: Array<{ fromStepId: string; toStepId: string; condition?: unknown }>;
  steps: Array<{ id: string; enabled: boolean }>;
}): string | null {
  try {
    validateWorkflowGraphV3(
      {
        version: "workflow-graph/v3",
        controls: input.controls,
        edges: input.edges.map((edge) => ({
          from: edge.fromStepId,
          to: edge.toStepId,
          condition:
            edge.condition as WorkflowGraphV3Definition["edges"][number]["condition"],
        })),
        distribution: input.distribution,
      },
      input.steps,
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
