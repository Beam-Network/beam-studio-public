import assert from "node:assert/strict";
import { test } from "node:test";
import { BeamApiClient, BeamApiError } from "./beam-api-client.js";

test("adds bearer auth and performs at most one refresh/retry after 401", async () => {
  const forceRefresh: boolean[] = [];
  const oauth = {
    getAccessToken: async (options: { forceRefresh?: boolean }) => {
      forceRefresh.push(options.forceRefresh === true);
      return options.forceRefresh ? "access-new" : "access-old";
    },
    expireSession: async () => undefined,
  };
  const authorizations: string[] = [];
  const client = new BeamApiClient({
    apiUrl: "https://api.example",
    oauth: oauth as never,
    fetch: async (_input, init) => {
      authorizations.push(
        new Headers(init?.headers).get("Authorization") ?? "",
      );
      return authorizations.length === 1
        ? new Response(null, { status: 401 })
        : new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
    },
  });

  assert.deepEqual(await client.getJson("/api/me"), { id: "user-1" });
  assert.deepEqual(forceRefresh, [false, true]);
  assert.deepEqual(authorizations, ["Bearer access-old", "Bearer access-new"]);
});

test("does not clear a session on 503 or network failure", async () => {
  let expired = 0;
  const oauth = {
    getAccessToken: async () => "access-current",
    expireSession: async () => {
      expired += 1;
    },
  };
  const client = new BeamApiClient({
    apiUrl: "https://api.example",
    oauth: oauth as never,
    fetch: async () => new Response(null, { status: 503 }),
  });

  await assert.rejects(
    client.getJson("/api/organizations"),
    (error: unknown) => error instanceof BeamApiError && error.retryable,
  );
  assert.equal(expired, 0);
});

test("clears a session after the single retry also returns 401", async () => {
  let expired = 0;
  let requests = 0;
  const oauth = {
    getAccessToken: async () => "access",
    expireSession: async () => {
      expired += 1;
    },
  };
  const client = new BeamApiClient({
    apiUrl: "https://api.example",
    oauth: oauth as never,
    fetch: async () => {
      requests += 1;
      return new Response(null, { status: 401 });
    },
  });

  await assert.rejects(client.getJson("/api/me"), /session has expired/i);
  assert.equal(requests, 2);
  assert.equal(expired, 1);
});

test("authenticated fetch preserves POST data and replaces caller authorization", async () => {
  const oauth = {
    getAccessToken: async () => "beam-access",
    expireSession: async () => undefined,
  };
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = new BeamApiClient({
    apiUrl: "https://api.example",
    oauth: oauth as never,
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  await client.fetchResponse("/api/ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer must-not-pass",
      "Content-Type": "application/json",
      "X-Organization-Id": "org_1",
    },
    body: '{"model":"gpt-test"}',
  });

  const headers = new Headers(capturedInit?.headers);
  assert.equal(capturedUrl, "https://api.example/api/ai/v1/chat/completions");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.body, '{"model":"gpt-test"}');
  assert.equal(headers.get("authorization"), "Bearer beam-access");
  assert.equal(headers.get("x-organization-id"), "org_1");
});

test("authenticated fetch never sends the Beam token to another origin", async () => {
  const oauth = {
    getAccessToken: async () => "beam-access",
    expireSession: async () => undefined,
  };
  let called = false;
  const client = new BeamApiClient({
    apiUrl: "https://api.example",
    oauth: oauth as never,
    fetch: async () => {
      called = true;
      return new Response();
    },
  });

  await assert.rejects(
    client.fetchResponse("https://attacker.example/collect"),
    (error: unknown) =>
      error instanceof BeamApiError && error.code === "invalid_api_url",
  );
  assert.equal(called, false);
});
