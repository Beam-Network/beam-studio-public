import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import {
  ciphertextKeyId,
  decryptString,
  encryptString,
  vaultKeyId,
} from "@beam-studio/vault";
import {
  formatRotationReport,
  rotateVaultCiphertext,
} from "./rotate-vault-ciphertext.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_LOST = "c".repeat(64);

function withKeys<T>(
  active: string,
  retired: string | undefined,
  run: () => T | Promise<T>,
) {
  const previousActive = process.env.BEAM_STUDIO_SECRET_KEY;
  const previousRetired = process.env.BEAM_STUDIO_SECRET_KEY_RETIRED;
  process.env.BEAM_STUDIO_SECRET_KEY = active;
  if (retired === undefined) delete process.env.BEAM_STUDIO_SECRET_KEY_RETIRED;
  else process.env.BEAM_STUDIO_SECRET_KEY_RETIRED = retired;
  const restore = () => {
    if (previousActive === undefined) delete process.env.BEAM_STUDIO_SECRET_KEY;
    else process.env.BEAM_STUDIO_SECRET_KEY = previousActive;
    if (previousRetired === undefined)
      delete process.env.BEAM_STUDIO_SECRET_KEY_RETIRED;
    else process.env.BEAM_STUDIO_SECRET_KEY_RETIRED = previousRetired;
  };
  return Promise.resolve().then(run).finally(restore) as Promise<T>;
}

/**
 * A pool holding the three shapes a rotation has to handle: a plain ciphertext
 * column, one with a key-id column beside it, and a token inside jsonb.
 */
