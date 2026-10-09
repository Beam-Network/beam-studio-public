import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const STUDIO_SESSION_COOKIE = "beam-studio.session";
export const STUDIO_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function createStudioBrowserSession(
  secret: string,
  options: { now?: number; nonce?: string } = {},
) {
  const issuedAt = Math.floor((options.now ?? Date.now()) / 1_000);
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  const payload = `v2.${issuedAt}.${nonce}`;
  return `${payload}.${signature(payload, secret)}`;
}

/**
 * @param secret  The signing secrets to accept, active first. A cookie issued
 *   under a key that has since been retired stays valid until that key is
 *   dropped from the keyring, so rotating the vault key does not sign everyone
 *   out — the sign-out happens when the old key is retired, deliberately.
 */
export function isValidStudioBrowserSession(
  value: string | null,
  secret: string | readonly string[],
  now = Date.now(),
) {
  const secrets = (typeof secret === "string" ? [secret] : secret).filter(
    Boolean,
  );
  if (!value || !secrets.length) {
    return false;
  }
  const [version, issuedAtText, nonce, suppliedSignature, ...extra] =
    value.split(".");
  if (
    version !== "v2" ||
    extra.length ||
    !issuedAtText ||
    !nonce ||
    !suppliedSignature ||
    !/^[A-Za-z0-9_-]+$/.test(nonce)
  ) {
    return false;
  }
  const issuedAt = Number(issuedAtText);
  const nowSeconds = Math.floor(now / 1_000);
  if (
    !Number.isSafeInteger(issuedAt) ||
    issuedAt > nowSeconds + 300 ||
    nowSeconds - issuedAt > STUDIO_SESSION_MAX_AGE_SECONDS
  ) {
    return false;
  }
  const supplied = Buffer.from(suppliedSignature);
  return secrets.some((candidate) => {
    const expected = Buffer.from(
      signature(`v2.${issuedAtText}.${nonce}`, candidate),
    );
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  });
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
