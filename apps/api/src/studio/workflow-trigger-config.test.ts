import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptString,
  encryptString,
  vaultSecretFromEnv,
} from "@beam-studio/vault";
import { sanitizeWorkflowTriggerConfigForTest } from "./store.js";

const VALID = "PhBQ0zvY5jV6y1bRr7wKx2Nn";
const STORED = encryptString(VALID, vaultSecretFromEnv());
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,128}$/;

function sanitize(config: Record<string, unknown>, mint = false) {
  return sanitizeWorkflowTriggerConfigForTest("webhook", config, mint) as {
    token: string;
  };
}

test("a stored webhook token is decrypted on read", () => {
  // The read path feeds the URL Studio displays, and the URL is the token, so
  // it has to come back as plaintext.
  assert.equal(sanitize({ token: STORED }).token, VALID);
});

test("a written token is stored as ciphertext", () => {
  const { token } = sanitize({ token: VALID }, true);
  assert.notEqual(token, VALID);
  assert.equal(decryptString(token, vaultSecretFromEnv()), VALID);
});

test("saving a trigger the UI just read does not double encrypt", () => {
  // The console round-trips the whole config object, so a write often carries
  // the plaintext a read handed out. Encrypting that twice would leave a
  // ciphertext blob as the token value.
  const { token } = sanitize(
    { token: sanitize({ token: STORED }).token },
    true,
  );
  assert.equal(decryptString(token, vaultSecretFromEnv()), VALID);
});

test("rewriting stored ciphertext unchanged keeps the same token", () => {
  const { token } = sanitize({ token: STORED }, true);
  assert.equal(decryptString(token, vaultSecretFromEnv()), VALID);
});

test("reading a malformed token does not mint a replacement", () => {
  // It used to return a fresh token on every read, so the webhook URL Studio
  // displayed differed each time and never matched the stored one — silently
  // breaking the URL the customer had configured upstream.
  const first = sanitize({ token: "not-ciphertext" });
  const second = sanitize({ token: "not-ciphertext" });
  assert.equal(first.token, "");
  assert.equal(second.token, "");
});

test("reading a token encrypted under a different key yields nothing", () => {
  assert.equal(
    sanitize({ token: encryptString(VALID, "another-key") }).token,
    "",
  );
});

test("writing a trigger without a usable token mints exactly one", () => {
  const { token } = sanitize({ token: "" }, true);
  assert.match(decryptString(token, vaultSecretFromEnv()), TOKEN_SHAPE);
});
