import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { encryptString, vaultSecretFromEnv } from "@beam-studio/vault";
import { buildServer } from "../server.js";
import { admittedInstance } from "../auth/instance-admission.fixture.js";
import type { InstanceAdmission } from "../auth/instance-admission.js";
import {
  SIGNATURE_WINDOW_SECONDS,
  webhookSigningSecret,
} from "./webhook-signature.js";

const WORKFLOW_ID = "wft_1";
const TRIGGER_ID = "trg_1";
const TOKEN = "PhBQ0zvY5jV6y1bRr7wKx2Nn";
const BODY = '{"recordId":"006Ab0000012345","note":"spacing  matters"}';

/**
 * A pool that answers the trigger lookup and then refuses the delivery.
 *
 * Refusing lets a request that passes the signature gate stop at 429 instead
 * of running the rest of run creation, so a 429 is the proof that verification
 * succeeded — including that the raw bytes reached it intact.
 */
function scriptedPool(options: {
  requireSignature: boolean;
  replay?: boolean;
}) {
  const config = {
    token: encryptString(TOKEN, vaultSecretFromEnv()),
    coalesceWindowSeconds: 0,
    maxConcurrentRuns: 1,
    rateLimitPerMinute: 1,
    requireSignature: options.requireSignature,
  };
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM workflow.triggers t")) {
        return {
          rows: [
            {
              id: TRIGGER_ID,
              workflow_template_id: WORKFLOW_ID,
              type: "webhook",
              enabled: true,
              config_json: config,
              organization_id: "org_1",
              workflow_enabled: true,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("workflow.webhook_deliveries")) {
        if (options.replay) {
          // What the partial unique index on (trigger_id, signature) raises.
          throw Object.assign(new Error("duplicate key value"), {
            code: "23505",
          });
        }
        // Above rateLimitPerMinute, so an accepted delivery answers 429.
        return { rows: [{ deliveries: 5 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PgPool;
}

function headersFor(body: string, timestamp: number) {
  const secret = webhookSigningSecret(TRIGGER_ID, TOKEN);
  return {
    "content-type": "application/json",
    "x-beam-signature": `v1=${createHmac("sha256", secret)
      .update(`v1:${timestamp}:${body}`)
      .digest("hex")}`,
    "x-beam-timestamp": String(timestamp),
  };
}

async function post(
  pool: PgPool,
  body: string,
  headers: Record<string, string>,
  // The workflow behind this trigger belongs to a served organization unless
  // a case says otherwise; most cases are about the signature, not admission.
  admission: InstanceAdmission = admittedInstance(["org_1"]),
) {
  const previous = (globalThis as { __beamStudioPgPool?: PgPool })
    .__beamStudioPgPool;
  (globalThis as { __beamStudioPgPool?: PgPool }).__beamStudioPgPool = pool;
  const server = await buildServer({ pgPool: pool, admission });
  try {
    return await server.inject({
      method: "POST",
      url: `/hooks/workflows/${WORKFLOW_ID}/${TRIGGER_ID}/${TOKEN}`,
      headers,
      payload: body,
    });
  } finally {
    await server.close();
    (globalThis as { __beamStudioPgPool?: PgPool }).__beamStudioPgPool =
      previous;
  }
}

test("a correctly signed delivery reaches the rate limiter", async () => {
  // 429 means the signature verified: the body bytes survived the route's
  // content-type parser unchanged, including the double space in the payload.
  const response = await post(
    scriptedPool({ requireSignature: true }),
    BODY,
    headersFor(BODY, Math.floor(Date.now() / 1000)),
  );
  assert.equal(response.statusCode, 429);
});

test("a trigger requiring a signature refuses a request without one", async () => {
  const response = await post(scriptedPool({ requireSignature: true }), BODY, {
    "content-type": "application/json",
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().details.reason, "missing");
});

test("a signature over different bytes is refused", async () => {
  const response = await post(
    scriptedPool({ requireSignature: true }),
    BODY,
    headersFor('{"recordId":"other"}', Math.floor(Date.now() / 1000)),
  );
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().details.reason, "mismatch");
});

test("a delivery outside the timestamp window is refused", async () => {
  const stale = Math.floor(Date.now() / 1000) - SIGNATURE_WINDOW_SECONDS - 60;
  const response = await post(
    scriptedPool({ requireSignature: true }),
    BODY,
    headersFor(BODY, stale),
  );
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().details.reason, "stale");
});

test("a signature already spent is refused as a replay", async () => {
  const response = await post(
    scriptedPool({ requireSignature: true, replay: true }),
    BODY,
    headersFor(BODY, Math.floor(Date.now() / 1000)),
  );
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().details.reason, "replayed");
});

test("a trigger that does not require a signature ignores the headers", async () => {
  // Off by default, because the token is in the URL precisely for senders
  // that cannot set custom headers.
  const response = await post(scriptedPool({ requireSignature: false }), BODY, {
    "content-type": "application/json",
  });
  assert.equal(response.statusCode, 429);
});

test("a wrong token is still a 404, signature or not", async () => {
  const pool = scriptedPool({ requireSignature: true });
  const previous = (globalThis as { __beamStudioPgPool?: PgPool })
    .__beamStudioPgPool;
  (globalThis as { __beamStudioPgPool?: PgPool }).__beamStudioPgPool = pool;
  const server = await buildServer({
    pgPool: pool,
    // The workflow behind this trigger belongs to a served organization; these
    // cases are about the signature, not about admission.
    admission: admittedInstance(["org_1"]),
  });
  try {
    const response = await server.inject({
      method: "POST",
      url: `/hooks/workflows/${WORKFLOW_ID}/${TRIGGER_ID}/wrong-token-here-000000`,
      headers: headersFor(BODY, Math.floor(Date.now() / 1000)),
      payload: BODY,
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await server.close();
    (globalThis as { __beamStudioPgPool?: PgPool }).__beamStudioPgPool =
      previous;
  }
});

// A webhook trigger is a machine caller: like an MCP token or an agent, it is
// served only for an organization whose admission was recorded (or that is
// exempt). An open join policy admits browser sessions, never webhooks.
test("an open policy does not serve a webhook of an unrecorded organization", async () => {
  const response = await post(
    scriptedPool({ requireSignature: false }),
    BODY,
    { "content-type": "application/json" },
    admittedInstance(["org_owner"], { joinPolicy: "open" }),
  );
  // Refused exactly like an unknown trigger.
  assert.equal(response.statusCode, 404, response.body);
});

test("an open policy serves a webhook once its organization is admitted", async () => {
  const response = await post(
    scriptedPool({ requireSignature: false }),
    BODY,
    { "content-type": "application/json" },
    admittedInstance(["org_owner", "org_1"], { joinPolicy: "open" }),
  );
  assert.equal(response.statusCode, 429, response.body);
});

test("the Rooms consumer organization's webhooks are always served", async () => {
  for (const joinPolicy of ["open", "request", "closed"] as const) {
    const response = await post(
      scriptedPool({ requireSignature: false }),
      BODY,
      { "content-type": "application/json" },
      admittedInstance(["org_owner"], {
        joinPolicy,
        consumerOrganizationId: "org_1",
      }),
    );
    assert.equal(response.statusCode, 429, `${joinPolicy}: ${response.body}`);
  }
});
