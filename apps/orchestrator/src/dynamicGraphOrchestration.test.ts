import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  pgMany,
  pgOne,
  type PgClient,
  type PgPool,
} from "@beam-studio/db";
import type {
  ActionJson,
  WorkflowDecision,
  WorkflowDecisionEdge,
  WorkflowGraphV2Control,
} from "@beam-studio/core";
import {
  decisionPrerequisiteGate,
  orchestrateDynamicGraphPg,
} from "./dynamicGraphOrchestration.js";
import type { ApiWorkflowStep, OrchestratorOptions, Row } from "./types.js";

const testDatabaseUrl =
  process.env.G7_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;

test("decision branches gate their ordinary prerequisites", () => {
  assert.equal(decisionPrerequisiteGate(["taken"], false), "ready");
  assert.equal(decisionPrerequisiteGate(["taken"], true), "continue");
  assert.equal(decisionPrerequisiteGate(["waiting"], true), "waiting");
  assert.equal(decisionPrerequisiteGate(["not_taken"], true), "skipped");
});

test(
  "durably fans out wait actions, preserves order, and creates no duplicates after restart",
  { skip: !testDatabaseUrl },
  async () => {
    await withIsolatedPostgres(async (pool) => {
      const fixture = await seedRun(pool, "fanout");
      const control: WorkflowGraphV2Control = {
        id: "parallel",
        kind: "fan-out",
        items: ["same", "same", "last"],
        concurrency: 2,
        fanInId: "parallel_join",
        body: {
          stepIds: [fixture.step.id],
          entryStepId: fixture.step.id,
          outputStepId: fixture.step.id,
          edges: [],
        },
      };
      const scheduledPerPass: number[] = [];

      for (let pass = 0; pass < 4; pass += 1) {
        const scheduled: number[] = [];
        await runPass(pool, fixture, control, scheduled, {
          completedAtByIndex: new Map([
            [0, "2026-01-01T00:00:03.000Z"],
            [1, "2026-01-01T00:00:01.000Z"],
            [2, "2026-01-01T00:00:02.000Z"],
          ]),
        });
        scheduledPerPass.push(scheduled.length);
        const run = await pgOne<Row>(
          pool,
          "SELECT status FROM execution.workflow_runs WHERE id = $1",
          [fixture.runId],
        );
        if (run?.status === "completed") break;
      }

      assert.deepEqual(scheduledPerPass.slice(0, 2), [2, 1]);
      const region = await pgOne<Row>(
        pool,
        `SELECT * FROM execution.workflow_dynamic_regions
         WHERE workflow_run_id = $1`,
        [fixture.runId],
      );
      assert.equal(region?.status, "completed");
      assert.deepEqual(jsonObject(region?.output_json).values, [
        { value: "same" },
        { value: "same" },
        { value: "last" },
      ]);
      const instances = await pgMany<Row>(
        pool,
        `SELECT * FROM execution.workflow_dynamic_instances
         WHERE workflow_run_id = $1 ORDER BY instance_index`,
        [fixture.runId],
      );
      assert.equal(instances.length, 3);
      assert.deepEqual(
        instances.map((row) => Number(row.instance_index)),
        [0, 1, 2],
      );

      const afterRestart: number[] = [];
      await runPass(pool, fixture, control, afterRestart);
      assert.deepEqual(afterRestart, []);
      const count = await pgOne<Row>(
        pool,
        `SELECT COUNT(*)::int AS count FROM execution.workflow_dynamic_instances
         WHERE workflow_run_id = $1`,
        [fixture.runId],
      );
      assert.equal(Number(count?.count), 3);
    });
  },
);

