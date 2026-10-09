import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  SIGNATURE_WINDOW_SECONDS,
  verifyWebhookSignature,
  webhookSigningSecret,
} from "./webhook-signature.js";

const SECRET = "a-webhook-signing-secret";
const BODY = '{"recordId":"006Ab0000012345"}';
const NOW = 1_800_000_000_000;

function sign(body: string, timestamp: number, secret = SECRET) {
  return createHmac("sha256", secret)
    .update(`v1:${timestamp}:${body}`)
    .digest("hex");
}

function verify(
  overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]>,
) {
  const timestamp = Math.floor(NOW / 1000);
  return verifyWebhookSignature({
    secret: SECRET,
    signatureHeader: `v1=${sign(BODY, timestamp)}`,
    timestampHeader: String(timestamp),
    rawBody: BODY,
    now: NOW,
    ...overrides,
  });
}

test("a correctly signed body is accepted", () => {
  assert.equal(verify({}).ok, true);
});

test("a bare hex digest is accepted without the v1 prefix", () => {
  const timestamp = Math.floor(NOW / 1000);
  assert.equal(verify({ signatureHeader: sign(BODY, timestamp) }).ok, true);
});

test("a body changed by one byte no longer verifies", () => {
  const result = verify({ rawBody: '{"recordId":"006Ab0000012346"}' });
  assert.deepEqual(result, { ok: false, reason: "mismatch" });
});

test("re-serialising the body breaks the signature", () => {
  // This is why the route keeps the raw bytes. JSON.stringify of the parsed
  // object is a different string, so verifying against it would reject every
  // sender whose formatting is not byte-identical to ours.
  const reserialized = JSON.stringify(JSON.parse(`{ "recordId" : "1" }`));
  const timestamp = Math.floor(NOW / 1000);
  const result = verifyWebhookSignature({
    secret: SECRET,
    signatureHeader: `v1=${sign(`{ "recordId" : "1" }`, timestamp)}`,
    timestampHeader: String(timestamp),
    rawBody: reserialized,
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: "mismatch" });
});

test("the signature is bound to the timestamp it was sent with", () => {
  // Moving a captured request into the window must not make it verify.
  const captured = Math.floor(NOW / 1000) - SIGNATURE_WINDOW_SECONDS * 4;
  const result = verify({
    signatureHeader: `v1=${sign(BODY, captured)}`,
    timestampHeader: String(Math.floor(NOW / 1000)),
  });
  assert.deepEqual(result, { ok: false, reason: "mismatch" });
});

test("a timestamp older than the window is refused", () => {
  const stale = Math.floor(NOW / 1000) - SIGNATURE_WINDOW_SECONDS - 1;
  const result = verify({
    signatureHeader: `v1=${sign(BODY, stale)}`,
    timestampHeader: String(stale),
  });
  assert.deepEqual(result, { ok: false, reason: "stale" });
});

test("a timestamp too far in the future is refused", () => {
  const ahead = Math.floor(NOW / 1000) + SIGNATURE_WINDOW_SECONDS + 1;
  const result = verify({
    signatureHeader: `v1=${sign(BODY, ahead)}`,
    timestampHeader: String(ahead),
  });
  assert.deepEqual(result, { ok: false, reason: "stale" });
});

test("clock skew inside the window is tolerated in both directions", () => {
  for (const offset of [-SIGNATURE_WINDOW_SECONDS, SIGNATURE_WINDOW_SECONDS]) {
    const skewed = Math.floor(NOW / 1000) + offset;
    const result = verify({
      signatureHeader: `v1=${sign(BODY, skewed)}`,
      timestampHeader: String(skewed),
    });
    assert.equal(result.ok, true, `offset ${offset} should verify`);
  }
});

test("a missing header is reported as missing, not as a mismatch", () => {
  assert.deepEqual(verify({ signatureHeader: "" }), {
    ok: false,
    reason: "missing",
  });
  assert.deepEqual(verify({ timestampHeader: "" }), {
    ok: false,
    reason: "missing",
  });
});

test("a header that is not a hex digest is malformed", () => {
  assert.deepEqual(verify({ signatureHeader: "v1=nonsense" }), {
    ok: false,
    reason: "malformed",
  });
  assert.deepEqual(verify({ timestampHeader: "yesterday" }), {
    ok: false,
    reason: "malformed",
  });
});

test("a signature from a different secret is refused", () => {
  const timestamp = Math.floor(NOW / 1000);
  const result = verify({
    signatureHeader: `v1=${sign(BODY, timestamp, "someone-elses-secret")}`,
  });
  assert.deepEqual(result, { ok: false, reason: "mismatch" });
});

test("the signing secret differs per trigger and per token", () => {
  const base = webhookSigningSecret("trg_1", "token-a");
  assert.notEqual(base, webhookSigningSecret("trg_2", "token-a"));
  // Rotating the secret URL has to rotate the signing secret with it.
  assert.notEqual(base, webhookSigningSecret("trg_1", "token-b"));
  assert.equal(base, webhookSigningSecret("trg_1", "token-a"));
});

test("the signing secret is not the vault key", () => {
  const secret = webhookSigningSecret("trg_1", "token-a");
  assert.notEqual(secret, process.env.BEAM_STUDIO_SECRET_KEY);
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
});
