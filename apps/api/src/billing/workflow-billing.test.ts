import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, after, test } from "node:test";
import {
  captureWorkflowTreePg,
  createPostgresPool,
  enqueueFrozenWorkflowRunPg,
  ensurePostgresMigrations,
  retryFrozenWorkflowRunPg,
  withPostgresTransaction,
  workflowBillingAttemptPg,
  type PgPool,
} from "@beam-studio/db";
import { encryptString, vaultSecretFromEnv } from "@beam-studio/vault";
import { CreditClient } from "./credit-client.js";
import { settleCreditReservations } from "./credit-settlement.js";
import {
  ensureWorkflowBillingReserved,
  INSUFFICIENT_CREDIT_MESSAGE,
  settleWorkflowBillingAttempt,
  storeBillingKeys,
  type WorkflowBillingKeys,
} from "./workflow-billing.js";

const source = process.env.BEAM_TEST_POSTGRES_URL;
const database = `workflow_billing_${crypto.randomBytes(6).toString("hex")}`;
let pool: PgPool, maintenance: PgPool;
before(async () => {
  if (!source) return;
  assert.ok(
    ["127.0.0.1", "localhost", "postgres"].includes(new URL(source).hostname),
    "Use an isolated PostgreSQL test service",
  );
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  maintenance = createPostgresPool(source);
  await maintenance.query(`CREATE DATABASE ${database}`);
  const url = new URL(source);
  url.pathname = `/${database}`;
  pool = createPostgresPool(url.toString());
  await ensurePostgresMigrations(pool);
  await pool.query(
    "INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Test')",
  );
  await pool.query(
    "INSERT INTO workflow.templates(id,organization_id,name,api_key_id) VALUES('root','org','Root','credential'),('child','org','Child','credential')",
  );
  await pool.query(
    "INSERT INTO workflow.steps(id,workflow_template_id,kind,called_workflow_id,position) VALUES('call','root','workflow','child',0)",
  );
  await pool.query(
    "INSERT INTO secrets.credential_types(id,slug,display_name) VALUES('test-type','test-key','Test key')",
  );
  await pool.query(
    "INSERT INTO secrets.credentials(id,organization_id,credential_type_id,name) VALUES('credential','org','test-type','Run key')",
  );
  await pool.query(
    "INSERT INTO secrets.credential_versions(id,credential_id,version,encrypted_payload,encryption_key_id) VALUES('credential-v1','credential',1,$1,'local')",
    [
      encryptString(
        JSON.stringify({ api_key: "run-key" }),
        vaultSecretFromEnv(),
      ),
    ],
  );
});
after(async () => {
  await pool?.end();
  if (maintenance) {
    await maintenance.query(`DROP DATABASE IF EXISTS ${database}`);
    await maintenance.end();
  }
});

/** Beam's key id for each raw key the tests present. */
const BEAM_KEY_IDS: Record<string, string> = {
  "run-key": "authority-key",
  "rotated-key": "rotated-authority-key",
  "org-key": "organization-key",
};