test(
  "settles an empty wait fan-out and resumes a bounded wait loop without duplicate iterations",
  { skip: !testDatabaseUrl },
  async () => {
    await withIsolatedPostgres(async (pool) => {
      const empty = await seedRun(pool, "empty");
      const emptyControl: WorkflowGraphV2Control = {
        id: "parallel_empty",
        kind: "fan-out",
        items: [],
        concurrency: 2,
        fanInId: "parallel_empty_join",
        body: {
          stepIds: [empty.step.id],
          entryStepId: empty.step.id,
          outputStepId: empty.step.id,
          edges: [],
        },
      };
      await runPass(pool, empty, emptyControl, []);
      const emptyRegion = await pgOne<Row>(
        pool,
        `SELECT * FROM execution.workflow_dynamic_regions
         WHERE workflow_run_id = $1`,
        [empty.runId],
      );
      assert.equal(emptyRegion?.status, "completed");
      assert.deepEqual(jsonObject(emptyRegion?.output_json).values, []);

      const loop = await seedRun(pool, "loop");
      loop.step.inputBindings = {
        value: "${graph.repeat.iteration}",
        previous: "${graph.repeat.previous.value}",
      };
      const loopControl: WorkflowGraphV2Control = {
        id: "repeat",
        kind: "loop",
        iterations: 3,
        outputMode: "all",
        body: {
          stepIds: [loop.step.id],
          entryStepId: loop.step.id,
          outputStepId: loop.step.id,
          edges: [],
        },
      };
      const scheduled: number[] = [];
      await runPass(pool, loop, loopControl, scheduled);
      assert.deepEqual(scheduled, [0]);
      await runPass(pool, loop, loopControl, scheduled);
      assert.deepEqual(scheduled, [0, 1]);
      await runPass(pool, loop, loopControl, scheduled);
      assert.deepEqual(scheduled, [0, 1, 2]);

      const instances = await pgMany<Row>(
        pool,
        `SELECT * FROM execution.workflow_dynamic_instances
         WHERE workflow_run_id = $1 ORDER BY instance_index`,
        [loop.runId],
      );
      assert.equal(instances.length, 3);
      assert.deepEqual(
        instances.map((row) => jsonObject(row.context_json).repeat),
        [
          { index: 0, iteration: 1, previous: null },
          { index: 1, iteration: 2, previous: { value: 1 } },
          { index: 2, iteration: 3, previous: { value: 2 } },
        ],
      );
      const loopRegion = await pgOne<Row>(
        pool,
        `SELECT output_json FROM execution.workflow_dynamic_regions
         WHERE workflow_run_id = $1`,
        [loop.runId],
      );
      assert.deepEqual(jsonObject(loopRegion?.output_json).values, [
        { value: 1 },
        { value: 2 },
        { value: 3 },
      ]);
    });
  },
);

