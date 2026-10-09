import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import test from "node:test";
import {
  ACTIVE_KEY_ENV,
  ciphertextKeyId,
  decryptString,
  derivedSecret,
  derivedSecrets,
  encryptString,
  isLegacyCiphertext,
  RETIRED_KEYS_ENV,
  vaultKeyById,
  vaultKeyId,
  vaultKeyring,
  vaultSecretFromEnv,
} from "./index.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);

function withKeys<T>(
  active: string,
  retired: string | undefined,
  run: () => T,
) {
  const previousActive = process.env[ACTIVE_KEY_ENV];
  const previousRetired = process.env[RETIRED_KEYS_ENV];
  process.env[ACTIVE_KEY_ENV] = active;
  if (retired === undefined) delete process.env[RETIRED_KEYS_ENV];
  else process.env[RETIRED_KEYS_ENV] = retired;
  try {
    return run();
  } finally {
    if (previousActive === undefined) delete process.env[ACTIVE_KEY_ENV];
    else process.env[ACTIVE_KEY_ENV] = previousActive;
    if (previousRetired === undefined) delete process.env[RETIRED_KEYS_ENV];
    else process.env[RETIRED_KEYS_ENV] = previousRetired;
  }
}

test("a key id names the key without exposing it", () => {
  const id = vaultKeyId(KEY_A);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.notEqual(id, vaultKeyId(KEY_B));
  assert.equal(id, vaultKeyId(KEY_A));
  assert.ok(!KEY_A.includes(id));
});

test("the keyring is the active key first, then the retired ones", () => {
  withKeys(KEY_A, `${KEY_B}, ${KEY_C}`, () => {
    const keyring = vaultKeyring();
    assert.equal(keyring.active.secret, KEY_A);
    assert.deepEqual(
      keyring.all.map((key) => key.secret),
      [KEY_A, KEY_B, KEY_C],
    );
  });
});

test("a retired entry equal to the active key is dropped, not rejected", () => {
  // The state an operator lands in halfway through a rotation.
  withKeys(KEY_A, KEY_A, () => {
    assert.equal(vaultKeyring().all.length, 1);
  });
});

test("an empty retired list is not a key", () => {
  withKeys(KEY_A, " , ,", () => {
    assert.equal(vaultKeyring().all.length, 1);
  });
});

test("a published placeholder is refused wherever it appears", () => {
  const placeholder = "change-me-to-a-long-random-secret";
  withKeys(placeholder, undefined, () => {
    assert.throws(() => vaultKeyring(), /placeholder published/);
  });
  withKeys(KEY_A, placeholder, () => {
    // A retired placeholder is a key an attacker already has; accepting it
    // would undo the point of retiring anything.
    assert.throws(() => vaultKeyring(), /placeholder published/);
  });
});

test("a short retired key is refused like a short active one", () => {
  withKeys(KEY_A, "too-short", () => {
    assert.throws(() => vaultKeyring(), /at least 32 characters/);
  });
});

test("ciphertext records the key that wrote it", () => {
  withKeys(KEY_A, undefined, () => {
    const payload = encryptString("secret value");
    assert.equal(ciphertextKeyId(payload), vaultKeyId(KEY_A));
    assert.ok(!isLegacyCiphertext(payload));
  });
});

test("a value written under a key that is now retired still decrypts", () => {
  // The whole point: rotating the active key must not make stored secrets
  // unreadable, or rotation is not something an operator can do.
  const payload = withKeys(KEY_A, undefined, () => encryptString("provider"));
  withKeys(KEY_B, KEY_A, () => {
    assert.equal(decryptString(payload), "provider");
  });
});

test("a value whose key is not on the ring fails closed, naming the key", () => {
  const payload = withKeys(KEY_A, undefined, () => encryptString("provider"));
  withKeys(KEY_B, undefined, () => {
    assert.throws(
      () => decryptString(payload),
      (error: Error) =>
        error.message.includes(vaultKeyId(KEY_A)) &&
        // The message must help an operator without printing key material.
        !error.message.includes(KEY_A),
    );
  });
});

test("re-encrypting moves a value onto the active key", () => {
  const original = withKeys(KEY_A, undefined, () => encryptString("provider"));
  const rotated = withKeys(KEY_B, KEY_A, () =>
    encryptString(decryptString(original)),
  );
  assert.equal(ciphertextKeyId(rotated), vaultKeyId(KEY_B));
  withKeys(KEY_B, undefined, () => {
    // Readable with the old key gone, which is what permits dropping it.
    assert.equal(decryptString(rotated), "provider");
  });
});

test("a v1 payload is recognised and read by whichever key wrote it", () => {
  // Written by the pre-keyring envelope: no prefix, no key id.
  const legacy = legacyEncrypt("provider", KEY_A);
  assert.ok(isLegacyCiphertext(legacy));
  assert.equal(ciphertextKeyId(legacy), "");
  withKeys(KEY_B, KEY_A, () => {
    assert.equal(decryptString(legacy), "provider");
  });
});

test("a v1 payload no key can read throws rather than returning nonsense", () => {
  const legacy = legacyEncrypt("provider", KEY_C);
  withKeys(KEY_A, KEY_B, () => {
    assert.throws(() => decryptString(legacy));
  });
});

test("derived secrets cover the whole ring, active first", () => {
  withKeys(KEY_A, KEY_B, () => {
    const secrets = derivedSecrets("beam-studio.browser-session.v1");
    assert.equal(secrets.length, 2);
    assert.equal(secrets[0], derivedSecret("beam-studio.browser-session.v1"));
    assert.notEqual(secrets[0], secrets[1]);
  });
  withKeys(KEY_B, undefined, () => {
    // Same key, same derivation — a cookie signed before the rotation is what
    // the retired entry above is there to keep verifying.
    assert.equal(
      derivedSecret("beam-studio.browser-session.v1"),
      withKeys(KEY_A, KEY_B, () =>
        derivedSecrets("beam-studio.browser-session.v1"),
      )[1],
    );
  });
});

test("a purpose keys one thing only", () => {
  withKeys(KEY_A, undefined, () => {
    assert.notEqual(
      derivedSecret("beam-studio.ops.v1"),
      derivedSecret("beam-studio.browser-session.v1"),
    );
    assert.notEqual(derivedSecret("beam-studio.ops.v1"), vaultSecretFromEnv());
  });
});

test("a key can be looked up by id", () => {
  withKeys(KEY_A, KEY_B, () => {
    assert.equal(vaultKeyById(vaultKeyId(KEY_B))?.secret, KEY_B);
    assert.equal(vaultKeyById(vaultKeyId(KEY_C)), undefined);
  });
});

/** The pre-keyring envelope, reproduced so the migration path stays covered. */
function legacyEncrypt(value: string, secret: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    scryptSync(secret, salt, 32),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}