function billingService() {
  const ledger = new Map<
    string,
    {
      idempotencyKey: string;
      apiKeyId: string;
      action: string;
      status: string;
      creditsUsed: number;
    }
  >();
  const fences = new Map<string, string>();
  const failedSettlements = new Set<string>();
  const presented: Array<{ route: string; key: string }> = [];
  let reservations = 0,
    verifications = 0;
  const state = {
    loseReserveResponse: false,
    loseLookupResponse: false,
    loseSettlementResponse: false,
    deny: false,
  };
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    urls.push(new URL(String(url)).origin);
    const body = JSON.parse(String(init?.body));
    const route = new URL(String(url)).pathname;
    // Every call authenticates with a Beam API key and nothing else.
    const headers = new Headers(init?.headers);
    assert.deepEqual([...headers.keys()].sort(), [
      "authorization",
      "content-type",
    ]);
    const key = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    assert.ok(BEAM_KEY_IDS[key], `unexpected credential on ${route}`);
    presented.push({ route, key });
    if (route === "/api/keys/verify") {
      verifications++;
      return Response.json({ valid: true, keyId: BEAM_KEY_IDS[body.apiKey] });
    }
    if (route === "/v1/workflow-billing/lookup") {
      if (state.loseLookupResponse) throw new Error("response lost");
      return Response.json({
        found: ledger.has(body.operationKey),
        operation: ledger.get(body.operationKey) ?? null,
        settlement: fences.get(body.operationKey) ?? null,
      });
    }
    if (route === "/v1/usage/reservations") {
      if (state.deny)
        return Response.json(
          { error: "Insufficient credits" },
          { status: 402 },
        );
      if (fences.has(body.idempotencyKey))
        return Response.json({ error: "Terminal settlement" }, { status: 409 });
      if (!ledger.has(body.idempotencyKey)) {
        reservations++;
        // Beam derives the profile, permission and price from the action.
        assert.deepEqual(body, {
          idempotencyKey: body.idempotencyKey,
          action: "workflow.run",
          usage: [{ metric: "invocation", quantity: 1, unit: "count" }],
        });
        ledger.set(body.idempotencyKey, {
          idempotencyKey: body.idempotencyKey,
          apiKeyId: BEAM_KEY_IDS[key]!,
          action: body.action,
          status: "RESERVED",
          creditsUsed: 3,
        });
      }
      if (state.loseReserveResponse) {
        state.loseLookupResponse = true;
        throw new Error("response lost after commit");
      }
      return Response.json({
        success: true,
        operation: ledger.get(body.idempotencyKey),
      });
    }
    if (route === "/v1/workflow-billing/settle") {
      if (failedSettlements.has(body.operationKey))
        throw new Error("Billing authority unavailable");
      const status = {
        completed: "COMMITTED",
        failed: "FAILED",
        cancelled: "CANCELED",
      }[body.outcome as "completed" | "failed" | "cancelled"];
      const old = fences.get(body.operationKey);
      if (old && old !== status)
        return Response.json({ error: "Conflicting outcome" }, { status: 409 });
      fences.set(body.operationKey, status);
      const operation = ledger.get(body.operationKey);
      if (operation) operation.status = status;
      if (state.loseSettlementResponse)
        throw new Error("response lost after settlement");
      return Response.json({ confirmed: true, status });
    }
    throw new Error(`Unexpected billing path ${route}`);
  };
  const client = new CreditClient({
    apiUrl: "https://billing.test",
    fetch: fetchImpl,
  });
  return {
    client,
    fetchImpl,
    urls,
    state,
    ledger,
    fences,
    failedSettlements,
    presented,
    reservations: () => reservations,
    verifications: () => verifications,
  };
}

/** The run's key is always usable unless a test says otherwise. */
const keys: WorkflowBillingKeys = {
  run: async () => "run-key",
  organization: async () => "org-key",
};

async function launch(trigger = "manual") {
  return withPostgresTransaction(pool, async (client) => {
    const tree = await captureWorkflowTreePg(client, {
      organizationId: "org",
      workflowTemplateId: "root",
    });
    return enqueueFrozenWorkflowRunPg(client, {
      definition: tree.root,
      definitions: tree.definitions,
      runtimeInput: {},
      trigger,
    });
  });
}
const reserve = (runId: string, service: ReturnType<typeof billingService>) =>
  ensureWorkflowBillingReserved(pool, runId, service.client, keys);

test(
  "manual, scheduled and completion-trigger roots own one durable billing identity before dispatch",
  { skip: !source },
  async () => {
    const service = billingService();
    for (const trigger of ["manual", "schedule", "completion"]) {
      const runId = await launch(trigger);
      const intent = await workflowBillingAttemptPg(pool, runId);
      assert.equal(intent?.reservation_state, "pending");
      assert.equal(intent?.credential_id, "credential");
      await Promise.all([
        reserve(runId, service),
        reserve(runId, service),
        reserve(runId, service),
      ]);
      assert.equal(
        (await workflowBillingAttemptPg(pool, runId))?.reservation_state,
        "reserved",
      );
    }
    assert.equal(service.reservations(), 3);
    assert.equal(service.verifications(), 3);
  },
);