test(
  "settles admitted wait shards after failure and resumes a failed wait loop at its failed iteration",
  { skip: !testDatabaseUrl },
  async () => {
    await withIsolatedPostgres(async (pool) => {
      const fanout = await seedRun(pool, "fanout_failure");
      const fanoutControl: WorkflowGraphV2Control = {
        id: "parallel",
        kind: "fan-out",
        items: ["ok", "fails"],
        concurrency: 2,
        fanInId: "parallel_join",
        body: {
          stepIds: [fanout.step.id],
          entryStepId: fanout.step.id,
          outputStepId: fanout.step.id,
          edges: [],
        },
      };
      const scheduledFanout: number[] = [];
      await runPass(pool, fanout, fanoutControl, scheduledFanout, {
        failIndexes: new Set([1]),
      });
      assert.deepEqual(scheduledFanout, [0, 1]);
      const failedFanout = await pgOne<Row>(
        pool,
        `SELECT status, completed_count, failed_count, output_json
         FROM execution.workflow_dynamic_regions WHERE workflow_run_id = $1`,
        [fanout.runId],
      );
      assert.equal(failedFanout?.status, "failed");
      assert.equal(Number(failedFanout?.completed_count), 1);
      assert.equal(Number(failedFanout?.failed_count), 1);
      assert.deepEqual(jsonObject(failedFanout?.output_json).values, [
        { value: "ok" },
        null,
      ]);
      await pool.query(
        `UPDATE execution.workflow_step_runs
         SET status = 'completed', attempt = 2,
             output_json = '{"value":"retried"}'::jsonb,
             error = NULL, updated_at = now()
         WHERE workflow_run_id = $1 AND status = 'failed'`,
        [fanout.runId],
      );
      await pool.query(
        `UPDATE execution.workflow_dynamic_regions
         SET status = 'running', failed_count = 0, error = NULL,
             completed_at = NULL, updated_at = now()
         WHERE workflow_run_id = $1`,
        [fanout.runId],
      );
      await pool.query(
        `UPDATE execution.workflow_runs
         SET status = 'running', error = NULL, completed_at = NULL, updated_at = now()
         WHERE id = $1`,
        [fanout.runId],
      );
      const retryScheduled: number[] = [];
      await runPass(pool, fanout, fanoutControl, retryScheduled);
      assert.deepEqual(retryScheduled, []);
      const retriedFanout = await pgOne<Row>(
        pool,
        `SELECT status, output_json
         FROM execution.workflow_dynamic_regions WHERE workflow_run_id = $1`,
        [fanout.runId],
      );
      assert.equal(retriedFanout?.status, "completed");
      assert.deepEqual(jsonObject(retriedFanout?.output_json).values, [
        { value: "ok" },
        { value: "retried" },
      ]);
      const fanoutAttempts = await pgMany<Row>(
        pool,
        `SELECT instance_index, current_attempt
         FROM execution.workflow_dynamic_instances
         WHERE workflow_run_id = $1 ORDER BY instance_index`,
        [fanout.runId],
      );
      assert.deepEqual(
        fanoutAttempts.map((row) => [
          Number(row.instance_index),
          Number(row.current_attempt),
        ]),
        [
          [0, 1],
          [1, 2],
        ],
      );

      const loop = await seedRun(pool, "loop_failure");
      loop.step.inputBindings = { value: "${graph.repeat.iteration}" };
      const loopControl: WorkflowGraphV2Control = {
        id: "repeat",
        kind: "loop",
        iterations: 3,
        body: {
          stepIds: [loop.step.id],
          entryStepId: loop.step.id,
          outputStepId: loop.step.id,
          edges: [],
        },
      };
      await runPass(pool, loop, loopControl, [], { failIndexes: new Set() });
      await runPass(pool, loop, loopControl, [], {
        failIndexes: new Set([1]),
      });
      const failedLoop = await pgOne<Row>(
        pool,
        `SELECT status FROM execution.workflow_dynamic_regions WHERE workflow_run_id = $1`,
        [loop.runId],
      );
      assert.equal(failedLoop?.status, "failed");

      await pool.query(
        `UPDATE execution.workflow_step_runs
         SET status = 'completed', attempt = 2, output_json = '{"value":2}'::jsonb,
             error = NULL, updated_at = now()
         WHERE workflow_run_id = $1 AND attempt = 1 AND status = 'failed'`,
        [loop.runId],
      );
      await pool.query(
        `UPDATE execution.workflow_dynamic_regions
         SET status = 'running', error = NULL, completed_at = NULL, updated_at = now()
         WHERE workflow_run_id = $1`,
        [loop.runId],
      );
      await pool.query(
        `UPDATE execution.workflow_runs
         SET status = 'running', error = NULL, completed_at = NULL, updated_at = now()
         WHERE id = $1`,
        [loop.runId],
      );
      const resumed: number[] = [];
      await runPass(pool, loop, loopControl, resumed);
      assert.deepEqual(resumed, [2]);
      const loopAttempts = await pgMany<Row>(
        pool,
        `SELECT instance_index, current_attempt
         FROM execution.workflow_dynamic_instances
         WHERE workflow_run_id = $1 ORDER BY instance_index`,
        [loop.runId],
      );
      assert.deepEqual(
        loopAttempts.map((row) => [
          Number(row.instance_index),
          Number(row.current_attempt),
        ]),
        [
          [0, 1],
          [1, 2],
          [2, 1],
        ],
      );
    });
  },
);

