import { createHmac, timingSafeEqual } from "node:crypto";
import { vaultSecretFromEnv } from "@beam-studio/vault";

/**
 * Optional body authentication for webhook triggers.
 *
 * The trigger token lives in the URL path because senders such as Salesforce
 * Flows cannot reliably set custom headers. That makes it a bearer credential
 * in a place URLs get logged, forwarded and pasted, and it says nothing about
 * the body: a captured request replays forever.
 *
 * A trigger may therefore require an HMAC over the body with a timestamp.
 * It is opt-in per trigger, because turning it on unconditionally would break
 * exactly the senders the path token exists for.
 */
export const SIGNATURE_WINDOW_SECONDS = 300;

const SIGNATURE_PURPOSE = "beam-studio.webhook-signature.v1";

/**
 * The secret a sender signs with.
 *
 * Derived rather than stored, like the operations token: no new column, no
 * migration, and nothing extra to leak. Binding it to the token plaintext as
 * well as the trigger id means rotating the secret URL rotates the signing
 * secret with it, which is what an operator rotating a leaked credential
 * expects. Recovering it from a database dump needs the vault key, which is
 * already what the token itself needs.
 */
export function webhookSigningSecret(triggerId: string, token: string) {
  return createHmac("sha256", vaultSecretFromEnv())
    .update(`${SIGNATURE_PURPOSE}.${triggerId}.${token}`)
    .digest("base64url");
}

export type SignatureCheck =
  | { ok: true; signature: string }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/**
 * Verifies `X-Beam-Signature: v1=<hex>` against `X-Beam-Timestamp`.
 *
 * The signed string is `v1:<timestamp>:<raw body>`. The timestamp is inside it
 * so it cannot be edited to move a captured request into the acceptance
 * window, and the version prefix means a future scheme can be added without
 * a signature of one kind being accepted as another.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  signatureHeader: string;
  timestampHeader: string;
  rawBody: string;
  now?: number;
}): SignatureCheck {
  if (!input.signatureHeader || !input.timestampHeader) {
    return { ok: false, reason: "missing" };
  }

  const timestamp = Number(input.timestampHeader);
  if (!Number.isFinite(timestamp) || !Number.isInteger(timestamp)) {
    return { ok: false, reason: "malformed" };
  }

  const provided = signatureValue(input.signatureHeader);
  if (!provided) {
    return { ok: false, reason: "malformed" };
  }

  // Checked before the comparison so a replay far outside the window is
  // rejected without the delivery table ever having to remember it.
  const seconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(seconds - timestamp) > SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, reason: "stale" };
  }

  const expected = createHmac("sha256", input.secret)
    .update(`v1:${timestamp}:${input.rawBody}`)
    .digest("hex");
  if (!constantTimeEquals(expected, provided)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, signature: provided };
}

/**
 * The hex digest out of `v1=<hex>`.
 *
 * A bare digest is accepted too: senders that cannot template a prefix are the
 * reason this feature is optional in the first place.
 */
function signatureValue(header: string) {
  const candidate = header.trim().startsWith("v1=")
    ? header.trim().slice(3)
    : header.trim();
  return /^[0-9a-f]{64}$/.test(candidate.toLowerCase())
    ? candidate.toLowerCase()
    : "";
}

function constantTimeEquals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
