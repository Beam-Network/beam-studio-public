import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  withPostgresTransaction,
  type PgPool,
} from "@beam-studio/db";
import {
  resolveWorkflowGraphV3,
  type WorkflowGraphV3Definition,
} from "@beam-studio/core";
import {
  createFrozenRoomStepRunPg,
  workflowStepFromSnapshot,
} from "./postgresOrchestration.js";

const source = process.env.BEAM_TEST_POSTGRES_URL;
const database = `logical_partitions_${randomBytes(6).toString("hex")}`;
const graph = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/core/src/workflows/fixtures/distributed-graph-v3.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as WorkflowGraphV3Definition;
let pool: PgPool;
let maintenance: PgPool;

before(async () => {
  if (!source) return;
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  maintenance = createPostgresPool(source);
  await maintenance.query(`CREATE DATABASE ${database}`);
  const url = new URL(source);
  url.pathname = `/${database}`;
  pool = createPostgresPool(url.toString());
  await ensurePostgresMigrations(pool);
  await pool.query(`
    INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Partition test');
    INSERT INTO workflow.templates(id,organization_id,name) VALUES('workflow','org','Map');
    INSERT INTO workflow.steps(id,workflow_template_id,kind,action_package_name,action_version_range,position)
      VALUES('prepare','workflow','action','@test/compute','1.0.0',0);
    INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status,resolved_steps_json)
      VALUES('run','org','workflow','running','[]'::jsonb);
  `);
});

after(async () => {
  await pool?.end();
  if (maintenance) {
    await maintenance.query(`DROP DATABASE IF EXISTS ${database}`);
    await maintenance.end();
  }
});

test(
  "a frozen V3 cohort persists 100 stable map tasks and the admission limit",
  { skip: !source },
  async () => {
    const step = workflowStepFromSnapshot(
      {
        id: "prepare",
        actionPackage: "@test/compute",
        versionRange: "1.0.0",
        resolvedVersion: "1.0.0",
        checksum: "checksum",
        sourceRegistry: "registry",
        resolvedPlacement: "room-members",
        executionTarget: {
          kind: "room-member",
          memberIds: ["member_a", "member_b", "member_c"],
          channelId: "requests",
          requesterMemberId: "requester",
        },
      },
      0,
    );
    const input = {
      documents: Array.from({ length: 100 }, (_, index) => index),
    };
    const graphSteps = [
      { id: "prepare", enabled: true },
      { id: "transfer", enabled: true },
    ];
    const membersByPartition = {
      participants: [
        { memberId: "member_a" },
        { memberId: "member_b" },
        { memberId: "member_c" },
      ],
    };
    const resolvedTasks = resolveWorkflowGraphV3(
      graph,
      graphSteps,
      membersByPartition,
    ).tasks;
    // The full resolved graph may also contain an explicit collection step.
    resolvedTasks.push({
      stepId: "collect",
      memberId: "coordinator",
      index: 0,
      placement: "studio",
    });
    const create = () =>
      withPostgresTransaction(pool, (client) =>
        createFrozenRoomStepRunPg(client, {
          workflowRunId: "run",
          organizationId: "org",
          step,
          inputs: input,
          maxAttempts: 3,
          options: {
            batchSize: 10,
            maxAttempts: 3,
            broker: { async publishTask() {} },
            logger: { info() {}, warn() {}, error() {} },
            authorizeExecution: async () => {},
          },
          resolvedTasks,
          distribution: { kind: "input-partitions", inputKey: "documents" },
          maxParallelism: 3,
        }),
      );
    await create();
    await create();
    const tasks = (
      await pool.query<{
        id: string;
        shard_index: number;
        metadata_json: {
          logicalPartition: {
            id: string;
            eligibleMemberIds: string[];
          };
        };
      }>(
        "SELECT id,shard_index,metadata_json FROM execution.workflow_tasks WHERE workflow_run_id='run' ORDER BY shard_index",
      )
    ).rows;
    assert.equal(tasks.length, 100);
    assert.equal(new Set(tasks.map((task) => task.id)).size, 100);
    assert.deepEqual(
      tasks.map((task) => task.shard_index),
      Array.from({ length: 100 }, (_, index) => index),
    );
    assert.deepEqual(
      tasks.map((task) => task.metadata_json.logicalPartition.id),
      Array.from({ length: 100 }, (_, index) => `partition:${index}`),
    );
    assert.ok(
      tasks.every(
        (task) =>
          task.metadata_json.logicalPartition.eligibleMemberIds.join(",") ===
          "member_a,member_b,member_c",
      ),
    );
    const plan = (
      await pool.query<{
        shard_count: number;
        metadata_json: { maxParallelism: number };
        plan_json: {
          selectedMemberIds: string[];
          logicalPartitionIds: string[];
        };
      }>(
        "SELECT shard_count,metadata_json,plan_json FROM execution.execution_plans WHERE workflow_run_id='run'",
      )
    ).rows[0]!;
    assert.equal(plan.shard_count, 100);
    assert.equal(plan.metadata_json.maxParallelism, 3);
    assert.deepEqual(plan.plan_json.selectedMemberIds, [
      "member_a",
      "member_b",
      "member_c",
    ]);
    assert.equal(plan.plan_json.logicalPartitionIds.length, 100);
  },
);