test(
  "persists redacted condition reasons for individual wait instances",
  { skip: !testDatabaseUrl },
  async () => {
    await withIsolatedPostgres(async (pool) => {
      const fixture = await seedRun(pool, "conditions");
      const secondStep = await addWaitStep(
        pool,
        fixture,
        "wait_conditions_after",
        1,
      );
      const control: WorkflowGraphV2Control = {
        id: "parallel",
        kind: "fan-out",
        items: ["one"],
        concurrency: 1,
        fanInId: "parallel_join",
        body: {
          stepIds: [fixture.step.id, secondStep.id],
          entryStepId: fixture.step.id,
          outputStepId: secondStep.id,
          edges: [
            {
              id: "secret_condition",
              from: fixture.step.id,
              to: secondStep.id,
              condition: '${workflow.input.secret} == "expected"',
            },
          ],
        },
      };
      const withTwoSteps = { ...fixture, steps: [fixture.step, secondStep] };
      await runPass(pool, withTwoSteps, control, []);
      await runPass(pool, withTwoSteps, control, []);
      const trace = await pgOne<Row>(
        pool,
        `SELECT outcome, reason, summary_json
         FROM execution.workflow_condition_evaluations
         WHERE workflow_run_id = $1 AND edge_id = 'secret_condition'`,
        [fixture.runId],
      );
      assert.equal(trace?.outcome, "skipped");
      assert.equal(trace?.reason, "condition_false");
      assert.deepEqual(jsonObject(trace?.summary_json), {
        conditionPresent: true,
        conditionType: "string",
      });
      assert.doesNotMatch(JSON.stringify(trace), /secret|expected/);
    });
  },
);

