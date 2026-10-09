import { pgMany, type PgPool } from "@beam-studio/db";
import {
  decryptString,
  encryptString,
  vaultSecretFromEnv,
} from "@beam-studio/vault";

/**
 * Encrypts webhook trigger tokens that are still stored in plaintext.
 *
 * Webhook tokens used to sit in `workflow.triggers.config_json` as plaintext,
 * unlike every other secret Studio stores. Encrypting them at rest means
 * existing rows have to be converted, and the token **value** must not change
 * — it is the URL a customer has already configured upstream, so a new token
 * silently breaks their integration.
 *
 * This runs at boot and is idempotent: a token that already decrypts is left
 * alone. Read paths therefore only ever decrypt, rather than having to
 * tolerate both shapes forever.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,128}$/;

export async function encryptPlaintextWebhookTokens(pool: PgPool) {
  const secret = vaultSecretFromEnv();
  const rows = await pgMany<{ id: string; token: string | null }>(
    pool,
    `SELECT id, config_json->>'token' AS token
       FROM workflow.triggers
      WHERE type = 'webhook'
        AND config_json ? 'token'
        AND config_json->>'token' <> ''`,
  );

  let converted = 0;
  for (const row of rows) {
    const stored = String(row.token ?? "");
    // Already ciphertext: decrypting it succeeds, so leave it.
    try {
      decryptString(stored, secret);
      continue;
    } catch {
      // Not readable as ciphertext, so it is either plaintext or unusable.
    }
    if (!TOKEN_SHAPE.test(stored)) {
      // Neither ciphertext nor a valid token. Rewriting it would invent a
      // credential; the trigger is already broken and the operator has to
      // rotate it.
      continue;
    }
    await pool.query(
      `UPDATE workflow.triggers
          SET config_json = jsonb_set(config_json, '{token}', to_jsonb($2::text)),
              updated_at = now()
        WHERE id = $1`,
      [row.id, encryptString(stored, secret)],
    );
    converted += 1;
  }
  return { examined: rows.length, converted };
}
