import assert from "node:assert/strict";
import test from "node:test";
import { redactSecretsForDisplay } from "./run-detail-primitives-redaction.js";

test("a webhook trigger's live token never reaches the rendered JSON", () => {
  const triggerConfig = {
    token: "PhBQ0zvY5jV6y1bRr7wKx2Nn",
    coalesceWindowSeconds: 0,
    maxConcurrentRuns: 1,
  };
  const rendered = JSON.stringify(redactSecretsForDisplay(triggerConfig));
  assert.ok(!rendered.includes("PhBQ0zvY5jV6y1bRr7wKx2Nn"));
  assert.match(rendered, /"token":"\[redacted\]"/);
  // Everything else is still shown; this is a panel people debug with.
  assert.match(rendered, /"coalesceWindowSeconds":0/);
  assert.match(rendered, /"maxConcurrentRuns":1/);
});

test("secret-shaped keys are redacted wherever they appear", () => {
  const value = {
    apiKey: "sk-live-123",
    nested: { signingSecret: "s3cret", password: "hunter2" },
    list: [{ credential: "abc" }, { authorization: "Bearer xyz" }],
    privateKey: "-----BEGIN",
  };
  const rendered = JSON.stringify(redactSecretsForDisplay(value));
  for (const leak of [
    "sk-live-123",
    "s3cret",
    "hunter2",
    "abc",
    "Bearer xyz",
    "BEGIN",
  ]) {
    assert.ok(!rendered.includes(leak), `${leak} must not be rendered`);
  }
});

test("empty and absent values are left alone rather than faked", () => {
  // Showing "[redacted]" where nothing is set would imply a secret exists.
  const value = { token: "", secret: null, password: undefined, name: "ok" };
  const redacted = redactSecretsForDisplay(value) as Record<string, unknown>;
  assert.equal(redacted.token, "");
  assert.equal(redacted.secret, null);
  assert.equal(redacted.name, "ok");
});

test("non-secret keys and primitives pass through unchanged", () => {
  assert.equal(redactSecretsForDisplay("plain"), "plain");
  assert.equal(redactSecretsForDisplay(42), 42);
  assert.equal(redactSecretsForDisplay(null), null);
  assert.deepEqual(redactSecretsForDisplay({ a: 1, b: [2, 3] }), {
    a: 1,
    b: [2, 3],
  });
});
