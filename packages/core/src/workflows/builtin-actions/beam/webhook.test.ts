import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { afterEach } from "node:test";
import { ActionExecutionError, ActionInputError } from "../../actions.js";
import { runActionHarness } from "../../harness.js";
import {
  callbackEnvelope,
  deliver,
  signCallback,
  webhookAction,
  webhookActionManifest,
} from "./webhook.js";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(
  responses: Array<{ status?: number; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  let index = 0;
  const impl = (async (url: string, init: RequestInit) => {
    const next = responses[index] ?? responses.at(-1)!;
    index += 1;
    calls.push({
      url: String(url),
      method: String(init.method ?? "GET"),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: String(init.body ?? ""),
    });
    return new Response("", {
      status: next.status ?? 200,
      headers: next.headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const credentialId = "cred_http";
const secrets = { [credentialId]: JSON.stringify({ token: "tok_abc" }) };

test("posts the callback envelope and reports the response status", async () => {
  const { impl, calls } = stubFetch([{ status: 202 }]);
  globalThis.fetch = impl;

  const result = await runActionHarness(
    webhookAction.execute,
    {
      config: { url: "https://hooks.example.com/beam" },
      inputs: { event: "transfer.completed", payload: { name: "nightly" } },
    },
    { stepRunId: "wsr_1" },
  );

  assert.equal(result.outputs?.delivered, true);
  assert.equal(result.outputs?.status, 202);
  assert.equal(result.outputs?.requestId, "wsr_1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  assert.equal(body.event, "transfer.completed");
  assert.equal(body.workflowRunId, "wfr_harness");
  assert.equal(body.stepRunId, "wsr_1");
  assert.deepEqual(body.data, { name: "nightly" });
  assert.equal(typeof body.occurredAt, "string");
});

test("the step run is the idempotency key, so every attempt sends the same one", async () => {
  const { impl, calls } = stubFetch([{ status: 200 }]);
  globalThis.fetch = impl;

  await runActionHarness(
    webhookAction.execute,
    { config: { url: "https://hooks.example.com/beam" } },
    { stepRunId: "wsr_stable" },
  );

  assert.equal(calls[0]!.headers["Idempotency-Key"], "wsr_stable");
});

test("a bound credential authenticates and signs the body", async () => {
  const { impl, calls } = stubFetch([{ status: 200 }]);
  globalThis.fetch = impl;

  await runActionHarness(
    webhookAction.execute,
    { config: { url: "https://hooks.example.com/beam", credentialId } },
    { secrets },
  );

  const headers = calls[0]!.headers;
  assert.equal(headers.Authorization, "Bearer tok_abc");

  const signature = headers["X-Beam-Signature"] ?? "";
  const [timestampPart, digestPart] = signature.split(",");
  const timestamp = timestampPart!.slice("t=".length);
  const expected = createHmac("sha256", "tok_abc")
    .update(`${timestamp}.${calls[0]!.body}`)
    .digest("hex");
  assert.equal(digestPart, `v1=${expected}`);
});

test("a separate signing secret is preferred over the bearer token", async () => {
  const { impl, calls } = stubFetch([{ status: 200 }]);
  globalThis.fetch = impl;

  await runActionHarness(
    webhookAction.execute,
    { config: { url: "https://hooks.example.com/beam", credentialId } },
    {
      secrets: {
        [credentialId]: JSON.stringify({
          token: "tok_abc",
          signing_secret: "shh",
        }),
      },
    },
  );

  const signature = calls[0]!.headers["X-Beam-Signature"] ?? "";
  const timestamp = signature.split(",")[0]!.slice("t=".length);
  assert.ok(
    signature.endsWith(
      `v1=${signCallback(calls[0]!.body, "shh", Number(timestamp)).split("v1=")[1]}`,
    ),
  );
});

test("no credential means no Authorization and no signature", async () => {
  const { impl, calls } = stubFetch([{ status: 200 }]);
  globalThis.fetch = impl;

  await runActionHarness(webhookAction.execute, {
    config: { url: "https://hooks.example.com/beam" },
  });

  assert.equal(calls[0]!.headers.Authorization, undefined);
  assert.equal(calls[0]!.headers["X-Beam-Signature"], undefined);
});

test("a recorded delivery short-circuits a retry instead of firing twice", async () => {
  const { impl, calls } = stubFetch([{ status: 200 }]);
  globalThis.fetch = impl;

  const result = await runActionHarness(
    webhookAction.execute,
    { config: { url: "https://hooks.example.com/beam" } },
    {
      stepRunId: "wsr_done",
      initialState: {
        webhook: {
          requestId: "wsr_done",
          delivered: true,
          status: 204,
          respondedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
  );

  assert.equal(calls.length, 0);
  assert.equal(result.outputs?.status, 204);
  assert.equal(result.outputs?.delivered, true);
});

test("state recorded for a different step run does not suppress delivery", async () => {
  const { impl, calls } = stubFetch([{ status: 200 }]);
  globalThis.fetch = impl;

  await runActionHarness(
    webhookAction.execute,
    { config: { url: "https://hooks.example.com/beam" } },
    {
      stepRunId: "wsr_new",
      initialState: {
        webhook: { requestId: "wsr_old", delivered: true, status: 200 },
      },
    },
  );

  assert.equal(calls.length, 1);
});

test("an attempt recorded without an outcome is resent", async () => {
  const { impl, calls } = stubFetch([{ status: 200 }]);
  globalThis.fetch = impl;

  await runActionHarness(
    webhookAction.execute,
    { config: { url: "https://hooks.example.com/beam" } },
    {
      stepRunId: "wsr_unknown",
      initialState: {
        webhook: {
          requestId: "wsr_unknown",
          attemptedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
  );

  assert.equal(calls.length, 1);
});

test("a missing URL raises rather than reporting a silent non-delivery", async () => {
  await assert.rejects(
    () => runActionHarness(webhookAction.execute, { config: {} }),
    ActionInputError,
  );
});

test("a non-HTTP URL is refused", async () => {
  await assert.rejects(
    () =>
      runActionHarness(webhookAction.execute, {
        config: { url: "file:///etc/passwd" },
      }),
    ActionInputError,
  );
});

test("an unsupported method is refused", async () => {
  await assert.rejects(
    () =>
      runActionHarness(webhookAction.execute, {
        config: { url: "https://hooks.example.com/beam", method: "DELETE" },
      }),
    ActionInputError,
  );
});

test("5xx retries and 4xx does not", async () => {
  const sleeps: number[] = [];
  const options = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  };
  const request = {
    url: "https://hooks.example.com/beam",
    method: "POST",
    body: "{}",
    requestId: "wsr_retry",
    credential: null,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  };

  const retried = stubFetch([{ status: 503 }, { status: 200 }]);
  const ok = await deliver(request, { ...options, fetchImpl: retried.impl });
  assert.equal(ok.status, 200);
  assert.equal(retried.calls.length, 2);
  assert.equal(sleeps.length, 1);

  const refused = stubFetch([{ status: 400 }]);
  await assert.rejects(
    () => deliver(request, { ...options, fetchImpl: refused.impl }),
    (error: unknown) =>
      error instanceof ActionExecutionError && error.retryable === false,
  );
  assert.equal(refused.calls.length, 1);
});

test("Retry-After outranks the computed backoff", async () => {
  const sleeps: number[] = [];
  const { impl } = stubFetch([
    { status: 429, headers: { "retry-after": "7" } },
    { status: 200 },
  ]);

  await deliver(
    {
      url: "https://hooks.example.com/beam",
      method: "POST",
      body: "{}",
      requestId: "wsr_429",
      credential: null,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    },
    {
      fetchImpl: impl,
      random: () => 0.5,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  );

  assert.deepEqual(sleeps, [7_000]);
});

test("the envelope carries the run identity alongside the payload", () => {
  const envelope = callbackEnvelope({
    event: "step.failed",
    payload: { error: "boom" },
    context: {
      workflowRunId: "wfr_1",
      stepRunId: "wsr_1",
      stepId: "step_1",
      attempt: 2,
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.deepEqual(envelope, {
    event: "step.failed",
    occurredAt: "2026-01-01T00:00:00.000Z",
    workflowRunId: "wfr_1",
    stepRunId: "wsr_1",
    stepId: "step_1",
    attempt: 2,
    data: { error: "boom" },
  });
});

test("the manifest declares only permissions a default worker allows", () => {
  assert.deepEqual(webhookActionManifest.permissions, [
    "network:http",
    "secrets:read",
  ]);
  const requirement = webhookActionManifest.catalog.credentialRequirements?.[0];
  assert.equal(requirement?.required, false);
  assert.deepEqual(requirement?.acceptedCredentialTypes, ["http_bearer_token"]);
});
