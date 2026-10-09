import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { ActionExecutionError, ActionInputError } from "../../actions.js";
import { runActionHarness } from "../../harness.js";
import {
  httpRequestAction,
  httpRequestActionManifest,
} from "./http-request.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("returns typed status, headers, and JSON body outputs", async () => {
  let request: RequestInit | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    request = init;
    return new Response('{"pools":{"qualifying":{"eligible":6}}}', {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req_1" },
    });
  }) as typeof fetch;

  const result = await runActionHarness(httpRequestAction.execute, {
    config: { url: "https://beamcore.example/routing/pools", method: "GET" },
  });

  assert.equal(request?.method, "GET");
  assert.equal(result.outputs?.status, 200);
  assert.equal(
    (result.outputs?.headers as Record<string, string>)["x-request-id"],
    "req_1",
  );
  assert.deepEqual(result.outputs?.body, {
    pools: { qualifying: { eligible: 6 } },
  });
});

test("returns text bodies and authenticates with an HTTP credential", async () => {
  let authorization = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    authorization =
      (init.headers as Record<string, string>).Authorization ?? "";
    return new Response("ok", {
      status: 202,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  const result = await runActionHarness(
    httpRequestAction.execute,
    {
      config: {
        url: "https://api.example/jobs",
        method: "POST",
        credentialId: "cred_http",
      },
      inputs: { body: { run: true } },
    },
    { secrets: { cred_http: JSON.stringify({ token: "tok_1" }) } },
  );

  assert.equal(authorization, "Bearer tok_1");
  assert.equal(result.outputs?.body, "ok");
});

test("fails the step on HTTP errors and malformed declared JSON", async () => {
  globalThis.fetch = (async () =>
    new Response("refused", { status: 400 })) as typeof fetch;
  await assert.rejects(
    () =>
      runActionHarness(httpRequestAction.execute, {
        config: { url: "https://api.example/fail" },
      }),
    (error: unknown) =>
      error instanceof ActionExecutionError && error.retryable === false,
  );

  globalThis.fetch = (async () =>
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  await assert.rejects(
    () =>
      runActionHarness(httpRequestAction.execute, {
        config: { url: "https://api.example/bad-json" },
      }),
    ActionExecutionError,
  );
});

test("enforces the shared URL and header policies", async () => {
  await assert.rejects(
    () =>
      runActionHarness(httpRequestAction.execute, {
        config: { url: "file:///secret" },
      }),
    ActionInputError,
  );
  await assert.rejects(
    () =>
      runActionHarness(httpRequestAction.execute, {
        config: { url: "https://api.example", headers: { bad: 42 } },
      }),
    ActionInputError,
  );
  assert.deepEqual(httpRequestActionManifest.permissions, [
    "network:http",
    "secrets:read",
  ]);
});