test(
  "settlement retries one unavailable receipt without blocking other terminal runs",
  { skip: !source },
  async () => {
    const service = billingService();
    const failedId = await launch(),
      successfulId = await launch();
    await Promise.all([
      reserve(failedId, service),
      reserve(successfulId, service),
    ]);
    await pool.query(
      "UPDATE execution.workflow_runs SET status='cancelled' WHERE id=ANY($1::text[])",
      [[failedId, successfulId]],
    );
    const failed = (await workflowBillingAttemptPg(pool, failedId))!;
    const successful = (await workflowBillingAttemptPg(pool, successfulId))!;
    service.failedSettlements.add(failed.operation_key);
    await assert.rejects(
      settleCreditReservations(pool, service.client, keys),
      AggregateError,
    );
    assert.equal(
      (await workflowBillingAttemptPg(pool, failedId))?.settled_at,
      null,
    );
    assert.equal(
      (await workflowBillingAttemptPg(pool, failedId))?.error_code,
      "settlement_unconfirmed",
    );
    assert.ok((await workflowBillingAttemptPg(pool, successfulId))?.settled_at);
    service.failedSettlements.clear();
    await settleCreditReservations(pool, service.client, keys);
    assert.ok((await workflowBillingAttemptPg(pool, failedId))?.settled_at);
    assert.equal(service.fences.get(successful.operation_key), "CANCELED");
  },
);

test(
  "billing migration retains historical holds and verifies identity ownership on repeat",
  { skip: !source },
  async () => {
    const sql = await readFile(
      new URL(
        "../../../../packages/db/src/postgres-migrations/0027_workflow_billing_attempts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const runId = await launch();
    await withPostgresTransaction(pool, async (client) => {
      await client.query(
        "ALTER TABLE execution.workflow_runs DISABLE TRIGGER capture_workflow_billing_attempt",
      );
      await client.query(
        "ALTER TABLE execution.workflow_runs DISABLE TRIGGER immutable_workflow_run",
      );
      await client.query(
        "DELETE FROM execution.workflow_billing_attempts WHERE workflow_run_id=$1",
        [runId],
      );
      await client.query(
        "UPDATE execution.workflow_runs SET historical=true,status='failed',credit_operation_key='job:original-billing-hold',credit_settled_at='2026-09-01T12:00:00Z' WHERE id=$1",
        [runId],
      );
      await client.query(
        "ALTER TABLE execution.workflow_runs ENABLE TRIGGER capture_workflow_billing_attempt",
      );
      await client.query(
        "ALTER TABLE execution.workflow_runs ENABLE TRIGGER immutable_workflow_run",
      );
    });
    await pool.query(sql);
    const before = (
      await pool.query(
        "SELECT * FROM execution.workflow_billing_attempts ORDER BY operation_key",
      )
    ).rows;
    await pool.query(sql);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT * FROM execution.workflow_billing_attempts ORDER BY operation_key",
        )
      ).rows,
      before,
    );
    const historic = (await workflowBillingAttemptPg(pool, runId))!;
    assert.equal(historic.operation_key, "job:original-billing-hold");
    assert.equal(historic.reservation_state, "reserved");
    assert.equal(historic.outcome, "failed");
    assert.equal(
      historic.settled_at?.toISOString(),
      "2026-09-01T12:00:00.000Z",
    );
    const other = await launch();
    await assert.rejects(
      pool.query(
        "UPDATE execution.workflow_runs SET credit_operation_key=$2 WHERE id=$1",
        [other, historic.operation_key],
      ),
      /another invocation/,
    );
    await assert.rejects(
      withPostgresTransaction(pool, async (client) => {
        await client.query(
          "ALTER TABLE execution.workflow_runs DISABLE TRIGGER capture_workflow_billing_attempt",
        );
        await client.query(
          "UPDATE execution.workflow_runs SET credit_operation_key=$2 WHERE id=$1",
          [other, historic.operation_key],
        );
        await client.query(sql);
      }),
      /ownership verification/,
    );
  },
);

test(
  "uncertain reservation commit recovers the original hold without resolving a rotated key",
  { skip: !source },
  async () => {
    const service = billingService(),
      runId = await launch();
    service.state.loseReserveResponse = true;
    await assert.rejects(reserve(runId, service), {
      code: "execution_billing_unavailable",
      retryable: true,
      statusCode: 503,
    });
    const original = await workflowBillingAttemptPg(pool, runId);
    assert.equal(original?.authority_key_id, "authority-key");
    assert.equal(original?.reservation_state, "pending");
    service.state.loseReserveResponse =
      service.state.loseLookupResponse = false;
    // The credential now holds a different Beam key. It may read the ledger,
    // but the recovered hold keeps the identity it was reserved under.
    await ensureWorkflowBillingReserved(pool, runId, service.client, {
      ...keys,
      run: async () => "rotated-key",
    });
    assert.equal(
      (await workflowBillingAttemptPg(pool, runId))?.reservation_state,
      "reserved",
    );
    assert.equal(service.reservations(), 1);
    assert.equal(service.verifications(), 1);
  },
);

