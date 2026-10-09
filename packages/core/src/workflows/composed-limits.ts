import { maxWorkflowCallDepth } from "./contracts.js";
import {
  workflowGraphV2Limits,
  type WorkflowGraphV2Control,
  type WorkflowGraphV2Limits,
} from "./graph-v2.js";

export type ComposedDefinitionShape = {
  steps: { id: string; enabled: boolean; calledWorkflowId?: string }[];
  controls: WorkflowGraphV2Control[];
};

/** Count call instances as well as their descendants, without expanding their graphs. */
export function assertComposedWorkflowLimits(
  rootId: string,
  definitions: Map<string, ComposedDefinitionShape>,
  limits: WorkflowGraphV2Limits = workflowGraphV2Limits,
) {
  const memo = new Map<string, { instances: number; depth: number }>();
  const visiting = new Set<string>();
  function visit(id: string): { instances: number; depth: number } {
    if (visiting.has(id))
      throw new Error(
        `Recursive workflow call: ${[...visiting, id].join(" -> ")}`,
      );
    const saved = memo.get(id);
    if (saved) return saved;
    const definition = definitions.get(id);
    if (!definition)
      throw new Error(
        `Called workflow ${id} is unavailable in this organization.`,
      );
    // Bound traversal itself before computing child heights.
    if (visiting.size >= maxWorkflowCallDepth)
      throw new Error(`Workflow call depth exceeds ${maxWorkflowCallDepth}.`);
    visiting.add(id);
    const multipliers = new Map<string, number>();
    for (const control of definition.controls) {
      const count =
        control.kind === "loop"
          ? typeof control.iterations === "number"
            ? control.iterations
            : limits.maxLoopIterations
          : Array.isArray(control.items)
            ? control.items.length
            : limits.maxFanOutItems;
      const maximum =
        control.kind === "loop"
          ? limits.maxLoopIterations
          : limits.maxFanOutItems;
      if (
        !Number.isSafeInteger(count) ||
        count < (control.kind === "loop" ? 1 : 0) ||
        count > maximum
      )
        throw new Error(
          `Dynamic control ${control.id} exceeds its ${maximum} instance limit.`,
        );
      for (const stepId of control.body.stepIds) {
        if (multipliers.has(stepId))
          throw new Error(
            `Workflow step ${stepId} belongs to multiple dynamic controls.`,
          );
        multipliers.set(stepId, count);
      }
    }
    let instances = 0,
      depth = 1;
    for (const step of definition.steps) {
      const child = step.calledWorkflowId ? visit(step.calledWorkflowId) : null;
      depth = Math.max(depth, 1 + (child?.depth ?? 0));
      if (depth > maxWorkflowCallDepth)
        throw new Error(`Workflow call depth exceeds ${maxWorkflowCallDepth}.`);
      if (!step.enabled) continue;
      instances +=
        (multipliers.get(step.id) ?? 1) * (1 + (child?.instances ?? 0));
      if (instances > limits.maxExpandedActionInstances)
        throw new Error(
          `Composed workflow exceeds the graph expansion limit of ${limits.maxExpandedActionInstances} instances.`,
        );
    }
    visiting.delete(id);
    const result = { instances, depth };
    memo.set(id, result);
    return result;
  }
  return visit(rootId).instances;
}
