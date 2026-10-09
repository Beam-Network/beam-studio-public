import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { runActionHarness } from "../../../harness.js";
import { salesforceQueryAction, countDataRows } from "../salesforce-query.js";
import { salesforceUpsertAction } from "../salesforce-upsert.js";
import { salesforceRestAction } from "../salesforce-rest.js";

const CREDENTIAL = JSON.stringify({
  client_id: "id",
  client_secret: "secret",
  instance_url: "https://acme.my.salesforce.com",
  api_version: "v62.0",
});

type Call = { url: string; method: string; body?: string };

/**
 * Stubs global fetch, recording every call. The actions reach the network
 * through the shared http layer, which uses global fetch by default.
 */
function stubNetwork(handler: (call: Call) => { status?: number; body?: string; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    calls.push(call);
    const reply = handler(call);
    return new Response(reply.body ?? "", {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

let active: { restore: () => void } | null = null;
afterEach(() => {
  active?.restore();
  active = null;
});

const TOKEN_BODY = JSON.stringify({
  access_token: "tok",
  instance_url: "https://acme.my.salesforce.com",
});

test("query creates a job, drains paged results, and strips repeated headers", async () => {
  const net = stubNetwork((call) => {
    if (call.url.includes("/oauth2/token")) return { body: TOKEN_BODY };
    if (call.url.endsWith("/jobs/query") && call.method === "POST")
      return { body: JSON.stringify({ id: "750job", state: "UploadComplete" }) };
    if (call.url.includes("/jobs/query/750job/results")) {
      // Second page must not repeat the header row.
      return call.url.includes("locator=L1")
        ? { body: "Id,Name\n003,Carol\n" }
        : { body: "Id,Name\n001,Alice\n002,Bob\n", headers: { "Sforce-Locator": "L1" } };
    }
    if (call.url.includes("/jobs/query/750job"))
      return { body: JSON.stringify({ id: "750job", state: "JobComplete" }) };
    return { status: 404, body: "[]" };
  });
  active = net;

  const result = await runActionHarness(
    salesforceQueryAction.execute,
    { config: { credentialId: "cred_1", soql: "SELECT Id, Name FROM Contact" } },
    { secrets: { cred_1: CREDENTIAL } },
  );

  assert.equal(result.outputs?.recordCount, 3);
  assert.equal(result.outputs?.content, "Id,Name\n001,Alice\n002,Bob\n003,Carol\n");
  assert.equal(result.externalRef, "750job");
  assert.equal(result.state?.jobId, "750job", "job id must persist for resume");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.mediaType, "text/csv");
});

test("upsert creates exactly one job and uploads the CSV", async () => {
  const net = stubNetwork((call) => {
    if (call.url.includes("/oauth2/token")) return { body: TOKEN_BODY };
    if (call.url.endsWith("/jobs/ingest") && call.method === "POST")
      return { body: JSON.stringify({ id: "750ing", state: "Open" }) };
    if (call.url.includes("/batches")) return { status: 201 };
    if (call.url.includes("/jobs/ingest/750ing") && call.method === "PATCH")
      return { body: JSON.stringify({ id: "750ing", state: "UploadComplete" }) };
    if (call.url.includes("/jobs/ingest/750ing"))
      return {
        body: JSON.stringify({
          id: "750ing",
          state: "JobComplete",
          numberRecordsProcessed: 2,
          numberRecordsFailed: 0,
        }),
      };
    return { status: 404, body: "[]" };
  });
  active = net;

  const result = await runActionHarness(
    salesforceUpsertAction.execute,
    {
      config: {
        credentialId: "cred_1",
        object: "Account",
        operation: "upsert",
        externalIdField: "Ext_Id__c",
      },
      inputs: { content: "Ext_Id__c,Name\nA1,Acme\nA2,Globex\n" },
    },
    { secrets: { cred_1: CREDENTIAL } },
  );

  assert.equal(result.outputs?.processed, 2);
  assert.equal(result.outputs?.failed, 0);
  const created = net.calls.filter(
    (c) => c.method === "POST" && c.url.endsWith("/jobs/ingest"),
  );
  assert.equal(created.length, 1);
  const upload = net.calls.find((c) => c.url.includes("/batches"));
  assert.match(String(upload?.body), /A1,Acme/);
});

test("upsert reattaches to an existing job instead of creating a second", async () => {
  /*
   * This is the duplicate-write guard. A step that crashed after creating a job
   * has already had its rows accepted by Salesforce; creating another job would
   * write every record twice into a customer's CRM.
   */
  const net = stubNetwork((call) => {
    if (call.url.includes("/oauth2/token")) return { body: TOKEN_BODY };
    if (call.url.includes("/jobs/ingest/750prior"))
      return {
        body: JSON.stringify({
          id: "750prior",
          state: "JobComplete",
          numberRecordsProcessed: 5,
          numberRecordsFailed: 0,
        }),
      };
    return { status: 404, body: "[]" };
  });
  active = net;

  const result = await runActionHarness(
    salesforceUpsertAction.execute,
    {
      config: {
        credentialId: "cred_1",
        object: "Account",
        operation: "insert",
      },
      inputs: { content: "Name\nAcme\n" },
    },
    { secrets: { cred_1: CREDENTIAL }, initialState: { jobId: "750prior" } },
  );

  assert.equal(result.outputs?.jobId, "750prior");
  assert.equal(result.outputs?.processed, 5);
  assert.equal(
    net.calls.filter((c) => c.method === "POST" && c.url.endsWith("/jobs/ingest")).length,
    0,
    "must not create a second ingest job",
  );
  assert.equal(
    net.calls.filter((c) => c.url.includes("/batches")).length,
    0,
    "must not re-upload records",
  );
});

test("upsert publishes failed rows as their own artifact", async () => {
  const net = stubNetwork((call) => {
    if (call.url.includes("/oauth2/token")) return { body: TOKEN_BODY };
    if (call.url.includes("/failedResults"))
      return { body: 'sf__Id,sf__Error,Name\n,"REQUIRED_FIELD_MISSING",Acme\n' };
    if (call.url.includes("/jobs/ingest/750fail"))
      return {
        body: JSON.stringify({
          id: "750fail",
          state: "JobComplete",
          numberRecordsProcessed: 3,
          numberRecordsFailed: 1,
        }),
      };
    return { status: 404, body: "[]" };
  });
  active = net;

  const result = await runActionHarness(
    salesforceUpsertAction.execute,
    { config: { credentialId: "cred_1", object: "Account", operation: "insert" } },
    { secrets: { cred_1: CREDENTIAL }, initialState: { jobId: "750fail" } },
  );

  assert.equal(result.outputs?.failed, 1);
  assert.equal(result.artifacts.length, 1);
  assert.match(String(result.outputs?.content), /REQUIRED_FIELD_MISSING/);
});

test("a failed bulk job is terminal, not retried", async () => {
  const net = stubNetwork((call) => {
    if (call.url.includes("/oauth2/token")) return { body: TOKEN_BODY };
    if (call.url.includes("/jobs/ingest/750bad"))
      return {
        body: JSON.stringify({
          id: "750bad",
          state: "Failed",
          errorMessage: "InvalidBatch : Field name not found",
        }),
      };
    return { status: 404, body: "[]" };
  });
  active = net;

  await assert.rejects(
    runActionHarness(
      salesforceUpsertAction.execute,
      { config: { credentialId: "cred_1", object: "Account", operation: "insert" } },
      { secrets: { cred_1: CREDENTIAL }, initialState: { jobId: "750bad" } },
    ),
    (error: Error & { retryable?: boolean }) => {
      assert.equal(error.retryable, false, "an aborted job is a decision, not a blip");
      assert.match(error.message, /Failed/);
      return true;
    },
  );
});

test("rest refuses an absolute URL so it cannot call arbitrary hosts", async () => {
  const net = stubNetwork(() => ({ body: TOKEN_BODY }));
  active = net;

  await assert.rejects(
    runActionHarness(
      salesforceRestAction.execute,
      { config: { credentialId: "cred_1", path: "https://evil.test/steal" } },
      { secrets: { cred_1: CREDENTIAL } },
    ),
    /relative to the Salesforce instance/,
  );
});

test("rest resolves a bare path under the credential's API version", async () => {
  const net = stubNetwork((call) =>
    call.url.includes("/oauth2/token")
      ? { body: TOKEN_BODY }
      : { body: JSON.stringify({ ok: true }) },
  );
  active = net;

  await runActionHarness(
    salesforceRestAction.execute,
    { config: { credentialId: "cred_1", path: "/limits" } },
    { secrets: { cred_1: CREDENTIAL } },
  );

  const call = net.calls.find((c) => c.url.includes("/limits"));
  assert.equal(
    call?.url,
    "https://acme.my.salesforce.com/services/data/v62.0/limits",
  );
});

test("counts data rows excluding the header", () => {
  assert.equal(countDataRows(""), 0);
  assert.equal(countDataRows("Id,Name\n"), 0);
  assert.equal(countDataRows("Id,Name\n1,a\n2,b\n"), 2);
  assert.equal(countDataRows("Id,Name\n1,a"), 1);
});
