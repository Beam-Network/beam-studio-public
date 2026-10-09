import { actionExecutionTargetSchema } from "@beam-studio/core";
import type { FrozenWorkflowTree, PgClient } from "@beam-studio/db";

export class StudioRunnerUnavailableError extends Error {
  readonly code = "studio_runner_unavailable";
  readonly statusCode = 503;

  constructor(workflowId: string, stepId: string, runnerIds?: string[]) {
    super(
      `Workflow ${workflowId}, action ${stepId}: no active Studio Action Runner is available in the permitted organization/project scope${runnerIds ? ` for the declared runner set (${runnerIds.join(", ")})` : ""}.`,
    );
    this.name = "StudioRunnerUnavailableError";
  }
}

/** Launch readiness follows enabled calls and each action's declared backend. */
export async function assertWorkflowStudioRunnersAvailablePg(
  client: PgClient,
  tree: FrozenWorkflowTree,
) {
  const visited = new Set<string>();
  const checked = new Set<string>();
  async function visit(id: string): Promise<void> {
    if (visited.has(id)) return;
    visited.add(id);
    const definition = tree.definitions[id];
    if (!definition) throw new Error(`Frozen workflow ${id} is unavailable.`);
    for (const step of definition.resolvedSteps) {
      if (!step.enabled) continue;
      if (step.kind === "workflow") {
        await visit(String(step.calledWorkflowId));
        continue;
      }
      const target = actionExecutionTargetSchema.parse(step.executionTarget);
      if (target.kind !== "studio") continue;
      const runnerIds = target.runnerIds ? [...target.runnerIds].sort() : null;
      const scope = [
        definition.organizationId,
        definition.projectId,
        runnerIds,
      ];
      const key = JSON.stringify(scope);
      if (checked.has(key)) continue;
      const result = await client.query<{ has_active_runner: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM runtime.worker_runtime_state
          WHERE status='active' AND heartbeat_at >= now() - interval '30 seconds'
            AND (organization_id IS NULL OR organization_id=$1)
            AND (project_id IS NULL OR project_id=$2)
            AND ($3::text[] IS NULL OR worker_id=ANY($3::text[]))
        ) AS has_active_runner`,
        scope,
      );
      if (!result.rows[0]?.has_active_runner)
        throw new StudioRunnerUnavailableError(
          id,
          String(step.id),
          target.runnerIds,
        );
      checked.add(key);
    }
  }
  await visit(tree.root.workflowTemplateId);
}
