import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeCredentialPayload,
  normalizeCredentialPayloadAliases,
  safeCredentialPayload,
} from "./credential-payload.js";

test("mergeCredentialPayload expands incoming camelCase aliases before merge", () => {
  const merged = mergeCredentialPayload(
    {
      secret_access_key: "stale-secret",
      endpointUrl: "https://s3.hippius.com",
    },
    {
      secretAccessKey: "fresh-secret",
    },
  );

  assert.equal(merged.secret_access_key, "fresh-secret");
  assert.equal(merged.secretAccessKey, undefined);
  assert.equal(merged.endpoint_url, "https://s3.hippius.com");
  assert.equal(merged.endpointUrl, undefined);
});

test("normalizeCredentialPayloadAliases stores snake_case canonical fields only", () => {
  const normalized = normalizeCredentialPayloadAliases({
    accessKeyId: "access",
    secretAccessKey: "secret",
    forcePathStyle: true,
  });

  assert.deepEqual(normalized, {
    access_key_id: "access",
    secret_access_key: "secret",
    force_path_style: true,
  });
});

test("normalizeCredentialPayloadAliases keeps canonical values when both forms exist", () => {
  const normalized = normalizeCredentialPayloadAliases({
    access_key_id: "canonical-access",
    accessKeyId: "stale-access",
  });

  assert.deepEqual(normalized, {
    access_key_id: "canonical-access",
  });
});

test("stored secrets never appear in the browser projection", () => {
  const { payload, secretFields } = safeCredentialPayload({
    access_key_id: "AKIAEXAMPLE",
    secret_access_key: "s3cret-value",
    session_token: "tok-value",
    endpoint_url: "https://s3.example",
    region: "us-east-1",
    force_path_style: true,
  });

  const serialized = JSON.stringify(payload);
  for (const secret of ["s3cret-value", "tok-value"]) {
    assert.equal(
      serialized.includes(secret),
      false,
      `${secret} must not be serialized`,
    );
  }
  assert.deepEqual(payload, {
    access_key_id: "AKIAEXAMPLE",
    endpoint_url: "https://s3.example",
    region: "us-east-1",
    force_path_style: true,
  });
  assert.deepEqual(secretFields, ["secret_access_key", "session_token"]);
});

test("a field that reads like a secret is withheld even if unknown", () => {
  // Fail closed: a provider added later must not leak by default.
  const { payload, secretFields } = safeCredentialPayload({
    tenant: "acme",
    refresh_password: "hunter2",
    signing_credential: "abc",
  });
  assert.deepEqual(payload, { tenant: "acme" });
  assert.deepEqual(secretFields, ["refresh_password", "signing_credential"]);
});

test("short secrets are withheld like any other", () => {
  const { payload, secretFields } = safeCredentialPayload({ api_key: "ab" });
  assert.deepEqual(payload, {});
  assert.deepEqual(secretFields, ["api_key"]);
});

test("omitting a secret keeps the stored one", () => {
  // The editor never loads secrets now, so every save omits them. Treating an
  // absent or blank secret as an erase would destroy the credential.
  const merged = mergeCredentialPayload(
    { access_key_id: "old-id", secret_access_key: "stored" },
    { access_key_id: "new-id" },
  );
  assert.equal(merged.secret_access_key, "stored");
  assert.equal(merged.access_key_id, "new-id");
});

test("a blank secret cannot overwrite a stored one", () => {
  for (const blank of ["", "   "]) {
    const merged = mergeCredentialPayload(
      { secret_access_key: "stored", private_key: "stored-key" },
      { secret_access_key: blank, private_key: blank },
    );
    assert.equal(merged.secret_access_key, "stored");
    assert.equal(merged.private_key, "stored-key");
  }
});

test("a replacement secret is applied", () => {
  const merged = mergeCredentialPayload(
    { secret_access_key: "stored" },
    { secret_access_key: "replacement" },
  );
  assert.equal(merged.secret_access_key, "replacement");
});

test("non-secret fields stay clearable", () => {
  const merged = mergeCredentialPayload(
    { endpoint_url: "https://old.example", region: "us-east-1" },
    { endpoint_url: "" },
  );
  assert.equal(merged.endpoint_url, "");
  assert.equal(merged.region, "us-east-1");
});
