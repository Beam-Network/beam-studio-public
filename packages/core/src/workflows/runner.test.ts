import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LocalActionRegistry,
  WorkflowValidationError,
  resolveInputBindings,
  runLinearWorkflow,
  validateLinearWorkflow,
  type ActionManifest,
  type WorkflowRunStore,
  type WorkflowRunSnapshot,
  type WorkflowStepRunRecord,
} from "../index.js";

const manifest = {
  name: "@beam/echo",
  version: "1.0.0",
  apiVersion: "workflow-actions/v1",
  runtime: { placements: ["local-workers"] },
  inputs: {},
  outputs: {
    value: {},
  },
} satisfies ActionManifest;

test("runs a linear workflow and propagates step outputs through bindings", async () => {
  const registry = new LocalActionRegistry();
  registry.registerPackage({
    source: "builtin",
    manifest,
    execute: ({ inputs }) => ({
      outputs: { value: inputs.value ?? null },
      metadata: { package: "echo" },
    }),
  });
  const store = memoryStore();
  await runLinearWorkflow(
    {
      workflowRunId: "wfr_1",
      templateId: "wft_1",
      templateSnapshot: {},
      runtimeInputs: { first: "hello" },
      steps: [
        {
          id: "step_one",
          position: 0,
          enabled: true,
          actionPackage: "@beam/echo",
          versionRange: "^1.0.0",
          config: {},
          inputBindings: { value: "${workflow.input.first}" },
        },
        {
          id: "step_two",
          position: 1,
          enabled: true,
          actionPackage: "@beam/echo",
          versionRange: "^1.0.0",
          config: {},
          inputBindings: { value: "${steps.step_one.outputs.value}" },
        },
      ],
    },
    { registry, store },
  );

  assert.equal(store.workflowStatus, "completed");
  assert.deepEqual(store.stepOutputs.get("step_two"), { value: "hello" });
  assert.equal(store.resolvedVersions.get("step_one"), "1.0.0");
});

test("rejects future step references in V1", () => {
  assert.throws(
    () =>
      validateLinearWorkflow({
        workflowRunId: "wfr_1",
        templateId: "wft_1",
        templateSnapshot: {},
        runtimeInputs: {},
        steps: [
          {
            id: "first",
            position: 0,
            enabled: true,
            actionPackage: "@beam/echo",
            versionRange: "1.0.0",
            config: {},
            inputBindings: { value: "${steps.second.outputs.value}" },
          },
          {
            id: "second",
            position: 1,
            enabled: true,
            actionPackage: "@beam/echo",
            versionRange: "1.0.0",
            config: {},
            inputBindings: {},
          },
        ],
      } satisfies WorkflowRunSnapshot),
    WorkflowValidationError,
  );
});

test("marks workflow failed when a required step fails", async () => {
  const registry = new LocalActionRegistry();
  registry.registerPackage({
    source: "builtin",
    manifest,
    execute: () => {
      throw new Error("boom");
    },
  });
  const store = memoryStore();

  await assert.rejects(
    () =>
      runLinearWorkflow(
        {
          workflowRunId: "wfr_failed",
          templateId: "wft_1",
          templateSnapshot: {},
          runtimeInputs: {},
          steps: [
            {
              id: "step_failed",
              position: 0,
              enabled: true,
              actionPackage: "@beam/echo",
              versionRange: "1.0.0",
              config: {},
              inputBindings: {},
            },
          ],
        },
        { registry, store },
      ),
    /boom/,
  );
  assert.equal(store.workflowStatus, "failed");
});

test("rejects branch bindings in V1", () => {
  assert.throws(
    () =>
      validateLinearWorkflow({
        workflowRunId: "wfr_branch",
        templateId: "wft_1",
        templateSnapshot: {},
        runtimeInputs: {},
        steps: [
          {
            id: "branch",
            position: 0,
            enabled: true,
            actionPackage: "@beam/echo",
            versionRange: "1.0.0",
            config: {},
            inputBindings: { condition: "${workflow.branch.enabled}" },
          },
        ],
      }),
    WorkflowValidationError,
  );
});