function fakeDatabase(seed: {
  credential: string;
  credentialKeyId: string;
  providerKey: string;
  webhookToken: string;
}) {
  const state = { ...seed };
  const present = new Set([
    "secrets.credential_versions",
    "assistant.provider_settings",
    "workflow.triggers",
  ]);
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("to_regclass")) {
        return {
          rows: [
            { present: present.has(String(values[0])) ? values[0] : null },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM secrets.credential_versions")) {
        return { rows: [{ id: "cv1", stored: state.credential }], rowCount: 1 };
      }
      if (sql.includes("UPDATE secrets.credential_versions")) {
        state.credential = String(values[0]);
        // The key id is appended last, after the row's key columns.
        state.credentialKeyId = String(values[values.length - 1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM assistant.provider_settings")) {
        return {
          rows: [
            { organization_id: "org", user_id: "u", stored: state.providerKey },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE assistant.provider_settings")) {
        state.providerKey = String(values[0]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM workflow.triggers")) {
        return {
          rows: [{ id: "t1", stored: state.webhookToken }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE workflow.triggers")) {
        state.webhookToken = String(values[0]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PgPool;
  return { pool, state };
}

async function sessionDirectory(encrypted: string) {
  const base = join(
    await mkdtemp(join(tmpdir(), "beam-rotate-")),
    "oauth.json",
  );
  await mkdir(`${base}.sessions`, { recursive: true });
  await writeFile(
    join(`${base}.sessions`, "browser-1.json"),
    JSON.stringify({ version: 2, encrypted_refresh_token: encrypted }),
  );
  return base;
}

test("a full rotation moves every secret onto the new key", async () => {
  // Under key A: three synthetic secrets and a refresh-token file.
  const seeded = await withKeys(KEY_A, undefined, () => ({
    credential: encryptString(JSON.stringify({ accessKeyId: "AKIA" })),
    credentialKeyId: vaultKeyId(KEY_A),
    providerKey: encryptString("sk-provider"),
    webhookToken: encryptString("PhBQ0zvY5jV6y1bRr7wKx2Nn"),
    refresh: encryptString("refresh-token-value"),
  }));
  const { pool, state } = fakeDatabase(seeded);
  const refreshTokenPath = await sessionDirectory(seeded.refresh);

  // Activate B, retire A, and rotate.
  const report = await withKeys(KEY_B, KEY_A, () =>
    rotateVaultCiphertext(pool, { refreshTokenPath }),
  );

  assert.equal(report.activeKeyId, vaultKeyId(KEY_B));
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.sources.map((entry) => [entry.source, entry.rewritten]),
    [
      ["secrets.credential_versions.encrypted_payload", 1],
      ["assistant.provider_settings.encrypted_api_key", 1],
      ["workflow.triggers.config_json->>token", 1],
    ],
  );
  assert.equal(report.refreshTokenFiles.rewritten, 1);

  // Everything is now under B, including the key-id column beside the value.
  assert.equal(ciphertextKeyId(state.credential), vaultKeyId(KEY_B));
  assert.equal(state.credentialKeyId, vaultKeyId(KEY_B));
  assert.equal(ciphertextKeyId(state.providerKey), vaultKeyId(KEY_B));
  assert.equal(ciphertextKeyId(state.webhookToken), vaultKeyId(KEY_B));

  // And readable with A gone, which is what makes dropping A safe.
  await withKeys(KEY_B, undefined, async () => {
    assert.equal(
      JSON.parse(decryptString(state.credential)).accessKeyId,
      "AKIA",
    );
    assert.equal(decryptString(state.providerKey), "sk-provider");
    assert.equal(decryptString(state.webhookToken), "PhBQ0zvY5jV6y1bRr7wKx2Nn");
    const file = JSON.parse(
      await readFile(
        join(`${refreshTokenPath}.sessions`, "browser-1.json"),
        "utf8",
      ),
    );
    assert.equal(
      decryptString(file.encrypted_refresh_token),
      "refresh-token-value",
    );
  });
});

test("secrets written after the rotation begins are left alone", async () => {
  // A resumed or repeated run must not churn values already on the active key.
  const seeded = await withKeys(KEY_B, undefined, () => ({
    credential: encryptString("already-current"),
    credentialKeyId: vaultKeyId(KEY_B),
    providerKey: encryptString("also-current"),
    webhookToken: encryptString("still-current"),
  }));
  const { pool, state } = fakeDatabase(seeded);
  const before = { ...state };

  const report = await withKeys(KEY_B, KEY_A, () =>
    rotateVaultCiphertext(pool, {
      refreshTokenPath: "/nonexistent/oauth.json",
    }),
  );

  assert.deepEqual(
    report.sources.map((entry) => entry.rewritten),
    [0, 0, 0],
  );
  assert.deepEqual(state, before);
  assert.equal(report.complete, true);
});

test("running it twice is the same as running it once", async () => {
  const seeded = await withKeys(KEY_A, undefined, () => ({
    credential: encryptString("value"),
    credentialKeyId: vaultKeyId(KEY_A),
    providerKey: encryptString("value"),
    webhookToken: encryptString("value"),
  }));
  const { pool, state } = fakeDatabase(seeded);

  await withKeys(KEY_B, KEY_A, () =>
    rotateVaultCiphertext(pool, {
      refreshTokenPath: "/nonexistent/oauth.json",
    }),
  );
  const afterFirst = { ...state };
  const second = await withKeys(KEY_B, KEY_A, () =>
    rotateVaultCiphertext(pool, {
      refreshTokenPath: "/nonexistent/oauth.json",
    }),
  );

  assert.deepEqual(
    second.sources.map((entry) => entry.rewritten),
    [0, 0, 0],
  );
  assert.deepEqual(state, afterFirst);
});

test("a value no key can read is reported, not rewritten, and blocks completion", async () => {
  // The state an operator reaches by dropping a key too early. The rotation
  // must not claim success, because that is what would authorise dropping the
  // remaining key and losing the value for good.
  const seeded = await withKeys(KEY_LOST, undefined, () => ({
    credential: encryptString("written-under-a-key-nobody-holds"),
    credentialKeyId: vaultKeyId(KEY_LOST),
    providerKey: "",
    webhookToken: "",
  }));
  const { pool, state } = fakeDatabase(seeded);
  const untouched = state.credential;

  const report = await withKeys(KEY_B, KEY_A, () =>
    rotateVaultCiphertext(pool, {
      refreshTokenPath: "/nonexistent/oauth.json",
    }),
  );

  assert.equal(report.complete, false);
  assert.equal(report.sources[0]?.unreadable, 1);
  assert.equal(report.sources[0]?.rewritten, 0);
  assert.equal(state.credential, untouched, "the value must be left intact");
  assert.match(formatRotationReport(report), /INCOMPLETE/);
});

test("the report names keys by id and never prints key material", async () => {
  const seeded = await withKeys(KEY_A, undefined, () => ({
    credential: encryptString("value"),
    credentialKeyId: vaultKeyId(KEY_A),
    providerKey: "",
    webhookToken: "",
  }));
  const { pool } = fakeDatabase(seeded);
  const report = await withKeys(KEY_B, KEY_A, () =>
    rotateVaultCiphertext(pool, {
      refreshTokenPath: "/nonexistent/oauth.json",
    }),
  );

  const text = formatRotationReport(report);
  assert.match(text, new RegExp(vaultKeyId(KEY_B)));
  for (const key of [KEY_A, KEY_B]) {
    assert.ok(!text.includes(key), "key material must never be printed");
  }
});

test("a legacy value with no key id is rotated onto the active key", async () => {
  // Rows written before the envelope carried a key id. They are the reason
  // the rotation exists at all, so they must be picked up, not skipped.
  const legacy = legacyEncrypt("pre-keyring-secret", KEY_A);
  const { pool, state } = fakeDatabase({
    credential: legacy,
    credentialKeyId: "local-vault-secret",
    providerKey: "",
    webhookToken: "",
  });

  const report = await withKeys(KEY_B, KEY_A, () =>
    rotateVaultCiphertext(pool, {
      refreshTokenPath: "/nonexistent/oauth.json",
    }),
  );

  assert.equal(report.sources[0]?.rewritten, 1);
  assert.equal(ciphertextKeyId(state.credential), vaultKeyId(KEY_B));
  // The decorative "local-vault-secret" is replaced by a real key id.
  assert.equal(state.credentialKeyId, vaultKeyId(KEY_B));
  await withKeys(KEY_B, undefined, () => {
    assert.equal(decryptString(state.credential), "pre-keyring-secret");
  });
});

test("a table that does not exist is skipped rather than failing", async () => {
  // A target-schema install has none of the legacy public tables.
  const seeded = await withKeys(KEY_A, undefined, () => ({
    credential: encryptString("value"),
    credentialKeyId: vaultKeyId(KEY_A),
    providerKey: "",
    webhookToken: "",
  }));
  const { pool } = fakeDatabase(seeded);
  const report = await withKeys(KEY_B, KEY_A, () =>
    rotateVaultCiphertext(pool, {
      refreshTokenPath: "/nonexistent/oauth.json",
    }),
  );
  assert.deepEqual(
    report.sources.map((entry) => entry.source),
    [
      "secrets.credential_versions.encrypted_payload",
      "assistant.provider_settings.encrypted_api_key",
      "workflow.triggers.config_json->>token",
    ],
  );
});

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
