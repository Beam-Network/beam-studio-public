import assert from "node:assert/strict";
import test from "node:test";
import {
  isLoopbackRemoteAddress,
  opsAuthorized,
  opsAuthToken,
} from "./ops-auth.js";

const SECRET = "0".repeat(64);
const OTHER = "1".repeat(64);

test("the token is derived from the vault key, not equal to it", () => {
  const token = opsAuthToken(SECRET);
  assert.ok(token.length > 20);
  assert.notEqual(token, SECRET);
  // HMAC is one-way, so a leaked ops token does not expose the key.
  assert.ok(!token.includes(SECRET));
});

test("the same key always derives the same token", () => {
  assert.equal(opsAuthToken(SECRET), opsAuthToken(SECRET));
});

test("the derivation is pinned, because it is a wire contract", () => {
  // Every service derives the same token from the deployment's vault key, so
  // one scraper credential works against all of them. Changing this silently
  // would 401 every configured scraper at once; the assertion makes that an
  // explicit decision. It used to exist because the orchestrator carried a
  // second copy, which it no longer does.
  assert.equal(
    opsAuthToken(SECRET),
    "YqNrYcYmPpLVYJcNijMy7esGjWpAW1P-YaphEcgrvyc",
  );
});

test("rotating the key rotates the token", () => {
  assert.notEqual(opsAuthToken(SECRET), opsAuthToken(OTHER));
});

test("deriving without a key fails rather than producing a usable token", () => {
  assert.throws(() => opsAuthToken(""), /BEAM_STUDIO_SECRET_KEY is required/);
  assert.throws(
    () => opsAuthToken(undefined),
    /BEAM_STUDIO_SECRET_KEY is required/,
  );
});

test("a correct bearer token is accepted", () => {
  assert.ok(opsAuthorized(`Bearer ${opsAuthToken(SECRET)}`, SECRET));
  // Header names are case-insensitive in practice; so is the scheme.
  assert.ok(opsAuthorized(`bearer ${opsAuthToken(SECRET)}`, SECRET));
});

test("anything else is refused", () => {
  for (const header of [
    undefined,
    "",
    "Bearer ",
    "Bearer wrong",
    opsAuthToken(OTHER),
    `Bearer ${opsAuthToken(OTHER)}`,
    // A truncated prefix of the real token must not pass.
    `Bearer ${opsAuthToken(SECRET).slice(0, 10)}`,
  ]) {
    assert.ok(!opsAuthorized(header, SECRET), JSON.stringify(header));
  }
});

test("a bare token without the scheme is accepted", () => {
  // Some scrapers send the credential unprefixed.
  assert.ok(opsAuthorized(opsAuthToken(SECRET), SECRET));
});

test("loopback source addresses are recognised", () => {
  // Container healthchecks fetch 127.0.0.1 from inside the container, which is
  // why they keep working without a credential.
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.ok(isLoopbackRemoteAddress(address), address);
  }
  for (const address of [undefined, "", "10.0.0.5", "203.0.113.9"]) {
    assert.ok(!isLoopbackRemoteAddress(address), String(address));
  }
});
