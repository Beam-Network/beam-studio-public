import assert from "node:assert/strict";
import test from "node:test";

import {
  STUDIO_SESSION_MAX_AGE_SECONDS,
  createStudioBrowserSession,
  isValidStudioBrowserSession,
} from "./browser-session.js";

test("signs and validates a browser-scoped Studio session", () => {
  const now = Date.UTC(2026, 7, 8);
  const value = createStudioBrowserSession("test-secret", {
    now,
    nonce: "browser-session-nonce",
  });

  assert.equal(isValidStudioBrowserSession(value, "test-secret", now), true);
  assert.equal(isValidStudioBrowserSession(value, "wrong-secret", now), false);
  assert.equal(
    isValidStudioBrowserSession(`${value}tampered`, "test-secret", now),
    false,
  );
});

test("rejects expired browser sessions", () => {
  const issuedAt = Date.UTC(2026, 7, 8);
  const value = createStudioBrowserSession("test-secret", {
    now: issuedAt,
    nonce: "browser-session-nonce",
  });

  assert.equal(
    isValidStudioBrowserSession(
      value,
      "test-secret",
      issuedAt + (STUDIO_SESSION_MAX_AGE_SECONDS + 1) * 1_000,
    ),
    false,
  );
});

test("rejects legacy signed markers that were not bound to an OAuth session", async () => {
  const { createHmac } = await import("node:crypto");
  const payload = `${Math.floor(Date.now() / 1_000)}.legacy-browser`;
  const signature = createHmac("sha256", "test-secret")
    .update(payload)
    .digest("base64url");
  assert.equal(
    isValidStudioBrowserSession(`${payload}.${signature}`, "test-secret"),
    false,
  );
});