test(
  "child calls use their ancestor reservation and explicit retries retain earlier settlements",
  { skip: !source },
  async () => {
    const service = billingService(),
      rootId = await launch();
    await reserve(rootId, service);
    const root = (
      await pool.query("SELECT * FROM execution.workflow_runs WHERE id=$1", [
        rootId,
      ])
    ).rows[0];
    const definitions = root.template_snapshot_json.dependencies;
    const childId = await withPostgresTransaction(pool, (client) =>
      enqueueFrozenWorkflowRunPg(client, {
        definition: definitions.child,
        definitions,
        runtimeInput: {},
        parentRunId: rootId,
        rootRunId: rootId,
        trigger: "workflow",
        executionContext: root.execution_context_json,
      }),
    );
    await reserve(childId, service);
    assert.equal(service.reservations(), 1);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM execution.workflow_billing_attempts WHERE workflow_run_id=$1",
          [childId],
        )
      ).rows[0].count,
      "0",
    );
    await pool.query(
      "UPDATE execution.workflow_runs SET status='failed' WHERE id=ANY($1::text[])",
      [[rootId, childId]],
    );
    const first = await workflowBillingAttemptPg(pool, rootId);
    await withPostgresTransaction(pool, (client) =>
      retryFrozenWorkflowRunPg(client, {
        workflowRunId: rootId,
        organizationId: "org",
        authorizeExecution: async () => {},
      }),
    );
    const second = await workflowBillingAttemptPg(pool, rootId);
    assert.notEqual(first?.operation_key, second?.operation_key);
    assert.equal(first?.outcome, "failed");
    await settleWorkflowBillingAttempt(
      pool,
      first!.operation_key,
      service.client,
      keys,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT credit_settled_at FROM execution.workflow_runs WHERE id=$1",
          [rootId],
        )
      ).rows[0].credit_settled_at,
      null,
    );
    await reserve(rootId, service);
    assert.equal(service.reservations(), 2);
    await pool.query(
      "UPDATE execution.workflow_runs SET status='completed' WHERE id=$1",
      [rootId],
    );
    await settleWorkflowBillingAttempt(
      pool,
      second!.operation_key,
      service.client,
      keys,
    );
    assert.deepEqual(
      [...service.ledger.values()].map((operation) => operation.status),
      ["FAILED", "COMMITTED"],
    );
  },
);

test(
  "lost settlement responses remain pending until an idempotent receipt is confirmed",
  { skip: !source },
  async () => {
    const service = billingService(),
      runId = await launch();
    await reserve(runId, service);
    await pool.query(
      "UPDATE execution.workflow_runs SET status='cancelled' WHERE id=$1",
      [runId],
    );
    const attempt = await workflowBillingAttemptPg(pool, runId);
    service.state.loseSettlementResponse = true;
    await assert.rejects(
      settleWorkflowBillingAttempt(
        pool,
        attempt!.operation_key,
        service.client,
        keys,
      ),
    );
    assert.equal(
      (await workflowBillingAttemptPg(pool, runId))?.settled_at,
      null,
    );
    service.state.loseSettlementResponse = false;
    await Promise.all([
      settleWorkflowBillingAttempt(
        pool,
        attempt!.operation_key,
        service.client,
        keys,
      ),
      settleWorkflowBillingAttempt(
        pool,
        attempt!.operation_key,
        service.client,
        keys,
      ),
    ]);
    assert.ok((await workflowBillingAttemptPg(pool, runId))?.settled_at);
    assert.equal(
      service.ledger.get(attempt!.operation_key)?.status,
      "CANCELED",
    );
  },
);

test(
  "cancelled and failed intents before reservation close without a key or remote writes",
  { skip: !source },
  async () => {
    for (const outcome of ["cancelled", "failed"] as const) {
      const service = billingService(),
        runId = await launch();
      await pool.query(
        "UPDATE execution.workflow_runs SET status=$2 WHERE id=$1",
        [runId, outcome],
      );
      const attempt = (await workflowBillingAttemptPg(pool, runId))!;
      assert.equal(attempt.authority_key_id, null);
      assert.equal(attempt.reserve_started_at, null);
      const unavailableKeys: WorkflowBillingKeys = {
        run: async () => {
          throw new Error("No key should be read");
        },
        organization: async () => {
          throw new Error("No key should be read");
        },
      };
      assert.equal(
        await settleWorkflowBillingAttempt(
          pool,
          attempt.operation_key,
          service.client,
          unavailableKeys,
        ),
        true,
      );
      assert.ok((await workflowBillingAttemptPg(pool, runId))?.settled_at);
      assert.equal(service.presented.length, 0);
      assert.equal(service.reservations(), 0);
      assert.equal(
        await settleWorkflowBillingAttempt(
          pool,
          attempt.operation_key,
          service.client,
          unavailableKeys,
        ),
        false,
      );
      await assert.rejects(reserve(runId, service), {
        code: "execution_billing_ended",
      });
    }
  },
);

