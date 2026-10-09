import assert from "node:assert/strict";
import test from "node:test";
import { ActionExecutionError } from "../../../actions.js";
import {
  backoffMs,
  describeFailure,
  retryAfterMs,
  salesforceFetch,
} from "./http.js";

/** Fetch stub returning a queued sequence, recording how often it was called. */
function stubFetch(
  responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>,
) {
  const calls: number[] = [];
  const impl = (async () => {
    const next = responses[calls.length] ?? responses[responses.length - 1]!;
    calls.push(next.status);
    return new Response(next.body ?? "", {
      status: next.status,
      headers: next.headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noWait = {
  sleep: async () => {},
  random: () => 0.5,
  baseDelayMs: 1,
};

test("returns the body on success without retrying", async () => {
  const { impl, calls } = stubFetch([{ status: 200, body: '{"ok":true}' }]);
  const response = await salesforceFetch(
    { url: "https://example.test/x", accessToken: "t" },
    { ...noWait, fetchImpl: impl },
  );
  assert.equal(response.status, 200);
  assert.equal(response.text, '{"ok":true}');
  assert.equal(calls.length, 1);
});

test("retries 429 and 5xx, then succeeds", async () => {
  const { impl, calls } = stubFetch([
    { status: 429 },
    { status: 503 },
    { status: 200, body: "done" },
  ]);
  const response = await salesforceFetch(
    { url: "https://example.test/x", accessToken: "t" },
    { ...noWait, fetchImpl: impl },
  );
  assert.equal(response.text, "done");
  assert.deepEqual(calls, [429, 503, 200]);
});

test("never retries an ordinary 4xx", async () => {
  const { impl, calls } = stubFetch([
    { status: 400, body: '[{"errorCode":"MALFORMED_QUERY","message":"bad soql"}]' },
  ]);
  await assert.rejects(
    salesforceFetch(
      { url: "https://example.test/x", accessToken: "t" },
      { ...noWait, fetchImpl: impl },
    ),
    (error: ActionExecutionError) => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /MALFORMED_QUERY/);
      return true;
    },
  );
  assert.equal(calls.length, 1, "a 4xx must not be retried");
});

test("treats REQUEST_LIMIT_EXCEEDED as terminal", async () => {
  // Arrives as a 403, but retrying spends the org's remaining daily calls on
  // attempts that cannot succeed.
  const { impl, calls } = stubFetch([
    {
      status: 403,
      body: '[{"errorCode":"REQUEST_LIMIT_EXCEEDED","message":"TotalRequests Limit exceeded."}]',
    },
  ]);
  await assert.rejects(
    salesforceFetch(
      { url: "https://example.test/x", accessToken: "t" },
      { ...noWait, fetchImpl: impl },
    ),
    (error: ActionExecutionError) => {
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("gives up after maxAttempts and reports the last failure", async () => {
  const { impl, calls } = stubFetch([{ status: 503 }]);
  await assert.rejects(
    salesforceFetch(
      { url: "https://example.test/x", accessToken: "t" },
      { ...noWait, fetchImpl: impl, maxAttempts: 3 },
    ),
    (error: ActionExecutionError) => {
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(calls.length, 3);
});

test("classifies a transport failure as retryable with a legible message", async () => {
  let attempts = 0;
  const impl = (async () => {
    attempts += 1;
    const error = new Error("fetch failed");
    (error as { cause?: unknown }).cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND acme.my.salesforce.com"),
      { code: "ENOTFOUND" },
    );
    throw error;
  }) as unknown as typeof fetch;

  await assert.rejects(
    salesforceFetch(
      { url: "https://acme.my.salesforce.com/x", accessToken: "t" },
      { ...noWait, fetchImpl: impl, maxAttempts: 2 },
    ),
    (error: ActionExecutionError) => {
      assert.equal(error.retryable, true);
      // Node reports every transport failure as a bare "fetch failed".
      assert.match(error.message, /host does not exist/);
      return true;
    },
  );
  assert.equal(attempts, 2);
});

test("honours Retry-After in seconds and as a date", () => {
  assert.equal(retryAfterMs(new Headers({ "retry-after": "2" })), 2000);
  assert.equal(retryAfterMs(new Headers()), null);
  const soon = new Date(Date.now() + 5000).toUTCString();
  const ms = retryAfterMs(new Headers({ "retry-after": soon }));
  assert.ok(ms !== null && ms > 3000 && ms <= 6000, `unexpected ${ms}`);
});

test("backoff grows exponentially, stays jittered, and honours the ceiling", () => {
  const settings = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 };
  assert.equal(backoffMs(1, settings), 50);
  assert.equal(backoffMs(2, settings), 100);
  assert.equal(backoffMs(3, settings), 200);
  // Jitter spans 50-150% of the computed delay.
  assert.equal(backoffMs(1, { ...settings, random: () => 1 }), 150);
  // The ceiling applies before jitter, so the worst case is 1.5x maxDelayMs.
  assert.equal(backoffMs(20, { ...settings, random: () => 0 }), 500);
});

test("reads both Salesforce error envelopes", () => {
  assert.match(
    describeFailure(400, '[{"errorCode":"INVALID_FIELD","message":"No such column"}]')
      .message,
    /INVALID_FIELD: No such column/,
  );
  assert.match(
    describeFailure(400, '{"error":"invalid_grant","error_description":"expired"}')
      .message,
    /invalid_grant: expired/,
  );
  assert.match(describeFailure(502, "").message, /HTTP 502/);
});
