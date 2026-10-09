import { createHmac, timingSafeEqual } from "node:crypto";
import { derivedSecrets } from "@beam-studio/vault";

/**
 * The code that claims ownership of a fresh deployment.
 *
 * A Studio instance serves nobody until a team claims it. Letting the first
 * account to sign in become the owner would be a race whose loser is the
 * operator: an attacker who learns the URL before the install is finished wins
 * it, and recovery means editing tables by hand. So the claim takes a secret
 * only someone with access to the host can read.
 *
 * Like the ops token, it is *derived* from `BEAM_STUDIO_SECRET_KEY` rather than
 * being its own variable, for the reason set out in `ops-auth.ts`: a new
 * variable would have to be threaded through `.env.example`, both Compose
 * files, the release template, the installer, the deploy script and the CI
 * secrets. Every service already has the vault key. HMAC is one-way, so a
 * disclosed claim code does not expose the key it came from — and a claimed
 * instance ignores the code entirely.
 */
const CLAIM_CODE_PURPOSE = "beam-studio.instance-claim.v1";

/** Groups of four, because operators read this one off a terminal by hand. */
function formatClaimCode(digest: string) {
  return (
    digest
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 16)
      .toUpperCase()
      .match(/.{1,4}/g)
      ?.join("-") ?? ""
  );
}

export function instanceClaimCode(secret = process.env.BEAM_STUDIO_SECRET_KEY) {
  const key = secret?.trim();
  if (!key) {
    throw new Error(
      "BEAM_STUDIO_SECRET_KEY is required to derive the instance claim code.",
    );
  }
  return formatClaimCode(
    createHmac("sha256", key).update(CLAIM_CODE_PURPOSE).digest("base64url"),
  );
}

function normalize(value: string) {
  // Operators retype this, so hyphens and case are not part of the secret.
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function constantTimeEquals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so compare sizes first and still run the comparison.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Whether a presented code claims this instance.
 *
 * A code derived from any key on the vault keyring is accepted, not only the
 * active one, for the same reason the ops token does it: an operator may have
 * written the code down before a rotation, and the claim is a one-time action
 * they should not have to redo because an unrelated key changed. Retiring the
 * old key is what finally invalidates the old code.
 */
export function instanceClaimCodeMatches(presented: string, secret?: string) {
  const candidate = normalize(presented ?? "");
  if (!candidate) return false;
  const accepted = secret
    ? [instanceClaimCode(secret)]
    : derivedSecrets(CLAIM_CODE_PURPOSE).map(formatClaimCode);
  return accepted.some((code) => constantTimeEquals(candidate, normalize(code)));
}