test(
  "completed work without reservation still requires external billing confirmation",
  { skip: !source },
  async () => {
    const service = billingService(),
      runId = await launch();
    await pool.query(
      "UPDATE execution.workflow_runs SET status='completed' WHERE id=$1",
      [runId],
    );
    const attempt = (await workflowBillingAttemptPg(pool, runId))!;
    await assert.rejects(
      settleWorkflowBillingAttempt(
        pool,
        attempt.operation_key,
        service.client,
        {
          run: async () => null,
          organization: async () => null,
        },
      ),
      { code: "billing_unavailable" },
    );
    assert.equal(
      (await workflowBillingAttemptPg(pool, runId))?.settled_at,
      null,
    );
  },
);

test(
  "denied and never-started roots settle without creating a hold",
  { skip: !source },
  async () => {
    const service = billingService(),
      runId = await launch();
    service.state.deny = true;
    await assert.rejects(reserve(runId, service), {
      code: "execution_insufficient_credit",
      message: INSUFFICIENT_CREDIT_MESSAGE,
    });
    assert.equal(
      (await workflowBillingAttemptPg(pool, runId))?.reservation_state,
      "denied",
    );
    await pool.query(
      "UPDATE execution.workflow_runs SET status='cancelled' WHERE id=$1",
      [runId],
    );
    const intent = await workflowBillingAttemptPg(pool, runId);
    await settleWorkflowBillingAttempt(
      pool,
      intent!.operation_key,
      service.client,
      keys,
    );
    assert.equal(service.reservations(), 0);
    assert.equal(service.fences.get(intent!.operation_key), "CANCELED");
  },
);

test(
  "a revoked run key settles with the organization's default key",
  { skip: !source },
  async () => {
    const service = billingService(),
      runId = await launch();
    // The stored credential, read through the same filter authorization uses.
    const storedKeys: WorkflowBillingKeys = {
      run: storeBillingKeys.run,
      organization: async () => "org-key",
    };
    await ensureWorkflowBillingReserved(
      pool,
      runId,
      service.client,
      storedKeys,
    );
    const attempt = (await workflowBillingAttemptPg(pool, runId))!;
    assert.equal(attempt.authority_key_id, "authority-key");
    assert.deepEqual(
      service.presented
        .filter((call) => call.route === "/v1/usage/reservations")
        .map((call) => call.key),
      ["run-key"],
    );
    try {
      await pool.query(
        "UPDATE secrets.credentials SET status='revoked' WHERE id='credential'",
      );
      await pool.query(
        "UPDATE execution.workflow_runs SET status='completed' WHERE id=$1",
        [runId],
      );
      assert.equal(
        await settleWorkflowBillingAttempt(
          pool,
          attempt.operation_key,
          service.client,
          storedKeys,
        ),
        true,
      );
    } finally {
      await pool.query(
        "UPDATE secrets.credentials SET status='active' WHERE id='credential'",
      );
    }
    assert.deepEqual(
      service.presented
        .filter((call) => call.route === "/v1/workflow-billing/settle")
        .map((call) => call.key),
      ["org-key"],
    );
    assert.equal(
      service.ledger.get(attempt.operation_key)?.status,
      "COMMITTED",
    );
  },
);

test(
  "settlement with no usable key stays pending with an error and retries",
  { skip: !source },
  async () => {
    const service = billingService(),
      runId = await launch();
    await reserve(runId, service);
    await pool.query(
      "UPDATE execution.workflow_runs SET status='failed' WHERE id=$1",
      [runId],
    );
    const attempt = (await workflowBillingAttemptPg(pool, runId))!;
    const settlements = service.presented.length;
    await assert.rejects(
      settleWorkflowBillingAttempt(
        pool,
        attempt.operation_key,
        service.client,
        {
          run: async () => null,
          organization: async () => null,
        },
      ),
      { code: "billing_unavailable", statusCode: 503 },
    );
    assert.equal(service.presented.length, settlements);
    const pending = (await workflowBillingAttemptPg(pool, runId))!;
    assert.equal(pending.settled_at, null);
    assert.equal(pending.error_code, "settlement_unconfirmed");
    assert.match(String(pending.error), /No usable Beam API key/);
    assert.equal(
      await settleWorkflowBillingAttempt(
        pool,
        attempt.operation_key,
        service.client,
        keys,
      ),
      true,
    );
    assert.equal(service.ledger.get(attempt.operation_key)?.status, "FAILED");
  },
);

