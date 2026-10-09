import { createHmac, timingSafeEqual } from "node:crypto";
import { derivedSecrets } from "@beam-studio/vault";

/**
 * Authentication for operational endpoints — metrics, worker load, command
 * publication state. These are service-to-service and scraper surfaces, not
 * user ones, so they take a single deployment-wide credential rather than a
 * session or a scoped token.
 *
 * The credential is *derived* from `BEAM_STUDIO_SECRET_KEY` rather than being
 * its own variable. A new variable would have to be threaded through
 * `.env.example`, both Compose files, the release template, the installer, the
 * deploy script and the CI secrets, and any service that missed it would fail
 * closed at an inconvenient hour. Every service already has the vault key.
 * Rotating that key rotates this with it, and HMAC is one-way, so a leaked ops
 * token does not expose the key it came from.
 */
const OPS_TOKEN_PURPOSE = "beam-studio.ops.v1";

export function opsAuthToken(secret = process.env.BEAM_STUDIO_SECRET_KEY) {
  const key = secret?.trim();
  if (!key) {
    throw new Error(
      "BEAM_STUDIO_SECRET_KEY is required to derive the operations token.",
    );
  }
  return createHmac("sha256", key)
    .update(OPS_TOKEN_PURPOSE)
    .digest("base64url");
}

function constantTimeEquals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so compare sizes first and still run the comparison.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function opsAuthorized(
  header: string | string[] | undefined,
  secret?: string,
) {
  const value = Array.isArray(header) ? header[0] : header;
  const presented = (value ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!presented) return false;
  const accepted = secret
    ? [opsAuthToken(secret)]
    : derivedSecrets(OPS_TOKEN_PURPOSE);
  return accepted.some((token) => constantTimeEquals(presented, token));
}

export function isLoopbackRemoteAddress(address: string | undefined) {
  if (!address) return false;
  const normalised = address.replace(/^::ffff:/, "");
  return normalised === "127.0.0.1" || normalised === "::1";
}