test(
  "a decision routes a failed upstream to its false branch and can absorb the failure",
  { skip: !testDatabaseUrl },
  async () => {
    await withIsolatedPostgres(async (pool) => {
      const fixture = await seedRun(pool, "decision_failure");
      const source = fixture.step; // fails
      const sibling = await addWaitStep(pool, fixture, "sibling", 1);
      const onTrue = await addWaitStep(pool, fixture, "on_true", 2);
      const onFalse = await addWaitStep(pool, fixture, "on_false", 3);
      const steps = [source, sibling, onTrue, onFalse];

      const decision: WorkflowDecision = {
        id: "dec_gate",
        name: "All transfers done",
        kind: "if",
        enabled: true,
        joinMode: "all",
        handleFailure: true,
      };
      const decisionEdges: WorkflowDecisionEdge[] = [
        { id: "de_in_a", fromStepId: source.id, toDecisionId: decision.id },
        { id: "de_in_b", fromStepId: sibling.id, toDecisionId: decision.id },
        {
          id: "de_true",
          fromDecisionId: decision.id,
          toStepId: onTrue.id,
          branch: "true",
        },
        {
          id: "de_false",
          fromDecisionId: decision.id,
          toStepId: onFalse.id,
          branch: "false",
        },
      ];

      await seedStepRun(
        pool,
        fixture.runId,
        source.id,
        "failed",
        "transfer blew up",
      );
      await seedStepRun(pool, fixture.runId, sibling.id, "completed", null);

      const started: string[] = [];
      const terminal: Array<{ id: string; status: string; reason: string }> = [];
      let finished: { status: string; error: string | null } | null = null;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await orchestrateDynamicGraphPg({
          client,
          controls: [],
          decisions: [decision],
          decisionEdges,
          edges: [],
          options: testOptions(),
          organizationId: fixture.organizationId,
          runtimeInputs: {},
          steps,
          templateSnapshot: {},
          workflowRunId: fixture.runId,
          callbacks: {
            createStepTask: async ({ step }) => {
              started.push(step.id);
              await seedStepRun(
                client,
                fixture.runId,
                step.id,
                "completed",
                null,
              );
              return {
                taskId: `task_${step.id}`,
                taskKind: "wait",
                actionPackageName: "@beam/wait",
                workflowRunId: fixture.runId,
                workflowStepRunId: `wsr_${fixture.runId}_${step.id}`,
                subject: "beam.tasks.wait",
                payload: {},
              } as never;
            },
            createTerminalStep: async ({ reason, status, step }) => {
              terminal.push({ id: step.id, reason, status });
              await seedStepRun(client, fixture.runId, step.id, status, null);
            },
            finishRun: async (status, error) => {
              finished = { status, error };
            },
            hasActiveTasks: async () => false,
            cancelActiveWork: async () => {},
            appendEvent: async () => {},
          },
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      assert.deepEqual(started, [onFalse.id], "only the false branch runs");
      assert.deepEqual(
        terminal.map((entry) => entry.id),
        [onTrue.id],
        "the untaken branch is settled, not left dangling",
      );
      assert.equal(terminal[0]?.status, "skipped");

      const evaluation = await pgOne<Row>(
        pool,
        `SELECT * FROM execution.workflow_decision_evaluations
         WHERE workflow_run_id = $1 AND decision_id = $2`,
        [fixture.runId, decision.id],
      );
      assert.ok(evaluation, "the decision records an evaluation");
      assert.equal(evaluation?.evaluated, true);
      assert.equal(evaluation?.result, false);
      assert.equal(String(evaluation?.taken_branch), "false");
      assert.equal(String(evaluation?.reason), "join_unsatisfied");
      assert.equal(String(evaluation?.join_mode), "all");
      assert.equal(String(evaluation?.decision_kind), "if");
      const handled = Array.isArray(evaluation?.handled_failures)
        ? evaluation?.handled_failures
        : JSON.parse(String(evaluation?.handled_failures ?? "[]"));
      assert.deepEqual(handled, [source.id], "the failed input is consumed");

      assert.equal(
        (finished as { status: string; error: string | null } | null)?.status,
        "completed",
        "a handled failure does not fail the run",
      );

      const failedRun = await pgOne<Row>(
        pool,
        `SELECT status, error FROM execution.workflow_step_runs
         WHERE workflow_run_id = $1 AND workflow_step_id = $2`,
        [fixture.runId, source.id],
      );
      assert.equal(
        String(failedRun?.status),
        "failed",
        "the step itself stays failed with its error intact",
      );
      assert.equal(String(failedRun?.error), "transfer blew up");
    });
  },
);

test(
  "a Switch starts exactly one matching transfer branch",
  { skip: !testDatabaseUrl },
  async () => {
    await withIsolatedPostgres(async (pool) => {
      const fixture = await seedRun(pool, "switch_transfer_size");
      const source = fixture.step;
      const oneGib = await addWaitStep(pool, fixture, "transfer_one_gib", 1);
      const fiveGib = await addWaitStep(pool, fixture, "transfer_five_gib", 2);
      const tenGib = await addWaitStep(pool, fixture, "transfer_ten_gib", 3);
      const noTransfer = await addWaitStep(pool, fixture, "no_transfer", 4);
      const steps = [source, oneGib, fiveGib, tenGib, noTransfer];
      const eligible =
        "${steps.wait_switch_transfer_size.outputs.body.pools.qualifying.eligible}";
      const decision: WorkflowDecision = {
        id: "dec_size",
        name: "Choose transfer size",
        kind: "switch",
        enabled: true,
        joinMode: "all",
        handleFailure: false,
        cases: [
          {
            id: "one_gib",
            name: "1 GiB",
            predicate: { left: eligible, op: "lte", right: 5 },
          },
          {
            id: "five_gib",
            name: "5 GiB",
            predicate: { left: eligible, op: "lte", right: 25 },
          },
          { id: "ten_gib", name: "10 GiB", predicate: true },
        ],
      };
      const decisionEdges: WorkflowDecisionEdge[] = [
        { id: "de_in", fromStepId: source.id, toDecisionId: decision.id },
        {
          id: "de_one",
          fromDecisionId: decision.id,
          toStepId: oneGib.id,
          branch: "case:one_gib",
        },
        {
          id: "de_five",
          fromDecisionId: decision.id,
          toStepId: fiveGib.id,
          branch: "case:five_gib",
        },
        {
          id: "de_ten",
          fromDecisionId: decision.id,
          toStepId: tenGib.id,
          branch: "case:ten_gib",
        },
        {
          id: "de_default",
          fromDecisionId: decision.id,
          toStepId: noTransfer.id,
          branch: "default",
        },
      ];
      await seedStepRun(pool, fixture.runId, source.id, "completed", null, {
        body: { pools: { qualifying: { eligible: 6 } } },
      });

      const started: string[] = [];
      const terminal: string[] = [];
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await orchestrateDynamicGraphPg({
          client,
          controls: [],
          decisions: [decision],
          decisionEdges,
          edges: [],
          options: testOptions(),
          organizationId: fixture.organizationId,
          runtimeInputs: {},
          steps,
          templateSnapshot: {},
          workflowRunId: fixture.runId,
          callbacks: {
            createStepTask: async ({ step }) => {
              started.push(step.id);
              await seedStepRun(
                client,
                fixture.runId,
                step.id,
                "completed",
                null,
              );
              return {
                taskId: `task_${step.id}`,
                taskKind: "wait",
                actionPackageName: "@beam/wait",
                workflowRunId: fixture.runId,
                workflowStepRunId: `wsr_${fixture.runId}_${step.id}`,
                subject: "beam.tasks.wait",
                payload: {},
              } as never;
            },
            createTerminalStep: async ({ status, step }) => {
              terminal.push(step.id);
              await seedStepRun(client, fixture.runId, step.id, status, null);
            },
            finishRun: async () => {},
            hasActiveTasks: async () => false,
            cancelActiveWork: async () => {},
            appendEvent: async () => {},
          },
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      assert.deepEqual(started, [fiveGib.id]);
      assert.deepEqual(
        terminal.sort(),
        [oneGib.id, tenGib.id, noTransfer.id].sort(),
      );
      const evaluation = await pgOne<Row>(
        pool,
        `SELECT decision_kind, taken_branch
         FROM execution.workflow_decision_evaluations
         WHERE workflow_run_id = $1 AND decision_id = $2`,
        [fixture.runId, decision.id],
      );
      assert.equal(evaluation?.decision_kind, "switch");
      assert.equal(evaluation?.taken_branch, "case:five_gib");
    });
  },
);

test(
  "a decision that does not handle failures leaves the run failed",
  { skip: !testDatabaseUrl },
  async () => {
    await withIsolatedPostgres(async (pool) => {
      const fixture = await seedRun(pool, "decision_unhandled");
      const source = fixture.step;
      const onFalse = await addWaitStep(pool, fixture, "notify", 1);
      const decision: WorkflowDecision = {
        id: "dec_plain",
        name: "Decision",
        kind: "if",
        enabled: true,
        joinMode: "all",
        handleFailure: false,
      };
      const decisionEdges: WorkflowDecisionEdge[] = [
        { id: "de_in", fromStepId: source.id, toDecisionId: decision.id },
        {
          id: "de_false",
          fromDecisionId: decision.id,
          toStepId: onFalse.id,
          branch: "false",
        },
      ];
      await seedStepRun(pool, fixture.runId, source.id, "failed", "boom");

      let finished: { status: string; error: string | null } | null = null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await orchestrateDynamicGraphPg({
          client,
          controls: [],
          decisions: [decision],
          decisionEdges,
          edges: [],
          options: testOptions(),
          organizationId: fixture.organizationId,
          runtimeInputs: {},
          steps: [source, onFalse],
          templateSnapshot: {},
          workflowRunId: fixture.runId,
          callbacks: {
            createStepTask: async ({ step }) => {
              await seedStepRun(
                client,
                fixture.runId,
                step.id,
                "completed",
                null,
              );
              return {
                taskId: `task_${step.id}`,
                taskKind: "wait",
                actionPackageName: "@beam/wait",
                workflowRunId: fixture.runId,
                workflowStepRunId: `wsr_${fixture.runId}_${step.id}`,
                subject: "beam.tasks.wait",
                payload: {},
              } as never;
            },
            createTerminalStep: async ({ status, step }) => {
              await seedStepRun(client, fixture.runId, step.id, status, null);
            },
            finishRun: async (status, error) => {
              finished = { status, error };
            },
            hasActiveTasks: async () => false,
            cancelActiveWork: async () => {},
            appendEvent: async () => {},
          },
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      assert.equal(
        (finished as { status: string; error: string | null } | null)?.status,
        "failed",
        "configuration alone must never suppress a failure",
      );

      const evaluation = await pgOne<Row>(
        pool,
        `SELECT handled_failures FROM execution.workflow_decision_evaluations
         WHERE workflow_run_id = $1 AND decision_id = $2`,
        [fixture.runId, decision.id],
      );
      const handled = Array.isArray(evaluation?.handled_failures)
        ? evaluation?.handled_failures
        : JSON.parse(String(evaluation?.handled_failures ?? "[]"));
      assert.deepEqual(
        handled,
        [],
        "nothing is consumed when the node opts out",
      );
    });
  },
);

async function seedStepRun(
  executor: PgPool | PgClient,
  workflowRunId: string,
  stepId: string,
  status: string,
  error: string | null,
  output: ActionJson = {},
) {
  await executor.query(
    `
    INSERT INTO execution.workflow_step_runs (
      id, workflow_run_id, workflow_step_id, action_package_name,
      resolved_version, checksum, source_registry, resolved_placement,
      status, attempt, input_json, output_json, metadata_json, state_json,
      error, started_at, completed_at, created_at, updated_at
    )
    VALUES ($1, $2, $3, '@beam/wait', '1.0.0', 'wait-checksum', 'registry',
      'local-workers', $4, 1, '{}'::jsonb, $6::jsonb, '{}'::jsonb, '{}'::jsonb,
      $5, now(), now(), now(), now())
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error
    `,
    [
      `wsr_${workflowRunId}_${stepId}`,
      workflowRunId,
      stepId,
      status,
      error,
      JSON.stringify(output),
    ],
  );
}

async function runPass(
  pool: PgPool,
  fixture: Awaited<ReturnType<typeof seedRun>> & { steps?: ApiWorkflowStep[] },
  control: WorkflowGraphV2Control,
  scheduled: number[],
  behavior: {
    completedAtByIndex?: Map<number, string>;
    failIndexes?: Set<number>;
  } = {},
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await orchestrateDynamicGraphPg({
      client,
      controls: [control],
      decisions: [],
      decisionEdges: [],
      edges: [],
      options: testOptions(),
      organizationId: fixture.organizationId,
      runtimeInputs: {},
      steps: fixture.steps ?? [fixture.step],
      templateSnapshot: {},
      workflowRunId: fixture.runId,
      callbacks: {
        createStepTask: async ({ dynamicInstanceId, inputs, step }) => {
          assert.equal(step.actionPackage, "@beam/wait");
          assert.ok(dynamicInstanceId);
          const instance = await pgOne<Row>(
            client,
            `SELECT * FROM execution.workflow_dynamic_instances WHERE id = $1`,
            [dynamicInstanceId],
          );
          const index = Number(instance?.instance_index ?? -1);
          scheduled.push(index);
          await wait(Number(inputs.durationMs ?? 0));
          const status = behavior.failIndexes?.has(index)
            ? "failed"
            : "completed";
          const stepRunId = `wsr_${fixture.runId}_${step.id}_${index}`;
          await client.query(
            `
            INSERT INTO execution.workflow_step_runs (
              id, workflow_run_id, workflow_step_id, dynamic_instance_id,
              action_package_name, resolved_version, checksum, source_registry,
              resolved_placement, status, attempt, input_json, output_json,
              metadata_json, state_json, started_at, completed_at, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, '@beam/wait', '1.0.0', 'wait-checksum',
              'registry', 'local-workers', $5, 1, $6::jsonb, $7::jsonb,
              '{}'::jsonb, '{}'::jsonb, now(), $8, now(), now())
            ON CONFLICT DO NOTHING
            `,
            [
              stepRunId,
              fixture.runId,
              step.id,
              dynamicInstanceId,
              status,
              JSON.stringify(inputs),
              JSON.stringify({ value: inputs.value ?? null }),
              behavior.completedAtByIndex?.get(index) ?? new Date().toISOString(),
            ],
          );
          return {
            taskId: `wait_${fixture.runId}_${step.id}_${index}`,
            taskKind: "wait",
            actionPackageName: "@beam/wait",
            workflowRunId: fixture.runId,
          };
        },
        createTerminalStep: async ({ dynamicInstanceId, reason, status }) => {
          assert.ok(dynamicInstanceId);
          await client.query(
            `UPDATE execution.workflow_dynamic_instances
             SET status = $2, error = $3, completed_at = now(), updated_at = now()
             WHERE id = $1`,
            [dynamicInstanceId, status, reason],
          );
        },
        finishRun: async (status, error) => {
          await client.query(
            `UPDATE execution.workflow_runs SET status = $2, error = $3,
             completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN now() ELSE NULL END,
             updated_at = now() WHERE id = $1`,
            [fixture.runId, status, error],
          );
        },
        hasActiveTasks: async () => false,
        cancelActiveWork: async () => {},
        appendEvent: async () => {},
      },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedRun(pool: PgPool, suffix: string) {
  const organizationId = `org_g7_${suffix}`;
  const templateId = `wft_g7_${suffix}`;
  const stepId = `wait_${suffix}`;
  const runId = `wfr_g7_${suffix}`;
  await pool.query(
    `INSERT INTO identity.organizations (id, slug, name)
     VALUES ($1, $2, $3)`,
    [organizationId, organizationId, `G7 ${suffix}`],
  );
  await pool.query(
    `INSERT INTO workflow.templates (
       id, organization_id, name, graph_version, graph_json
     ) VALUES ($1, $2, $3, 'workflow-graph/v2',
       '{"version":"workflow-graph/v2","controls":[],"edges":[]}'::jsonb)`,
    [templateId, organizationId, `G7 ${suffix}`],
  );
  await pool.query(
    `INSERT INTO workflow.steps (
       id, workflow_template_id, action_package_name, action_version_range,
       position, enabled, input_bindings_json
     ) VALUES ($1, $2, '@beam/wait', '1.0.0', 0, true, $3::jsonb)`,
    [
      stepId,
      templateId,
      JSON.stringify({ value: "${graph.parallel.item}", durationMs: 0 }),
    ],
  );
  await pool.query(
    `INSERT INTO execution.workflow_runs (
       id, organization_id, workflow_template_id, status, trigger,
       template_snapshot_json, resolved_steps_json, input_json
     ) VALUES ($1, $2, $3, 'running', 'test', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
    [runId, organizationId, templateId],
  );
  const step: ApiWorkflowStep = {
    id: stepId,
    position: 0,
    enabled: true,
    actionPackage: "@beam/wait",
    versionRange: "1.0.0",
    config: {},
    inputBindings: {
      value: "${graph.parallel.item}",
      durationMs: 0,
    },
    resolvedVersion: "1.0.0",
    checksum: "wait-checksum",
    sourceRegistry: "registry",
    resolvedPlacement: "local-workers",
    required: true,
  };
  return {
    organizationId,
    templateId,
    runId,
    step,
  };
}

async function addWaitStep(
  pool: PgPool,
  fixture: Awaited<ReturnType<typeof seedRun>>,
  stepId: string,
  position: number,
) {
  await pool.query(
    `INSERT INTO workflow.steps (
       id, workflow_template_id, action_package_name, action_version_range,
       position, enabled, input_bindings_json
     ) VALUES ($1, $2, '@beam/wait', '1.0.0', $3, true, '{}'::jsonb)`,
    [stepId, fixture.templateId, position],
  );
  return {
    ...fixture.step,
    id: stepId,
    position,
    inputBindings: {},
  } satisfies ApiWorkflowStep;
}

async function withIsolatedPostgres(callback: (pool: PgPool) => Promise<void>) {
  assert.ok(testDatabaseUrl);
  const priorAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  const source = new URL(testDatabaseUrl);
  const databaseName = `beam_g7_${process.pid}_${Date.now()}`;
  const maintenanceUrl = new URL(source);
  maintenanceUrl.pathname = "/postgres";
  const admin = createPostgresPool(maintenanceUrl.toString());
  let pool: PgPool | null = null;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const isolatedUrl = new URL(source);
    isolatedUrl.pathname = `/${databaseName}`;
    pool = createPostgresPool(isolatedUrl.toString());
    await ensurePostgresMigrations(pool);
    await callback(pool);
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
    if (priorAllow === undefined) {
      delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    } else {
      process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = priorAllow;
    }
  }
}

function testOptions(): OrchestratorOptions {
  return {
    batchSize: 10,
    maxAttempts: 3,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    broker: { async publishTask() {} },
  };
}

function jsonObject(value: unknown): Record<string, ActionJson> {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, ActionJson>;
  }
  return (value ?? {}) as Record<string, ActionJson>;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