function memoryStore() {
  const stepOutputs = new Map<string, Record<string, unknown>>();
  const resolvedVersions = new Map<string, string>();
  const stepRuns = new Map<string, WorkflowStepRunRecord>();
  const store: WorkflowRunStore & {
    workflowStatus: string | null;
    stepOutputs: Map<string, Record<string, unknown>>;
    resolvedVersions: Map<string, string>;
  } = {
    workflowStatus: null,
    stepOutputs,
    resolvedVersions,
    async createStepRun({ workflowRunId, step, attempt }) {
      const run = {
        id: `wsr_${step.id}`,
        workflowRunId,
        stepId: step.id,
        status: "queued",
        attempt,
        state: {},
        externalRef: null,
      } satisfies WorkflowStepRunRecord;
      stepRuns.set(run.id, run);
      resolvedVersions.set(step.id, step.resolvedVersion);
      return run;
    },
    async updateStepRun(stepRunId, patch) {
      const stepRun = stepRuns.get(stepRunId);
      assert.ok(stepRun);
      if (patch.status) {
        stepRun.status = patch.status;
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

test("step status and error bind even when a step produced no outputs", () => {
  const metadata = {
    stepsById: new Map([
      [
        "wfs_ok",
        { id: "wfs_ok", status: "completed", error: null, name: "Nightly sync" },
      ],
      [
        "wfs_bad",
        {
          id: "wfs_bad",
          status: "failed",
          error: "connection reset",
          name: "EU mirror",
          action: "@beam/transfer",
          config: { source: "s3://bucket/key" },
          startedAt: "2026-09-04T10:00:00.000Z",
          completedAt: "2026-09-04T10:00:12.000Z",
        },
      ],
    ]),
  };
  const resolved = resolveInputBindings(
    {
      okStatus: "${steps.wfs_ok.status}",
      badStatus: "${steps.wfs_bad.status}",
      badError: "${steps.wfs_bad.error}",
      badName: "${steps.wfs_bad.name}",
      badAction: "${steps.wfs_bad.action}",
      badSource: "${steps.wfs_bad.config.source}",
      badDuration: "${steps.wfs_bad.durationMs}",
      okError: "${steps.wfs_ok.error}",
    },
    {},
    {},
    new Map(),
    new Map(),
    metadata,
  );
  assert.deepEqual(resolved, {
    okStatus: "completed",
    badStatus: "failed",
    badError: "connection reset",
    badName: "EU mirror",
    badAction: "@beam/transfer",
    badSource: "s3://bucket/key",
    badDuration: 12000,
    okError: null,
  });
});

test("a failed step's outputs still throw, so nothing silently reads empty", () => {
  assert.throws(
    () =>
      resolveInputBindings(
        { value: "${steps.wfs_bad.outputs.beamTransferId}" },
        {},
        {},
        new Map(),
        new Map(),
        {
          stepsById: new Map([
            ["wfs_bad", { id: "wfs_bad", status: "failed", error: "boom" }],
          ]),
        },
      ),
    /unavailable step output/,
  );
});

test("an unknown step reads not_reached rather than failing the notification", () => {
  const resolved = resolveInputBindings(
    { status: "${steps.never_ran.status}", error: "${steps.never_ran.error}" },
    {},
    {},
    new Map(),
    new Map(),
    { stepsById: new Map() },
  );
  assert.deepEqual(resolved, { status: "not_reached", error: null });
});

test("status bindings interpolate inside a larger structure", () => {
  const resolved = resolveInputBindings(
    { message: { text: "${steps.wfs_bad.status}" } },
    {},
    {},
    new Map(),
    new Map(),
    {
      stepsById: new Map([
        ["wfs_bad", { id: "wfs_bad", status: "failed", error: "boom" }],
      ]),
    },
  );
  assert.deepEqual(resolved, { message: { text: "failed" } });
});

test("expressions embedded in a sentence are substituted in place", () => {
  // A Slack message reads as prose, so the expressions in it have to resolve
  // where they sit. Before this, the whole string was passed through verbatim
  // and the notification arrived showing raw ${…} text.
  const resolved = resolveInputBindings(
    {
      message:
        "Transfer ${steps.wfs_x.name} status: ${steps.wfs_x.status}",
    },
    {},
    {},
    new Map(),
    new Map(),
    {
      stepsById: new Map([
        [
          "wfs_x",
          {
            id: "wfs_x",
            status: "completed",
            error: null,
            name: "R2 to Hugging Face",
          },
        ],
      ]),
    },
  );
  assert.deepEqual(resolved, {
    message: "Transfer R2 to Hugging Face status: completed",
  });
});

test("a lone expression keeps its type, rather than becoming text", () => {
  const endpoint = { bucket: "b", objectKey: "k" };
  const resolved = resolveInputBindings(
    { endpoint: "${steps.wfs_a.outputs.endpoint}", count: "${steps.wfs_a.outputs.n}" },
    {},
    {},
    new Map([["wfs_a", { endpoint, n: 3 }]]),
    new Map(),
    { stepsById: new Map() },
  );
  assert.deepEqual(resolved, { endpoint, count: 3 });
});

test("two adjacent expressions are not read as one", () => {
  // "${a} ${b}" starts with "${" and ends with "}", so a naive whole-string
  // check treats it as a single expression whose body spans the gap.
  const resolved = resolveInputBindings(
    { message: "${steps.wfs_a.status} ${steps.wfs_b.status}" },
    {},
    {},
    new Map(),
    new Map(),
    {
      stepsById: new Map([
        ["wfs_a", { id: "wfs_a", status: "completed", error: null }],
        ["wfs_b", { id: "wfs_b", status: "failed", error: "boom" }],
      ]),
    },
  );
  assert.deepEqual(resolved, { message: "completed failed" });
});

test("an unknown expression inside a sentence still raises", () => {
  // Silently emitting raw ${…} is what hid the original bug, so an
  // unresolvable expression must fail loudly even mid-sentence.
  assert.throws(
    () =>
      resolveInputBindings(
        { message: "status: ${nonsense.value}" },
        {},
        {},
        new Map(),
        new Map(),
        { stepsById: new Map() },
      ),
    /Unsupported binding expression/,
  );
});

test("a string with no expression is left alone", () => {
  const resolved = resolveInputBindings(
    { message: "plain text, no bindings", cost: "$5 {each}" },
    {},
    {},
    new Map(),
    new Map(),
    { stepsById: new Map() },
  );
  assert.deepEqual(resolved, {
    message: "plain text, no bindings",
    cost: "$5 {each}",
  });
});

test("decision, trigger and run metadata resolve for downstream nodes", () => {
  const resolved = resolveInputBindings(
    {
      branch: "${decisions.dec_1.branch}",
      result: "${decisions.dec_1.result}",
      decisionName: "${decisions.dec_1.name}",
      runId: "${workflow.runId}",
      workflowName: "${workflow.name}",
      triggerType: "${workflow.triggerType}",
    },
    {},
    {},
    new Map(),
    new Map(),
    {
      stepsById: new Map(),
      decisionsById: new Map([
        [
          "dec_1",
          { id: "dec_1", name: "Transfer finished", result: false, branch: "false" },
        ],
      ]),
      run: {
        runId: "wfr_1",
        name: "Nightly EU sync",
        triggerType: "schedule",
      },
    },
  );
  assert.deepEqual(resolved, {
    branch: "false",
    result: false,
    decisionName: "Transfer finished",
    runId: "wfr_1",
    workflowName: "Nightly EU sync",
    triggerType: "schedule",
  });
});

test("a step name falls back to its action package, then its id", () => {
  const resolved = resolveInputBindings(
    { named: "${steps.a.name}", unnamed: "${steps.b.name}", unknown: "${steps.c.name}" },
    {},
    {},
    new Map(),
    new Map(),
    {
      stepsById: new Map([
        ["a", { id: "a", status: "completed", name: "Nightly sync", action: "@beam/transfer" }],
        ["b", { id: "b", status: "completed", action: "@beam/transfer" }],
      ]),
    },
  );
  assert.deepEqual(resolved, {
    named: "Nightly sync",
    unnamed: "@beam/transfer",
    unknown: "c",
  });
});
