import assert from "node:assert/strict";
import test from "node:test";
import {
  ActionNotBillableError,
  BILLABLE_ACTIONS,
  releaseReservation,
  reserveAction,
} from "./action-gate.js";
import { CreditClient, CreditReservationError } from "./credit-client.js";

type Recorded = {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
};

/** Studio always has the raw key on hand in these tests. */
const rawKey = () => "bm_live_raw_secret";

/** A CreditClient whose HTTP layer is replaced by a scripted response. */
function clientReturning(
  status: number,
  payload: Record<string, unknown>,
  recorded: Recorded[] = [],
) {
  return new CreditClient({
    apiUrl: "https://api.test",
    fetch: (async (input: URL, init: RequestInit) => {
      recorded.push({
        url: String(input),
        body: JSON.parse(String(init.body)),
        headers: new Headers(init.headers),
      });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      };
    }) as never,
  });
}

test("a billable action must name the key it is charged to", async () => {
  // An organization can hold many keys with different caps and budgets, so
  // charging an arbitrary one would spend an allowance meant for something else.
  await assert.rejects(
    () => reserveAction({ action: "room.start", apiKeyId: null }),
    ActionNotBillableError,
  );
  await assert.rejects(
    () => reserveAction({ action: "transfer.run", apiKeyId: "" }),
    ActionNotBillableError,
  );
});

test("reserving names the action and leaves price and permission to Beam", async () => {
  const recorded: Recorded[] = [];
  const client = clientReturning(
    200,
    { success: true, operation: { idempotencyKey: "k", creditsUsed: 3 } },
    recorded,
  );

  const reservation = await reserveAction(
    { action: "room.start", apiKeyId: "key_1" },
    client,
    rawKey,
  );

  assert.deepEqual(
    recorded.map((call) => new URL(call.url).pathname),
    ["/v1/usage/reservations"],
  );
  const reserveCall = recorded[0]!;
  assert.equal(reservation.creditsUsed, 3);
  assert.equal(reserveCall.body.action, "room.start");
  assert.match(String(reserveCall.body.idempotencyKey), /^room\.start:/);
  // Beam derives the profile and the rooms:start permission from the action
  // and the price from its price book, so the caller supplies none of them.
  for (const field of [
    "keyId",
    "billingProfileId",
    "requiredPermission",
    "creditsUsed",
  ])
    assert.equal(reserveCall.body[field], undefined, field);
});

test("reserves with the stored key itself, never a shared secret or Studio's own id", async () => {
  const recorded: Recorded[] = [];
  const client = clientReturning(
    200,
    { success: true, operation: { idempotencyKey: "k", creditsUsed: 1 } },
    recorded,
  );

  await reserveAction(
    { action: "room.start", apiKeyId: "key_studio_local" },
    client,
    rawKey,
  );

  const reserveCall = recorded[0]!;
  assert.equal(
    reserveCall.headers.get("authorization"),
    "Bearer bm_live_raw_secret",
  );
  assert.deepEqual([...reserveCall.headers.keys()].sort(), [
    "authorization",
    "content-type",
  ]);
  assert.doesNotMatch(JSON.stringify(reserveCall.body), /key_studio_local/);
});

test("a key Studio cannot decrypt is refused before any billing call", async () => {
  const recorded: Recorded[] = [];
  const client = clientReturning(
    200,
    { valid: true, keyId: "k", success: true },
    recorded,
  );

  await assert.rejects(
    () =>
      reserveAction(
        { action: "transfer.run", apiKeyId: "key_1" },
        client,
        () => null,
      ),
    ActionNotBillableError,
  );
  assert.equal(recorded.length, 0);
});

test("separate non-workflow invocations receive distinct reservation identities", async () => {
  const recorded: Recorded[] = [];
  const client = clientReturning(
    200,
    { success: true, operation: { idempotencyKey: "k", creditsUsed: 1 } },
    recorded,
  );

  const first = await reserveAction(
    { action: "room.start", apiKeyId: "key_1" },
    client,
    rawKey,
  );
  const second = await reserveAction(
    { action: "room.start", apiKeyId: "key_1" },
    client,
    rawKey,
  );

  assert.notEqual(first.operationKey, second.operationKey);
  assert.match(String(first.operationKey), /^room\.start:/);
});

test("transfers are checked but not held, because BeamCore bills the bytes", async () => {
  // BeamCore settles a transfer from the bytes it actually moved, keyed on the
  // transfer id. A hold here would charge the same transfer a second time under
  // a different idempotency key, and Studio never learns the byte count.
  const recorded: Recorded[] = [];
  const client = clientReturning(
    200,
    { valid: true, keyId: "key_test", success: true },
    recorded,
  );

  const result = await reserveAction(
    { action: "transfer.run", apiKeyId: "key_1" },
    client,
    rawKey,
  );

  assert.equal(result.operationKey, null);
  assert.equal(result.creditsUsed, 0);
  // The key is still verified, so a transfer cannot start on a key that cannot pay.
  assert.deepEqual(
    recorded.map((call) => new URL(call.url).pathname),
    ["/api/keys/verify"],
  );
  assert.equal(recorded[0]!.body.apiKey, "bm_live_raw_secret");
});

