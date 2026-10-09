import { createHmac } from "node:crypto";

/**
 * The keys this installation can decrypt with, and the one it encrypts with.
 *
 * Rotating a single environment variable used to make every stored secret
 * unreadable, which meant rotation was not something an operator could
 * actually do. A keyring separates the two questions: `BEAM_STUDIO_SECRET_KEY`
 * is what new ciphertext is written under, and `BEAM_STUDIO_SECRET_KEY_RETIRED`
 * lists keys that may still be read. Every ciphertext records which key wrote
 * it, so a rotation is: add the old key to the retired list, put a new one in
 * `BEAM_STUDIO_SECRET_KEY`, restart, re-encrypt, then drop the old key.
 *
 * A retired key can never encrypt. Nothing here widens what an installation
 * accepts — a key still has to be configured to be usable.
 */

/**
 * Placeholder secrets that have shipped in this repository. A deny-list is only
 * ever a backstop, but these specific strings are published, so a deployment
 * that reaches one has no confidentiality at all and must not start.
 */
const PUBLISHED_PLACEHOLDER_SECRETS = new Set([
  "local-beam-studio-secret-change-before-production",
  "change-me-to-a-long-random-secret",
]);

const MINIMUM_SECRET_LENGTH = 32;
const KEY_ID_PURPOSE = "beam-studio.key-id.v1";
const KEY_ID_BYTES = 8;

export const ACTIVE_KEY_ENV = "BEAM_STUDIO_SECRET_KEY";
export const RETIRED_KEYS_ENV = "BEAM_STUDIO_SECRET_KEY_RETIRED";

export type VaultKey = { id: string; secret: string };

export type VaultKeyring = {
  /** The key new ciphertext is written under. */
  active: VaultKey;
  /** Active first, then retired, in the order they were configured. */
  all: readonly VaultKey[];
};

/**
 * A key's non-secret name, used in `encryption_key_id`, in the ciphertext
 * envelope and in operator output.
 *
 * It is an HMAC of the key rather than a number an operator assigns, so two
 * installations never disagree about which key an id means and nothing has to
 * be kept in sync with the environment. HMAC is one-way, so publishing the id
 * does not weaken the key.
 */
export function vaultKeyId(secret: string) {
  return createHmac("sha256", secret)
    .update(KEY_ID_PURPOSE)
    .digest("hex")
    .slice(0, KEY_ID_BYTES * 2);
}

/** Refuses a key that provides no confidentiality, whatever its source. */
function assertUsableSecret(secret: string, source: string) {
  if (PUBLISHED_PLACEHOLDER_SECRETS.has(secret)) {
    throw new Error(
      `${source} is a placeholder published in the Beam Studio repository ` +
        "and provides no confidentiality. Generate one with `openssl rand -hex 32`.",
    );
  }
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `${source} must be at least ${MINIMUM_SECRET_LENGTH} characters. ` +
        "Generate one with `openssl rand -hex 32`.",
    );
  }
}

/**
 * Resolves the active vault key, or refuses to start.
 *
 * This deliberately does not consult NODE_ENV. Keying the check on an
 * operator-settable string meant the guard was off wherever it mattered most:
 * the hosted deployment ran with NODE_ENV=development, and the Compose default
 * was a *different* published literal than the one the check rejected, so it
 * passed straight through and became the key.
 */
export function vaultSecretFromEnv() {
  const secret = process.env[ACTIVE_KEY_ENV]?.trim();
  if (!secret) {
    throw new Error(
      `${ACTIVE_KEY_ENV} is required. Generate one with \`openssl rand -hex 32\`.`,
    );
  }
  assertUsableSecret(secret, ACTIVE_KEY_ENV);
  return secret;
}

/**
 * The keyring from the environment.
 *
 * Retired keys are held to the same standard as the active one: a placeholder
 * left in the retired list would be a key an attacker already knows, and
 * accepting it would undo the point of retiring anything. A retired entry
 * equal to the active key is dropped rather than rejected, because that is the
 * harmless state an operator lands in mid-rotation.
 */
export function vaultKeyring(): VaultKeyring {
  const activeSecret = vaultSecretFromEnv();
  const active = { id: vaultKeyId(activeSecret), secret: activeSecret };

  const all = [active];
  const seen = new Set([active.id]);
  for (const entry of (process.env[RETIRED_KEYS_ENV] ?? "").split(",")) {
    const secret = entry.trim();
    if (!secret) continue;
    assertUsableSecret(secret, RETIRED_KEYS_ENV);
    const id = vaultKeyId(secret);
    if (seen.has(id)) continue;
    seen.add(id);
    all.push({ id, secret });
  }
  return { active, all };
}

/** The configured key with this id, or undefined when it is not held. */
export function vaultKeyById(id: string, keyring = vaultKeyring()) {
  return keyring.all.find((key) => key.id === id);
}

/**
 * Every secret derived from a configured key for one purpose, active first.
 *
 * Signing uses the active key; verification walks this list, so a token or
 * cookie issued under a key that is now retired keeps working until that key
 * is dropped. That is what makes rotation a separate event from invalidating
 * everyone's session — the invalidation happens on retirement, deliberately,
 * rather than as a side effect of changing a variable.
 */
export function derivedSecrets(purpose: string, keyring = vaultKeyring()) {
  return keyring.all.map((key) =>
    createHmac("sha256", key.secret).update(purpose).digest("base64url"),
  );
}

/**
 * Derives a purpose-specific secret from the active vault key, so a single
 * configured secret can key several independent things without any of them
 * sharing a value or needing its own environment variable and its own
 * fallback.
 */
export function derivedSecret(purpose: string, keyring = vaultKeyring()) {
  return derivedSecrets(purpose, keyring)[0] as string;
}
