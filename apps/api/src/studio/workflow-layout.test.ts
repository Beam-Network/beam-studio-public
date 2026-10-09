import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { WorkflowLayoutRepository } from "./repositories/workflow-layout-repository.js";
import { organizationScope } from "./repositories/organization-scope.js";

const source =
  process.env.BEAM_TEST_POSTGRES_URL ??
  (process.env.CI ? process.env.DATABASE_URL : undefined);
if (process.env.CI && !source?.startsWith("postgres"))
  throw new Error("Layout acceptance requires isolated PostgreSQL.");

test(
  "layout writes are durable, scoped, revision-fenced, batched and independent of definition saves",
  {
    skip: !source?.startsWith("postgres"),
  },
  async () => {
    const previousAllow = process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
    const previousUrl = process.env.DATABASE_URL;
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const admin = createPostgresPool(source);
    const database = `workflow_layout_${randomBytes(6).toString("hex")}`;
    const globals = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
    };
    const previousPool = globals.__beamStudioPgPool;
    const disconnected: Promise<unknown>[] = [];
    let pool: PgPool | undefined;
    let second: PgPool | undefined;
    let server: FastifyInstance | undefined;
    let restoreAuth: (() => void) | undefined;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      process.env.DATABASE_URL = url.toString();
      pool = createPostgresPool(url.toString());
      second = createPostgresPool(url.toString());
      for (const connections of [pool, second])
        connections.on("connect", (client) =>
          disconnected.push(once(client, "end")),
        );
      await ensurePostgresMigrations(pool);
      globals.__beamStudioPgPool = pool;
      const store = await import("./store.js");
      const child = await store.createWorkflowTemplate({
        organizationId: "layout_a",
        name: "Child",
      });
      const id = await store.createWorkflowTemplate({
        organizationId: "layout_a",
        name: "Parent",
      });
      await store.createWorkflowTemplate({
        organizationId: "layout_b",
        name: "Private",
      });
      const initial = (await store.getWorkflowTemplate(id, "layout_a"))!;
      const step = {
        id: "layout_step",
        kind: "workflow" as const,
        calledWorkflowId: child,
        actionPackageName: "",
        position: 0,
        enabled: true,
        config: {},
        inputBindings: {},
        canvasX: 1,
        canvasY: 2,
        actionVersionRange: "*",
        placement: "dispatcher",
        executionLocationId: null,
        timeoutSeconds: null,
        required: true,
      };
      const definition = {
        organizationId: "layout_a",
        workflowTemplateId: id,
        steps: [step],
        edges: [],
        triggers: initial.triggers,
        triggerEdges: [
          {
            id: "layout_edge",
            triggerId: initial.triggers[0]!.id,
            toStepId: step.id,
            condition: null,
          },
        ],
      };
      await store.updateWorkflowGraph(definition);
      const layouts = new WorkflowLayoutRepository(pool);
      const other = new WorkflowLayoutRepository(second);
      const scope = organizationScope("layout_a");
      const revision = await layouts.revision(scope, id);
      const before = (
        await pool.query(
          "SELECT config_json,graph_json,updated_at FROM workflow.templates WHERE id=$1",
          [id],
        )
      ).rows[0];
      const locks = (
        await pool.query(
          "SELECT * FROM workflow.action_locks WHERE workflow_template_id=$1",
          [id],
        )
      ).rows;
      const changed = await layouts.write(scope, id, {
        revision,
        positions: [{ nodeId: step.id, x: 100, y: 200 }],
      });
      assert.equal(changed.revision, revision + 1);
      assert.deepEqual(
        (await other.read(scope, id)).positions.find(
          (p) => p.nodeId === step.id,
        ),
        { nodeId: step.id, x: 100, y: 200 },
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT config_json,graph_json,updated_at FROM workflow.templates WHERE id=$1",
            [id],
          )
        ).rows[0],
        before,
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT * FROM workflow.action_locks WHERE workflow_template_id=$1",
            [id],
          )
        ).rows,
        locks,
      );
      assert.equal(
        (
          await layouts.write(scope, id, {
            revision: changed.revision,
            positions: [{ nodeId: step.id, x: 100, y: 200 }],
          })
        ).revision,
        changed.revision,
      );
      await assert.rejects(
        other.write(scope, id, {
          revision,
          positions: [{ nodeId: step.id, x: 9, y: 9 }],
        }),
        { code: "workflow_layout_conflict", statusCode: 409 },
      );
      await assert.rejects(layouts.read(organizationScope("layout_b"), id), {
        statusCode: 404,
      });
      await assert.rejects(
        layouts.write(organizationScope("layout_b"), id, {
          revision: changed.revision,
          positions: [],
        }),
        { statusCode: 404 },
      );
      await assert.rejects(
        layouts.write(scope, id, {
          revision: changed.revision,
          positions: [{ nodeId: "missing", x: 1, y: 1 }],
        }),
        { code: "workflow_layout_node_unavailable" },
      );
      await assert.rejects(
        layouts.write(scope, id, {
          revision: changed.revision,
          positions: [],
          config: {},
        }),
        { statusCode: 400 },
      );
      // A stale definition payload cannot undo a newer layout.
      await store.updateWorkflowGraph(definition);
      assert.equal(
        (await other.read(scope, id)).positions.find(
          (p) => p.nodeId === step.id,
        )?.x,
        100,
      );

      // This used to run under the dev auth bypass, which fabricated a
      // SUPERADMIN with no organization verification. The session seam gives
      // the real code path a real principal instead: membership against
      // "layout_a" is checked exactly as it would be in production.
      const { buildServer } = await import("../server.js");
      const { admittedInstance } = await import(
        "../auth/instance-admission.fixture.js"
      );
      const { createStudioBrowserSession, STUDIO_SESSION_COOKIE } =
        await import("../auth/browser-session.js");
      const sessionSecret = "workflow-layout-test-secret";
      const services = {
        oauth: { hasSession: async () => true },
        beamApi: {
          getJson: async (path: string) =>
            path.startsWith("/api/organizations")
              ? {
                  organizations: [
                    { id: "layout_a", role: "admin" },
                    { id: "layout_b", role: "admin" },
                  ],
                }
              : {
                  id: "layout-user",
                  email: "layout@localhost",
                  accountType: "admin",
                },
        },
      };
      server = await buildServer({
        pgPool: pool,
        sessions: {
          get: (cookie: string | null) => (cookie ? services : null),
          // buildServer calls this on close.
          shutdown: () => {},
        } as never,
        // Injected rather than read from the database: this suite runs against
        // a shared PostgreSQL that other suites also write to, so ambient
        // instance state would decide whether a layout test passes.
        admission: admittedInstance(["layout_a", "layout_b"]),
      });
      restoreAuth = () => {};
      const headers = {
        "x-organization-id": "layout_a",
        origin: "http://localhost:5173",
        cookie: `${STUDIO_SESSION_COOKIE}=${createStudioBrowserSession(sessionSecret)}`,
      };
      const firstRead = await server.inject({
        method: "GET",
        url: `/studio/workflows/${id}/layout`,
        headers,
      });
      assert.equal(firstRead.statusCode, 200);
      assert.ok(
        String(firstRead.headers["access-control-expose-headers"]).includes(
          "ETag",
        ),
      );
      const unchanged = await server.inject({
        method: "GET",
        url: `/studio/workflows/${id}/layout`,
        headers: {
          ...headers,
          "if-none-match": String(firstRead.headers.etag),
        },
      });
      assert.equal(unchanged.statusCode, 304);
      assert.equal(unchanged.body, "");
      const moved = await server.inject({
        method: "PATCH",
        url: `/studio/workflows/${id}/layout`,
        headers,
        payload: {
          revision: firstRead.json().revision,
          positions: [{ nodeId: step.id, x: 101, y: 201 }],
        },
      });
      assert.equal(moved.statusCode, 200);
      const latest = await server.inject({
        method: "GET",
        url: `/studio/workflows/${id}/layout`,
        headers: {
          ...headers,
          "if-none-match": String(firstRead.headers.etag),
        },
      });
      assert.equal(latest.statusCode, 200);
      assert.notEqual(latest.headers.etag, firstRead.headers.etag);
      // A member of layout_b, reading a workflow that belongs to layout_a.
      // The session is valid, so a 404 here is organization scoping doing its
      // job rather than authentication refusing the request.
      const forbidden = await server.inject({
        method: "GET",
        url: `/studio/workflows/${id}/layout`,
        headers: { ...headers, "x-organization-id": "layout_b" },
      });
      assert.equal(forbidden.statusCode, 404);
      await server.close();
      server = undefined;
      restoreAuth();
      restoreAuth = undefined;

      // Trigger, decision, primary control and synthetic fan-in coordinates share the writer.
      await pool.query(
        "INSERT INTO workflow.decisions(id,workflow_template_id,name) VALUES('layout_decision',$1,'Decision')",
        [id],
      );
      await pool.query(
        `UPDATE workflow.templates SET graph_json=jsonb_set(graph_json,'{controls}',
      '[{"id":"layout_control","kind":"fan-out","fanInId":"layout_join"}]') WHERE id=$1`,
        [id],
      );
      const current = await layouts.revision(scope, id);
      const positions = [
        initial.triggers[0]!.id,
        "layout_decision",
        "layout_control",
        "layout_join",
      ].map((nodeId, index) => ({ nodeId, x: index + 10, y: index + 20 }));
      await layouts.write(scope, id, { revision: current, positions });
      const snapshot = await other.read(scope, id);
      for (const position of positions)
        assert.deepEqual(
          snapshot.positions.find((p) => p.nodeId === position.nodeId),
          position,
        );
      // A fan-in-only write must initialize the primary layout, preserving valid graph reads.
      await pool.query(
        `UPDATE workflow.templates SET graph_json=jsonb_set(graph_json,'{controls}',
      '[{"id":"layout_control","kind":"fan-out","fanInId":"layout_join"}]') WHERE id=$1`,
        [id],
      );
      await layouts.write(scope, id, {
        revision: snapshot.revision,
        positions: [{ nodeId: "layout_join", x: 33, y: 44 }],
      });
      const control = (
        await pool.query(
          "SELECT graph_json->'controls'->0 AS value FROM workflow.templates WHERE id=$1",
          [id],
        )
      ).rows[0].value;
      assert.deepEqual(control.layout, {
        x: 160,
        y: 420,
        fanInX: 33,
        fanInY: 44,
      });
    } finally {
      await server?.close();
      restoreAuth?.();
      globals.__beamStudioPgPool = previousPool;
      await second?.end();
      await pool?.end();
      await Promise.all(disconnected);
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      if (previousAllow === undefined)
        delete process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE;
      else process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = previousAllow;
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
  },
);
