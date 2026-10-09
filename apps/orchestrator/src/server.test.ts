import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import pino from "pino";
import type { PgPool } from "@beam-studio/db";
import {
  InMemoryMetricExporter,
  Telemetry,
} from "@beam-studio/telemetry";
import { buildServer } from "./server.js";
import { opsAuthToken } from "@beam-studio/shared/ops-auth";

const OPS_SECRET = "0".repeat(64);

test("readiness verifies database, builtin registry, and task publisher", async () => {
  const queries: string[] = [];
  const server = buildServer({
    pgPool: mockPool(queries),
    taskPublisherReady: () => true,
  });
  try {
    const response = await server.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().checks.database, "ok");
    assert.deepEqual(queries, ["SELECT 1"]);
  } finally {
    await server.close();
  }
});

test("a failing readiness check is logged through the service logger", async () => {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line));
      }
      done();
    },
  });
  const server = buildServer({
    pgPool: mockPool([]),
    taskPublisherReady: () => false,
    logger: pino({ level: "info" }, stream),
  });
  try {
    await server.inject({ method: "GET", url: "/health" });
    const response = await server.inject({ method: "GET", url: "/ready" });
    assert.equal(response.statusCode, 500);
  } finally {
    await server.close();
  }
  const failure = lines.find((line) => line.level === 50);
  assert.ok(failure, "the 5xx leaves a server-side trace");
  assert.match(
    String((failure.err as { message?: string })?.message),
    /Task publisher is not ready/,
  );
  assert.ok(
    !lines.some((line) => line.msg === "incoming request"),
    "successful probes are not logged",
  );
});

test("health reports the image's git revision for the API's Ops status", async () => {
  const previous = process.env.BEAM_REVISION;
  const server = buildServer({ pgPool: mockPool([]) });
  try {
    delete process.env.BEAM_REVISION;
    const local = await server.inject({ method: "GET", url: "/health" });
    assert.equal(local.json().revision, null);
    process.env.BEAM_REVISION = "89abcdef0123456789abcdef0123456789abcdef";
    const built = await server.inject({ method: "GET", url: "/health" });
    assert.equal(built.json().revision, "89abcdef0123456789abcdef0123456789abcdef");
  } finally {
    if (previous === undefined) delete process.env.BEAM_REVISION;
    else process.env.BEAM_REVISION = previous;
    await server.close();
  }
});

test("health reports the live service configuration for the Ops API", async () => {
  const status = {
    version: 4,
    applied: { ORCHESTRATOR_BATCH_SIZE: 50 },
    deployed: { ORCHESTRATOR_BATCH_SIZE: "25" },
    pendingRestart: [],
    rejected: [],
  };
  const reporting = buildServer({
    pgPool: mockPool([]),
    liveConfig: { instanceId: "orchestrator-1", status: () => status },
  });
  const bare = buildServer({ pgPool: mockPool([]) });
  try {
    const health = (await reporting.inject({ method: "GET", url: "/health" })).json();
    assert.equal(health.instanceId, "orchestrator-1");
    assert.deepEqual(health.config, status);
    const without = (await bare.inject({ method: "GET", url: "/health" })).json();
    assert.equal(without.instanceId, null);
    assert.equal(without.config, null);
  } finally {
    await reporting.close();
    await bare.close();
  }
});

test("metrics endpoint exposes worker load gauges", async () => {
  const server = buildServer({ pgPool: mockPool([]) });
  try {
    const response = await server.inject({ method: "GET", url: "/metrics" });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /beam_orchestrator_worker_load_score 0\.25/);
    assert.match(response.body, /beam_orchestrator_active_workers 2/);
    assert.match(response.body, /beam_orchestrator_command_outbox_pending 3/);
  } finally {
    await server.close();
  }
});

test("operational endpoints fail safely when the in-memory exporter is unavailable", async () => {
  const exporter = new InMemoryMetricExporter();
  const telemetry = new Telemetry("orchestrator", { metricExporter: exporter });
  const server = buildServer({ pgPool: mockPool([]), telemetry });
  try {
    assert.equal(
      (await server.inject({ method: "GET", url: "/health" })).statusCode,
      200,
    );
    exporter.failure = new Error("offline");
    assert.equal(
      (await server.inject({ method: "GET", url: "/health" })).statusCode,
      503,
    );
    const metrics = await server.inject({ method: "GET", url: "/metrics" });
    assert.equal(metrics.statusCode, 503);
    assert.equal(metrics.body, "metrics unavailable\n");
  } finally {
    await server.close();
  }
});

function mockPool(queries: string[]): PgPool {
  return {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("runtime.worker_runtime_state")) {
        return {
          rows: [
            {
              active_worker_count: "2",
              active_task_count: "4",
              average_load_score: "0.25",
            },
          ],
        };
      }
      if (sql.includes("execution.command_outbox")) {
        return {
          rows: [
            {
              pending_count: "3",
              publishing_count: "1",
              pending_with_error_count: "2",
              oldest_unpublished_seconds: "7",
            },
          ],
        };
      }
      return { rows: [{ "?column?": 1 }] };
    },
  } as PgPool;
}

test("operational routes require the ops token from off-host callers", async () => {
  const previous = process.env.BEAM_STUDIO_SECRET_KEY;
  process.env.BEAM_STUDIO_SECRET_KEY = OPS_SECRET;
  const server = buildServer({
    pgPool: mockPool([]),
    taskPublisherReady: () => true,
  });
  try {
    // /health is what a container healthcheck calls, and it runs inside the
    // container, so it stays open. Everything else is operational data.
    const health = await server.inject({
      method: "GET",
      url: "/health",
      remoteAddress: "203.0.113.9",
    });
    assert.notEqual(health.statusCode, 401);

    for (const url of ["/ready", "/metrics", "/workers/load"]) {
      const refused = await server.inject({
        method: "GET",
        url,
        remoteAddress: "203.0.113.9",
      });
      assert.equal(refused.statusCode, 401, `${url} must require the token`);
      assert.equal(refused.json().code, "ops_authentication_required");

      const allowed = await server.inject({
        method: "GET",
        url,
        remoteAddress: "203.0.113.9",
        headers: { authorization: `Bearer ${opsAuthToken()}` },
      });
      assert.notEqual(allowed.statusCode, 401, `${url} must accept the token`);
    }
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.BEAM_STUDIO_SECRET_KEY;
    else process.env.BEAM_STUDIO_SECRET_KEY = previous;
  }
});

test("a container healthcheck from inside the container still works", async () => {
  const server = buildServer({
    pgPool: mockPool([]),
    taskPublisherReady: () => true,
  });
  try {
    for (const url of ["/health", "/ready"]) {
      const response = await server.inject({
        method: "GET",
        url,
        remoteAddress: "127.0.0.1",
      });
      assert.notEqual(response.statusCode, 401, url);
    }
  } finally {
    await server.close();
  }
});
