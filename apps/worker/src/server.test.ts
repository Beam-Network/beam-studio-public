import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import {
  InMemoryMetricExporter,
  Telemetry,
} from "@beam-studio/telemetry";
import { buildWorkerServer } from "./services/server.js";

test("worker health and metrics fail safely when the in-memory exporter is unavailable", async () => {
  const exporter = new InMemoryMetricExporter();
  const telemetry = new Telemetry("worker", { metricExporter: exporter });
  const pool = {
    async query() {
      return { rows: [{ ok: 1 }] };
    },
  } as unknown as PgPool;
  const server = buildWorkerServer({ pgPool: pool, telemetry });
  try {
    assert.equal(
      (await server.inject({ method: "GET", url: "/health" })).statusCode,
      200,
    );
    assert.equal(
      (await server.inject({ method: "GET", url: "/metrics" })).statusCode,
      200,
    );
    exporter.failure = new Error("offline");
    assert.equal(
      (await server.inject({ method: "GET", url: "/health" })).statusCode,
      503,
    );
    assert.equal(
      (await server.inject({ method: "GET", url: "/metrics" })).statusCode,
      503,
    );
  } finally {
    await server.close();
  }
});
