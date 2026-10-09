import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import type { WorkflowGraphV3Definition } from "@beam-studio/core";

const source =
  process.env.BEAM_TEST_POSTGRES_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
if (process.env.CI && !source?.startsWith("postgres"))
  throw new Error(
    "Distributed graph authoring acceptance requires isolated PostgreSQL.",
  );

test(
  "V3 graph authoring round-trips distribution and refuses an unsupported launch",
  {
    skip: !source?.startsWith("postgres"),
  },
  async () => {
    const originalUrl = process.env.DATABASE_URL;
    const originalAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const globals = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
    };
    const previousPool = globals.__beamStudioPgPool;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `workflow_distribution_${randomBytes(6).toString("hex")}`;
    let pool: PgPool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString());
      await ensurePostgresMigrations(pool);
      globals.__beamStudioPgPool = pool;
      const store = await import("./store.js");
      const childId = await store.createWorkflowTemplate({
        organizationId: "org_distribution",
        name: "Child",
      });
      const workflowTemplateId = await store.createWorkflowTemplate({
        organizationId: "org_distribution",
        name: "Distributed",
      });
      const initial = (await store.getWorkflowTemplate(
        workflowTemplateId,
        "org_distribution",
      ))!;
      const fixture = JSON.parse(
        readFileSync(
          new URL(
            "../../../../packages/core/src/workflows/fixtures/distributed-graph-v3.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as WorkflowGraphV3Definition;
      const steps = fixture.distribution.steps.map((distribution, index) => ({
        id: distribution.stepId,
        kind: "workflow" as const,
        calledWorkflowId: childId,
        actionPackageName: "",
        actionVersionRange: "*",
        position: index,
        enabled: true,
        config: {},
        inputBindings: {},
        placement: "dispatcher",
        executionLocationId: null,
        canvasX: null,
        canvasY: null,
        timeoutSeconds: null,
        required: true,
      }));
      const edges = [
        {
          id: randomUUID(),
          fromStepId: "prepare",
          toStepId: "transfer",
          condition: null,
        },
      ];
      const write = {
        organizationId: "org_distribution",
        workflowTemplateId,
        graphVersion: fixture.version,
        distribution: fixture.distribution,
        controls: fixture.controls,
        steps,
        edges,
        triggers: initial.triggers,
        triggerEdges: [
          {
            id: randomUUID(),
            triggerId: initial.triggers[0]!.id,
            toStepId: "prepare",
            condition: null,
          },
        ],
      };
      const { webEnv } = await import("../env.js");
      webEnv.roomWorkflowsEnabled = false;
      await assert.rejects(
        store.updateWorkflowGraph(write),
        /Distributed workflows are not available yet/,
      );
      webEnv.roomWorkflowsEnabled = true;
      const saved = (await store.updateWorkflowGraph(write))!;
      assert.equal(saved.template.graphVersion, "workflow-graph/v3");
      assert.deepEqual(
        (saved.graph as WorkflowGraphV3Definition).distribution,
        fixture.distribution,
      );
      assert.deepEqual(
        (
          (await store.getWorkflowTemplate(
            workflowTemplateId,
            "org_distribution",
          ))!.graph as WorkflowGraphV3Definition
        ).distribution,
        fixture.distribution,
      );
      const updated = (await store.updateWorkflowGraph({
        ...write,
        distribution: undefined,
      }))!;
      assert.deepEqual(
        (updated.graph as WorkflowGraphV3Definition).distribution,
        fixture.distribution,
      );
      const copyId = await store.duplicateWorkflowTemplate({
        id: workflowTemplateId,
        organizationId: "org_distribution",
      });
      const copy = (await store.getWorkflowTemplate(
        copyId,
        "org_distribution",
      ))!;
      const copiedDistribution = (copy.graph as WorkflowGraphV3Definition)
        .distribution;
      assert.equal(copy.template.graphVersion, "workflow-graph/v3");
      assert.deepEqual(
        copiedDistribution.partitions,
        fixture.distribution.partitions,
      );
      assert.deepEqual(
        copiedDistribution.steps.map((step) => step.stepId),
        copy.steps.map((step) => step.id),
      );
      assert.deepEqual(
        copiedDistribution.routes.map((route) => [
          route.from.stepId,
          route.to.stepId,
        ]),
        [[copy.steps[0]!.id, copy.steps[1]!.id]],
      );
      await assert.rejects(
        store.updateWorkflowGraph({
          ...write,
          graphVersion: "workflow-graph/v2",
        }),
        /cannot be downgraded/,
      );
      await assert.rejects(
        store.startWorkflowRun(workflowTemplateId, "org_distribution"),
        /execution is pending distributed task orchestration/,
      );
    } finally {
      globals.__beamStudioPgPool = previousPool;
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = originalAllow;
    }
  },
);
