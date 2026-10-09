import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { decryptString, encryptString } from "@beam-studio/vault";
import { encryptPlaintextWebhookTokens } from "./webhook-token-migration.js";

const SECRET = process.env.BEAM_STUDIO_SECRET_KEY as string;
const PLAINTEXT = "PhBQ0zvY5jV6y1bRr7wKx2Nn";

function poolWith(rows: Array<{ id: string; token: string }>) {
  const updates: Array<{ id: string; token: string }> = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("UPDATE workflow.triggers")) {
        updates.push({ id: String(values[0]), token: String(values[1]) });
        return { rows: [], rowCount: 1 };
      }
      return { rows, rowCount: rows.length };
    },
  } as unknown as PgPool;
  return { pool, updates };
}

test("a plaintext token is encrypted without changing its value", async () => {
  // The token is the URL the customer configured upstream. A new value
  // silently breaks their integration, so only the storage may change.
  const { pool, updates } = poolWith([{ id: "t1", token: PLAINTEXT }]);
  const result = await encryptPlaintextWebhookTokens(pool);

  assert.deepEqual(result, { examined: 1, converted: 1 });
  assert.equal(updates.length, 1);
  assert.notEqual(updates[0]!.token, PLAINTEXT, "it must be stored encrypted");
  assert.equal(
    decryptString(updates[0]!.token, SECRET),
    PLAINTEXT,
    "and must still decrypt to the same token",
  );
});

test("an already-encrypted token is left alone", async () => {
  const { pool, updates } = poolWith([
    { id: "t1", token: encryptString(PLAINTEXT, SECRET) },
  ]);
  const result = await encryptPlaintextWebhookTokens(pool);
  assert.deepEqual(result, { examined: 1, converted: 0 });
  assert.deepEqual(updates, [], "re-encrypting would churn for nothing");
});

test("running twice converts nothing the second time", async () => {
  const { pool, updates } = poolWith([{ id: "t1", token: PLAINTEXT }]);
  await encryptPlaintextWebhookTokens(pool);
  const encrypted = updates[0]!.token;

  const second = poolWith([{ id: "t1", token: encrypted }]);
  const result = await encryptPlaintextWebhookTokens(second.pool);
  assert.deepEqual(result, { examined: 1, converted: 0 });
  assert.deepEqual(second.updates, []);
});

test("a value that is neither ciphertext nor a valid token is not rewritten", async () => {
  // Rewriting it would invent a credential. The trigger is already broken and
  // the operator has to rotate it.
  const { pool, updates } = poolWith([{ id: "t1", token: "too-short" }]);
  const result = await encryptPlaintextWebhookTokens(pool);
  assert.deepEqual(result, { examined: 1, converted: 0 });
  assert.deepEqual(updates, []);
});

test("a mix converts only what needs it", async () => {
  const { pool, updates } = poolWith([
    { id: "plain", token: PLAINTEXT },
    { id: "done", token: encryptString("aaaaaaaaaaaaaaaaaaaaaaaa", SECRET) },
    { id: "broken", token: "nope" },
  ]);
  const result = await encryptPlaintextWebhookTokens(pool);
  assert.deepEqual(result, { examined: 3, converted: 1 });
  assert.deepEqual(
    updates.map((u) => u.id),
    ["plain"],
  );
});