test(
  "managed DEV reservation, retry and settlement share the scoped account authority",
  { skip: !source },
  async () => {
    const service = billingService();
    const originalMetadata = (
      await pool.query(
        "SELECT metadata_json FROM secrets.credentials WHERE id='credential'",
      )
    ).rows[0].metadata_json;
    const saved = {
      entries: process.env.DEV_QUALIFICATION_WORKFLOWS,
      url: process.env.DEV_QUALIFICATION_ACCOUNT_API_URL,
      managed: process.env.MANAGED_QUALIFICATION_WORKFLOWS,
      origin: process.env.DEV_CORE_PRIVATE_ORIGIN,
      secret: process.env.DEV_CORE_PRIVATE_SECRET,
      fetch: globalThis.fetch,
    };
    try {
      process.env.DEV_QUALIFICATION_WORKFLOWS = JSON.stringify([
        {
          workflowId: "root",
          organizationId: "org",
          credentialId: "credential",
        },
      ]);
      process.env.DEV_QUALIFICATION_ACCOUNT_API_URL =
        "https://managed-dev.test";
      process.env.MANAGED_QUALIFICATION_WORKFLOWS='';
      process.env.DEV_CORE_PRIVATE_ORIGIN='http://private-dev.test';
      process.env.DEV_CORE_PRIVATE_SECRET='fixture-private-secret';
      globalThis.fetch = async(input,init)=>{
        const url=new URL(String(input));
        if(url.origin!=='http://private-dev.test')return service.fetchImpl(input,init);
        assert.equal(new Headers(init?.headers).get('x-internal-secret'),'fixture-private-secret');
        if(url.pathname==='/internal/rollout/admission')return Response.json({state:{environment:'dev'},fresh:true,blocked:false});
        assert.equal(url.pathname,'/internal/routing/live');
        assert.equal(url.searchParams.get('workload'),'standard_transfers');
        assert.equal(url.searchParams.get('pool'),'qualifying');
        return Response.json({environment:'dev',workload:'standard_transfers',pools:{qualifying:{eligible:3}}});
      };
      await pool.query(
        "UPDATE secrets.credentials SET metadata_json=$1 WHERE id='credential'",
        [{ environment: "dev" }],
      );
      const runId = await launch("schedule");
      await ensureWorkflowBillingReserved(pool, runId, undefined, keys);
      await ensureWorkflowBillingReserved(pool, runId, undefined, keys);
      const attempt = (await workflowBillingAttemptPg(pool, runId))!;
      await pool.query(
        "UPDATE execution.workflow_runs SET status='completed' WHERE id=$1",
        [runId],
      );
      assert.equal(
        await settleWorkflowBillingAttempt(
          pool,
          attempt.operation_key,
          undefined,
          keys,
        ),
        true,
      );
      assert.equal(
        await settleWorkflowBillingAttempt(
          pool,
          attempt.operation_key,
          undefined,
          keys,
        ),
        false,
      );
      assert.equal(service.reservations(), 1);
      assert.equal(
        service.ledger.get(attempt.operation_key)?.status,
        "COMMITTED",
      );
      assert.ok(service.urls.length >= 4);
      assert.ok(
        service.urls.every((url) => url === "https://managed-dev.test"),
      );
    } finally {
      await pool.query(
        "UPDATE secrets.credentials SET metadata_json=$1 WHERE id='credential'",
        [originalMetadata],
      );
      globalThis.fetch = saved.fetch;
      for (const [name, value] of Object.entries({
        DEV_QUALIFICATION_WORKFLOWS: saved.entries,
        DEV_QUALIFICATION_ACCOUNT_API_URL: saved.url,
        MANAGED_QUALIFICATION_WORKFLOWS:saved.managed,
        DEV_CORE_PRIVATE_ORIGIN:saved.origin,
        DEV_CORE_PRIVATE_SECRET:saved.secret,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);
