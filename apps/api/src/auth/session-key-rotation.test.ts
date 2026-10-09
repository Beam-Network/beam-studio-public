import assert from "node:assert/strict";
import test from "node:test";
import { derivedSecret, derivedSecrets } from "@beam-studio/vault";
import {
  opsAuthToken,
  opsAuthorized,
} from "@beam-studio/shared/ops-auth";
import {
  createStudioBrowserSession,
  isValidStudioBrowserSession,
} from "./browser-session.js";

/**
 * Rotating the vault key used to invalidate every signed credential at once,
 * which made rotation something an operator would put off. These assert the
 * separation the keyring buys: rotation is quiet, and *retirement* is the
 * moment old credentials stop working.
 */

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const SESSION_PURPOSE = "beam-studio.browser-session.v1";

function withKeys<T>(
  active: string,
  retired: string | undefined,
  run: () => T,
) {
  const previousActive = process.env.BEAM_STUDIO_SECRET_KEY;
  const previousRetired = process.env.BEAM_STUDIO_SECRET_KEY_RETIRED;
  process.env.BEAM_STUDIO_SECRET_KEY = active;
  if (retired === undefined) delete process.env.BEAM_STUDIO_SECRET_KEY_RETIRED;
  else process.env.BEAM_STUDIO_SECRET_KEY_RETIRED = retired;
  try {
    return run();
  } finally {
    if (previousActive === undefined) delete process.env.BEAM_STUDIO_SECRET_KEY;
    else process.env.BEAM_STUDIO_SECRET_KEY = previousActive;
    if (previousRetired === undefined)
      delete process.env.BEAM_STUDIO_SECRET_KEY_RETIRED;
    else process.env.BEAM_STUDIO_SECRET_KEY_RETIRED = previousRetired;
  }
}

test("a session cookie survives a vault key rotation", () => {
  const cookie = withKeys(KEY_A, undefined, () =>
    createStudioBrowserSession(derivedSecret(SESSION_PURPOSE)),
  );
  withKeys(KEY_B, KEY_A, () => {
    assert.ok(
      isValidStudioBrowserSession(cookie, derivedSecrets(SESSION_PURPOSE)),
    );
  });
});

test("retiring the old key is what signs those sessions out", () => {
  // The invalidation the issue asks to be an explicit step rather than a side
  // effect of changing a variable.
  const cookie = withKeys(KEY_A, undefined, () =>
    createStudioBrowserSession(derivedSecret(SESSION_PURPOSE)),
  );
  withKeys(KEY_B, undefined, () => {
    assert.ok(
      !isValidStudioBrowserSession(cookie, derivedSecrets(SESSION_PURPOSE)),
    );
  });
});

test("a cookie signed by no configured key is still refused", () => {
  const forged = withKeys("f".repeat(64), undefined, () =>
    createStudioBrowserSession(derivedSecret(SESSION_PURPOSE)),
  );
  withKeys(KEY_B, KEY_A, () => {
    assert.ok(
      !isValidStudioBrowserSession(forged, derivedSecrets(SESSION_PURPOSE)),
    );
  });
});

test("an empty secret list refuses everything", () => {
  assert.ok(!isValidStudioBrowserSession("anything", []));
  assert.ok(!isValidStudioBrowserSession("anything", [""]));
});

test("a scraper's ops token survives a rotation and dies on retirement", () => {
  const configured = withKeys(KEY_A, undefined, () => opsAuthToken(KEY_A));
  withKeys(KEY_B, KEY_A, () => {
    assert.ok(opsAuthorized(`Bearer ${configured}`));
  });
  withKeys(KEY_B, undefined, () => {
    assert.ok(!opsAuthorized(`Bearer ${configured}`));
  });
});
