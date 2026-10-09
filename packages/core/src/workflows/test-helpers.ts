import assert from "node:assert/strict";
import type {
  WorkflowRunStore,
  WorkflowStepRunRecord,
} from "./runner.js";

export function memoryStore() {
  const stepRuns = new Map<string, WorkflowStepRunRecord>();
  const stepOutputs = new Map<string, Record<string, unknown>>();
  const statuses = new Map<string, string>();
  const resolvedVersions = new Map<string, string>();
  const store: WorkflowRunStore & {
    workflowStatus: string | null;
    stepOutputs: Map<string, Record<string, unknown>>;
    statuses: Map<string, string>;
    resolvedVersions: Map<string, string>;
  } = {
    workflowStatus: null,
    stepOutputs,
    statuses,
    resolvedVersions,
    async createStepRun({ workflowRunId, step, attempt }) {
      const run = {
        id: `wsr_${step.id}_${attempt}`,
        workflowRunId,
        stepId: step.id,
        status: "queued",
        attempt,
        state: {},
        externalRef: null,
      } satisfies WorkflowStepRunRecord;
      stepRuns.set(run.id, run);
      statuses.set(step.id, run.status);
      resolvedVersions.set(step.id, step.resolvedVersion);
      return run;
    },
    async updateStepRun(stepRunId, patch) {
      const stepRun = stepRuns.get(stepRunId);
      assert.ok(stepRun);
      if (patch.status) {
        stepRun.status = patch.status;
        statuses.set(stepRun.stepId, patch.status);
      }
      if (patch.output) {
        stepOutputs.set(stepRun.stepId, patch.output);
      }
    },
    async updateWorkflowRun(_workflowRunId, patch) {
      store.workflowStatus = patch.status;
    },
    async log() {},
  };
  return store;
}
