import assert from "node:assert/strict";
import test from "node:test";
import { MetricRegistry } from "./metrics.js";
import { REDACTED, redactTelemetryValue } from "./redaction.js";
import {
  Telemetry,
  InMemoryLogExporter,
  InMemoryMetricExporter,
  InMemoryTraceExporter,
} from "./telemetry.js";
import { formatTraceparent, parseTraceparent } from "./trace-context.js";

test("metric schemas reject ID labels and cap series cardinality", () => {
  assert.throws(
    () =>
      new MetricRegistry([
        {
          name: "bad",
          help: "bad",
          kind: "counter",
          labels: ["workflow_run_id"],
        },
      ]),
  );
  const metrics = new MetricRegistry(undefined, 2);
  metrics.add("beam_api_requests_total", 1, {
    method: "get",
    route: "/one",
    status_class: "2xx",
  });
  metrics.add("beam_api_requests_total", 1, {
    method: "get",
    route: "/two",
    status_class: "2xx",
  });
  metrics.add("beam_api_requests_total", 1, {
    method: "get",
    route: "/three",
    status_class: "2xx",
  });
  const points = metrics
    .snapshot()
    .filter((point) => point.name === "beam_api_requests_total");
  assert.equal(points.length, 3);
  assert.equal(points.at(-1)?.labels.route, "overflow");
  assert.throws(() =>
    metrics.add("beam_api_requests_total", 1, {
      method: "get",
      route: "/",
      status_class: "2xx",
      user_id: "u1",
    }),
  );
});

test("trace relationships preserve W3C identity and redact secrets and signed URLs", async () => {
  const traces = new InMemoryTraceExporter();
  const logs = new InMemoryLogExporter();
  const telemetry = new Telemetry("api", {
    traceExporter: traces,
    logExporter: logs,
  });
  const root = telemetry.startSpan("api.request", {
    correlationId: "wfr_wait",
  });
  const parsed = parseTraceparent(formatTraceparent(root.context), "wfr_wait");
  assert.ok(parsed);
  const child = telemetry.startSpan("workflow.run", {
    parent: parsed,
    attributes: {
      workflowRunId: "wfr_wait",
      secretAccessKey: "nope",
      artifactUrl: "https://example.test/file?X-Amz-Signature=nope",
    },
  });
  telemetry.log(
    "info",
    "worker action",
    { api_token: "nope", workflowRunId: "wfr_wait" },
    child.context,
  );
  child.end();
  root.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    traces.spans[0]?.context.traceId,
    traces.spans[1]?.context.traceId,
  );
  assert.equal(traces.spans[0]?.parentSpanId, root.context.spanId);
  assert.equal(traces.spans[0]?.attributes.secretAccessKey, REDACTED);
  assert.equal(traces.spans[0]?.attributes.artifactUrl, REDACTED);
  assert.equal(logs.logs[0]?.attributes.api_token, REDACTED);
  assert.equal(
    JSON.stringify({ spans: traces.spans, logs: logs.logs }).includes("nope"),
    false,
  );
});

test("in-memory metric exporter reports unavailability without losing local metrics", async () => {
  const exporter = new InMemoryMetricExporter();
  const telemetry = new Telemetry("worker", { metricExporter: exporter });
  telemetry.add("beam_workflow_task_claims_total", 1, {
    task_kind: "step",
    action_source: "builtin",
  });
  assert.match(
    await telemetry.exportMetrics(),
    /beam_workflow_task_claims_total/,
  );
  exporter.failure = new Error("exporter offline");
  await assert.rejects(() => telemetry.exportMetrics(), /exporter offline/);
  assert.match(
    telemetry.metrics.renderPrometheus(),
    /beam_workflow_task_claims_total/,
  );
});

test("trace and log exporter failures cannot change runtime behavior", async () => {
  const traces = new InMemoryTraceExporter();
  const logs = new InMemoryLogExporter();
  traces.failure = new Error("trace offline");
  logs.failure = new Error("log offline");
  const telemetry = new Telemetry("worker", {
    traceExporter: traces,
    logExporter: logs,
  });

  assert.doesNotThrow(() => {
    telemetry.startSpan("workflow.task", { correlationId: "wfr_wait" }).end();
    telemetry.log("error", "action failed", { secret: "hidden" });
  });
  await assert.rejects(() => telemetry.check(), /offline/);
});

test("the instance claim code is a secret under any key spelling", () => {
  for (const key of [
    "claimCode",
    "claim_code",
    "claim-code",
    "request.claimCode",
  ]) {
    assert.equal(redactTelemetryValue("BSC-7F3K-92QX", key), REDACTED, key);
  }
  // Only the claim code itself; neighbouring words stay readable.
  assert.equal(redactTelemetryValue("claimed", "state"), "claimed");
  assert.equal(redactTelemetryValue("x", "claimedAt"), "x");
});
