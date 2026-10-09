import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pgMany,
  pgOne,
} from "@beam-studio/db";
import {
  testDatabaseUrl,
  seedDynamicRun,
  withIsolatedStore,
} from "./dynamic-regions.fixture.js";

test(
  "retries only failed wait shards and cancels only the selected wait region",
  { skip: !testDatabaseUrl },
  async () => {
    await withIsolatedStore(async (pool, store) => {
      await seedDynamicRun(pool);

      const page = await store.listWorkflowDynamicInstances({
        workflowRunId: "wfr_retry",
        controlId: "parallel_retry",
        organizationId: "org_g7_api",
        offset: 1,
        limit: 2,
      });
      assert.equal(page?.total, 3);
      assert.deepEqual(
        page?.instances.map((instance) => instance.instanceIndex),
        [1, 2],
      );

      const retried = await store.retryWorkflowDynamicRegion({
        authorizeExecution: async () => {},
        workflowRunId: "wfr_retry",
        controlId: "parallel_retry",
        organizationId: "org_g7_api",
        requestedBy: "user_g7",
      });
      assert.equal(retried.status, "running");

      const retryInstances = await pgMany<Record<string, unknown>>(
        pool,
        `SELECT instance_index, status, current_attempt
         FROM execution.workflow_dynamic_instances
         WHERE workflow_run_id = 'wfr_retry' ORDER BY instance_index`,
      );
      assert.deepEqual(retryInstances, [
        { instance_index: 0, status: "completed", current_attempt: 1 },
        { instance_index: 1, status: "queued", current_attempt: 2 },
        { instance_index: 2, status: "completed", current_attempt: 1 },
      ]);
      const retryTasks = await pgMany<Record<string, unknown>>(
        pool,
        `SELECT task.id, task.status
         FROM execution.workflow_tasks task
         JOIN execution.workflow_step_runs step_run ON step_run.id = task.workflow_step_run_id
         JOIN execution.workflow_dynamic_instances instance ON instance.id = step_run.dynamic_instance_id
         WHERE instance.workflow_run_id = 'wfr_retry'
         ORDER BY instance.instance_index`,
      );
      assert.deepEqual(retryTasks, [
        { id: "task_retry_0", status: "completed" },
        { id: "task_retry_1", status: "retry_scheduled" },
        { id: "task_retry_2", status: "completed" },
      ]);

      const cancelled = await store.cancelWorkflowDynamicRegion({
        workflowRunId: "wfr_cancel",
        controlId: "parallel_cancel",
        organizationId: "org_g7_api",
        requestedBy: "user_g7",
      });
      assert.equal(cancelled.status, "cancel_requested");
      const requested = await pgOne<Record<string, unknown>>(
        pool,
        "SELECT cancellation_requested_at, requested_by FROM execution.workflow_dynamic_regions WHERE id='region_cancel'",
      );
      const cancelledAgain = await store.cancelWorkflowDynamicRegion({
        workflowRunId: "wfr_cancel",
        controlId: "parallel_cancel",
        organizationId: "org_g7_api",
        requestedBy: "user_g7",
      });
      assert.deepEqual(cancelledAgain, cancelled);
      assert.deepEqual(
        await pgOne<Record<string, unknown>>(
          pool,
          "SELECT cancellation_requested_at, requested_by FROM execution.workflow_dynamic_regions WHERE id='region_cancel'",
        ),
        requested,
      );
      const regions = await pgMany<Record<string, unknown>>(
        pool,
        `SELECT control_id, status FROM execution.workflow_dynamic_regions
         WHERE workflow_run_id = 'wfr_cancel' ORDER BY control_id`,
      );
      assert.deepEqual(regions, [
        { control_id: "parallel_cancel", status: "cancel_requested" },
        { control_id: "parallel_unrelated", status: "running" },
      ]);
      const unrelated = await pgOne<Record<string, unknown>>(
        pool,
        `SELECT status FROM execution.workflow_dynamic_instances
         WHERE id = 'dyn_unrelated'`,
      );
      assert.equal(unrelated?.status, "pending");
      assert.deepEqual(
        await pgMany<Record<string, unknown>>(
          pool,
          "SELECT id,status FROM execution.workflow_dynamic_instances WHERE dynamic_region_id='region_cancel' ORDER BY id",
        ),
        [
          { id: "dyn_cancel_0", status: "cancelled" },
          { id: "dyn_cancel_1", status: "cancelled" },
        ],
      );
      assert.equal(
        (
          await pgOne<Record<string, unknown>>(
            pool,
            "SELECT status FROM execution.workflow_tasks WHERE id='task_cancel_0'",
          )
        )?.status,
        "cancelled",
      );
      assert.equal(
        (
          await pgOne<Record<string, unknown>>(
            pool,
            "SELECT status FROM execution.workflow_step_runs WHERE id='wsr_cancel_0'",
          )
        )?.status,
        "cancelled",
      );

      const events = await pgMany<Record<string, unknown>>(
        pool,
        `SELECT event_type, payload_json->>'requestedBy' AS requested_by
         FROM execution.workflow_events
         WHERE workflow_run_id IN ('wfr_retry', 'wfr_cancel')
         ORDER BY created_at`,
      );
      assert.deepEqual(events, [
        {
          event_type: "DynamicRegionRetryRequested",
          requested_by: "user_g7",
        },
        {
          event_type: "DynamicRegionCancellationRequested",
          requested_by: "user_g7",
        },
      ]);
    });
  },
);
