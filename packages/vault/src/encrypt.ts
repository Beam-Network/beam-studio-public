import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  vaultKeyById,
  vaultKeyId,
  vaultKeyring,
  vaultSecretFromEnv,
  type VaultKeyring,
} from "./keyring.js";

const algorithm = "aes-256-gcm";

/**
 * The envelope, version 2:
 *
 *     "v2." + base64( keyId[8] || salt[16] || iv[12] || tag[16] || ciphertext )
 *
 * Version 1 was the same without the key id and without the prefix, so a
 * single key change made every stored secret unreadable with no way to tell
 * which key a value needed. Recording the key id is what makes rotation
 * possible: a reader resolves the exact key rather than guessing, and a value
 * written under a key nobody holds any more fails with a clear error instead
 * of an authentication-tag failure that looks like corruption.
 *
 * The prefix sits outside the base64 because base64 has no "." — a v1 payload
 * can never be mistaken for a v2 one, which a leading version byte inside the
 * ciphertext could not guarantee against a random salt.
 */
const ENVELOPE_PREFIX = "v2.";
const KEY_ID_BYTES = 8;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function deriveVaultKey(secret: string, salt: Buffer) {
  return scryptSync(secret, salt, 32);
}

/**
 * @param secret  The key to encrypt under. Defaults to the active key, which
 *   is the only correct choice outside a rotation: a retired key must never
 *   write new ciphertext.
 */
export function encryptString(value: string, secret = vaultSecretFromEnv()) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveVaultKey(secret, salt);
  const cipher = createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  return (
    ENVELOPE_PREFIX +
    Buffer.concat([
      Buffer.from(vaultKeyId(secret), "hex"),
      salt,
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]).toString("base64")
  );
}

/** The id of the key a payload was written under, or "" for a v1 payload. */
export function ciphertextKeyId(payload: string) {
  if (!payload.startsWith(ENVELOPE_PREFIX)) return "";
  return Buffer.from(payload.slice(ENVELOPE_PREFIX.length), "base64")
    .subarray(0, KEY_ID_BYTES)
    .toString("hex");
}

/** Whether a payload still needs converting to the current envelope. */
export function isLegacyCiphertext(payload: string) {
  return Boolean(payload) && !payload.startsWith(ENVELOPE_PREFIX);
}

/**
 * @param secret  A key to try first. Only useful where the caller knows which
 *   key it wants — a rotation reading under a specific retired key, or a test.
 *   Normal callers omit it and let the envelope name its own key.
 */
export function decryptString(
  payload: string,
  secret?: string,
  keyring?: VaultKeyring,
) {
  if (!payload.startsWith(ENVELOPE_PREFIX)) {
    return decryptLegacyString(payload, secret, keyring);
  }
  const raw = Buffer.from(payload.slice(ENVELOPE_PREFIX.length), "base64");
  const id = raw.subarray(0, KEY_ID_BYTES).toString("hex");

  const key =
    secret && vaultKeyId(secret) === id
      ? secret
      : vaultKeyById(id, keyring ?? vaultKeyring())?.secret;
  if (!key) {
    // Named rather than guessed, so an operator who dropped a key too early
    // sees which one to put back. The id is an HMAC, so it is safe to print.
    throw new Error(
      `No configured vault key matches encryption key id ${id}. ` +
        "Add the key that wrote this value to BEAM_STUDIO_SECRET_KEY_RETIRED.",
    );
  }
  return openEnvelope(raw.subarray(KEY_ID_BYTES), key);
}

/**
 * Reads the pre-keyring envelope, which carried no key id.
 *
 * Every key on the ring has to be tried, because the payload does not say
 * which one wrote it — the whole reason the id was added. Values are converted
 * on the way past by `rotateVaultCiphertext`, so this shrinks to nothing once
 * a rotation has run.
 */
export function decryptLegacyString(
  payload: string,
  secret?: string,
  keyring?: VaultKeyring,
) {
  const raw = Buffer.from(payload, "base64");
  const ring = (keyring ?? vaultKeyring()).all.map((key) => key.secret);
  // The caller's preference first, then the rest of the ring: a v1 value could
  // have been written under a key that is now retired, and refusing to look
  // would make those values unrecoverable at exactly the moment rotation is
  // supposed to help.
  const candidates = secret
    ? [secret, ...ring.filter((key) => key !== secret)]
    : ring;
  let failure: unknown;
  for (const candidate of candidates) {
    try {
      return openEnvelope(raw, candidate);
    } catch (error) {
      failure = error;
    }
  }
  throw failure ?? new Error("No vault key could read this value.");
}

function openEnvelope(raw: Buffer, secret: string) {
  let offset = 0;
  const salt = raw.subarray(offset, (offset += SALT_BYTES));
  const iv = raw.subarray(offset, (offset += IV_BYTES));
  const tag = raw.subarray(offset, (offset += TAG_BYTES));
  const ciphertext = raw.subarray(offset);

  const decipher = createDecipheriv(
    algorithm,
    deriveVaultKey(secret, salt),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
