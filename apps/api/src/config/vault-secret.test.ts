import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptString,
  derivedSecret,
  encryptString,
  vaultSecretFromEnv,
} from "@beam-studio/vault";

const GOOD = "0".repeat(64);

/**
 * These run in-process, so each case restores the variable it changed rather
 * than leaking a secret into the rest of the suite.
 */
function withSecret<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.BEAM_STUDIO_SECRET_KEY;
  const previousNodeEnv = process.env.NODE_ENV;
  if (value === undefined) delete process.env.BEAM_STUDIO_SECRET_KEY;
  else process.env.BEAM_STUDIO_SECRET_KEY = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.BEAM_STUDIO_SECRET_KEY;
    else process.env.BEAM_STUDIO_SECRET_KEY = previous;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

test("an absent vault key is refused", () => {
  withSecret(undefined, () => {
    assert.throws(vaultSecretFromEnv, /BEAM_STUDIO_SECRET_KEY is required/);
  });
});

test("the placeholders published in this repository are refused", () => {
  // The guard used to reject only the first of these. docker-compose.yml
  // shipped the second, so it passed the check and became the vault key.
  for (const placeholder of [
    "local-beam-studio-secret-change-before-production",
    "change-me-to-a-long-random-secret",
  ]) {
    withSecret(placeholder, () => {
      assert.throws(
        vaultSecretFromEnv,
        /placeholder published in the Beam Studio repository/,
        `${placeholder} must be refused`,
      );
    });
  }
});

test("a short secret is refused", () => {
  withSecret("tooshort", () => {
    assert.throws(vaultSecretFromEnv, /at least 32 characters/);
  });
});

test("refusal does not depend on NODE_ENV", () => {
  // The hosted deployment ran every service with NODE_ENV=development, which
  // switched the old guard off exactly where it mattered.
  for (const nodeEnv of ["development", "test", "production", undefined]) {
    withSecret("change-me-to-a-long-random-secret", () => {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      assert.throws(
        vaultSecretFromEnv,
        /placeholder/,
        `NODE_ENV=${nodeEnv} must not permit a published placeholder`,
      );
    });
  }
});

test("a configured secret is returned and round-trips a value", () => {
  withSecret(GOOD, () => {
    assert.equal(vaultSecretFromEnv(), GOOD);
    const sealed = encryptString("provider-credential", vaultSecretFromEnv());
    assert.doesNotMatch(sealed, /provider-credential/);
    assert.equal(
      decryptString(sealed, vaultSecretFromEnv()),
      "provider-credential",
    );
  });
});

test("derived secrets are stable, distinct, and never the vault key", () => {
  withSecret(GOOD, () => {
    const agent = derivedSecret("beam-studio.agent-control.v1");
    const session = derivedSecret("beam-studio.browser-session.v1");
    assert.equal(agent, derivedSecret("beam-studio.agent-control.v1"));
    assert.notEqual(agent, session);
    assert.notEqual(agent, GOOD);
    assert.notEqual(session, GOOD);
  });
});

test("a derived secret inherits the refusal", () => {
  withSecret(undefined, () => {
    assert.throws(
      () => derivedSecret("beam-studio.agent-control.v1"),
      /BEAM_STUDIO_SECRET_KEY is required/,
    );
  });
});