test("releasing a hold that was never taken does nothing", async () => {
  const recorded: Recorded[] = [];
  const client = clientReturning(200, { success: true }, recorded);

  await releaseReservation(
    {
      operationKey: null,
      creditsUsed: 0,
      apiKeyId: "key_1",
      organizationId: null,
    },
    "transfer was never queued",
    client,
    rawKey,
  );

  assert.equal(recorded.length, 0);
});

test("releasing a hold cancels it with the key that took it", async () => {
  const recorded: Recorded[] = [];
  const client = clientReturning(200, { success: true }, recorded);

  await releaseReservation(
    {
      operationKey: "room.start:op/1",
      creditsUsed: 1,
      apiKeyId: "key_1",
      organizationId: "org_1",
    },
    "never started",
    client,
    rawKey,
  );

  assert.equal(
    new URL(recorded[0]!.url).pathname,
    "/v1/usage/reservations/room.start%3Aop%2F1/cancel",
  );
  assert.deepEqual(recorded[0]!.body, { reason: "never started" });
  assert.equal(
    recorded[0]!.headers.get("authorization"),
    "Bearer bm_live_raw_secret",
  );
});

test("an exhausted pool surfaces as 402 carrying which limit was hit", async () => {
  const client = clientReturning(402, {
    success: false,
    error: "Insufficient credits",
    reason: "pool_exhausted",
  });

  await assert.rejects(
    () =>
      reserveAction(
        { action: "transfer.run", apiKeyId: "key_1" },
        client,
        rawKey,
      ),
    (error: unknown) => {
      assert.ok(error instanceof CreditReservationError);
      assert.equal(error.code, "insufficient_credit");
      assert.equal(error.statusCode, 402);
      // The operator needs to know whether to top up the organization or raise
      // this one key's cap.
      assert.equal(error.reason, "pool_exhausted");
      return true;
    },
  );
});

test("a key at its own cap is reported separately from an empty pool", async () => {
  const client = clientReturning(402, {
    success: false,
    error: "API key credit limit exhausted",
    reason: "key_cap_exhausted",
  });

  await assert.rejects(
    () =>
      reserveAction(
        { action: "transfer.run", apiKeyId: "key_1" },
        client,
        rawKey,
      ),
    (error: unknown) => {
      assert.ok(error instanceof CreditReservationError);
      assert.equal(error.reason, "key_cap_exhausted");
      return true;
    },
  );
});

test("a key Beam rejects is reported as an invalid key, not an outage", async () => {
  const client = clientReturning(401, {
    success: false,
    code: "api_key_authentication_required",
  });

  await assert.rejects(
    () =>
      reserveAction(
        { action: "room.start", apiKeyId: "key_1" },
        client,
        rawKey,
      ),
    (error: unknown) => {
      assert.ok(error instanceof CreditReservationError);
      assert.equal(error.code, "invalid_key");
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
});

test("a billing outage is not reported as being out of credit", async () => {
  // Charging nothing and running anyway would be wrong, but so would telling a
  // funded organization it has no credit.
  const client = clientReturning(500, { success: false, error: "boom" });

  await assert.rejects(
    () =>
      reserveAction(
        { action: "transfer.run", apiKeyId: "key_1" },
        client,
        rawKey,
      ),
    (error: unknown) => {
      assert.ok(error instanceof CreditReservationError);
      assert.equal(error.code, "billing_unavailable");
      return true;
    },
  );
});

test("unconfirmed settlement rejects so durable recovery cannot mark a hold settled", async () => {
  const client = clientReturning(503, { success: false, error: "unavailable" });

  await assert.rejects(() =>
    releaseReservation(
      {
        operationKey: "room.start:op-1",
        creditsUsed: 1,
        apiKeyId: "key_1",
        organizationId: null,
      },
      "never queued",
      client,
      rawKey,
    ),
  );
});

test("every billable action declares a profile and a non-transfer permission", () => {
  for (const [action, definition] of Object.entries(BILLABLE_ACTIONS)) {
    assert.ok(definition.billingProfileId.startsWith("beam."), action);
    assert.match(definition.permission, /^[a-z_]+:[a-z_]+$/, action);
  }

  // Rooms and workflows must not be authorized as transfer creation.
  assert.equal(BILLABLE_ACTIONS["room.start"].permission, "rooms:start");
});
