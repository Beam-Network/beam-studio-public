import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchBudgetAlerts, mostUrgentAlert, type BudgetAlert } from "./budget-alerts-client.js";

function alert(overrides: Partial<BudgetAlert>): BudgetAlert {
  return {
    id: "a1",
    targetType: "api_key",
    threshold: 50,
    usageCredits: 50,
    budgetCredits: 100,
    percentUsed: 50,
    month: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    acknowledgedAt: null,
    apiKey: null,
    project: null,
    ...overrides,
  };
}

test("the credential's organization is carried out, so the caller can check it", async () => {
  // Studio serves several organizations from one credential. Without this the
  // route cannot tell whose budgets it is holding, and showed them to everyone.
  const result = await fetchBudgetAlerts({
    credential: "bm_sa_test",
    fetch: async () =>
      new Response(JSON.stringify({ organizationId: "org_a", alerts: [] }), { status: 200 }),
  });
  assert.equal(result.organizationId, "org_a");
});

test("an upstream that names no organization yields null, never a guess", async () => {
  const result = await fetchBudgetAlerts({
    credential: "bm_sa_test",
    fetch: async () => new Response(JSON.stringify({ alerts: [] }), { status: 200 }),
  });
  assert.equal(result.organizationId, null);
});

test("no credential reports not configured rather than all-clear", async () => {
  // The distinction the bar renders on: an unconfigured Studio must stay quiet,
  // not claim every budget is healthy.
  const result = await fetchBudgetAlerts({ credential: "", fetch: async () => new Response("{}") });
  assert.equal(result.configured, false);
  assert.deepEqual(result.alerts, []);
});

test("a credential is sent as a bearer token to /v1/alerts", async () => {
  // Collected rather than assigned to a nullable: TypeScript cannot see the
  // write inside the async callback and narrows a `let` to `never`.
  const seen: Array<{ url: string; auth: string | null }> = [];
  await fetchBudgetAlerts({
    credential: "bm_sa_test",
    apiUrl: "https://api.example.test",
    fetch: async (input, init) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ alerts: [] }), { status: 200 });
    },
  });
  const request = seen[0];
  assert.ok(request, "the client made a request");
  assert.match(request.url, /\/v1\/alerts\?/);
  assert.match(request.url, /unacknowledged=true/);
  assert.equal(request.auth, "Bearer bm_sa_test");
});

test("an upstream failure yields no alerts, not an exception", async () => {
  // A warning bar must never be the reason a page fails to render.
  const result = await fetchBudgetAlerts({
    credential: "bm_sa_test",
    fetch: async () => new Response("nope", { status: 500 }),
  });
  assert.equal(result.configured, true);
  assert.deepEqual(result.alerts, []);
});

test("a network error is swallowed too", async () => {
  const result = await fetchBudgetAlerts({
    credential: "bm_sa_test",
    fetch: async () => {
      throw new Error("connection refused");
    },
  });
  assert.deepEqual(result.alerts, []);
});

test("the most urgent alert is the highest threshold, then the newest", async () => {
  const chosen = mostUrgentAlert([
    alert({ id: "low", threshold: 50, createdAt: "2026-09-20T00:00:00.000Z" }),
    alert({ id: "high-old", threshold: 95, createdAt: "2026-09-01T00:00:00.000Z" }),
    alert({ id: "high-new", threshold: 95, createdAt: "2026-09-10T00:00:00.000Z" }),
  ]);
  assert.equal(chosen?.id, "high-new");
});

test("an empty list has nothing urgent", () => {
  assert.equal(mostUrgentAlert([]), null);
});
