import assert from "node:assert/strict";
import test from "node:test";
import {
  getProviderProfile,
  providerReturnsObjectMetadata,
  resolveProviderProfileEndpointUrl,
  resolveProviderProfileForcePathStyle,
  resolveProviderProfileRegion,
} from "./provider-profiles.js";

test("metadata readback limitation is scoped to the canonical Hugging Face endpoint", () => {
  assert.equal(
    providerReturnsObjectMetadata("huggingface", "https://s3.hf.co/team"),
    false,
  );
  assert.equal(
    providerReturnsObjectMetadata("hf", "https://s3.hf.co/other"),
    false,
  );
  for (const endpoint of [
    undefined,
    "invalid",
    "http://s3.hf.co/team",
    "https://s3.hf.co.attacker.example/team",
    "https://custom.example/team",
  ]) {
    assert.equal(providerReturnsObjectMetadata("huggingface", endpoint), true);
  }
  assert.equal(
    providerReturnsObjectMetadata("hippius", "https://s3.hippius.com"),
    true,
  );
  assert.equal(providerReturnsObjectMetadata("r2"), true);
});

test("Hippius uses the standard S3-compatible provider contract", () => {
  const profile = getProviderProfile("hippius");

  assert.equal(profile?.driver, "s3-compatible");
  assert.deepEqual(profile?.credential_fields.required, [
    "access_key_id",
    "secret_access_key",
  ]);
  assert.equal(
    resolveProviderProfileEndpointUrl("hippi"),
    "https://s3.hippius.com",
  );
  assert.equal(resolveProviderProfileRegion("hippius"), "decentralized");
  assert.equal(resolveProviderProfileForcePathStyle("hippius"), true);
});

test("Hugging Face Storage Buckets resolve through the namespace S3 gateway", () => {
  const profile = getProviderProfile("huggingface");

  assert.equal(profile?.driver, "s3-compatible");
  assert.deepEqual(profile?.credential_fields.required, [
    "access_key_id",
    "secret_access_key",
    "namespace",
  ]);
  assert.equal(
    resolveProviderProfileEndpointUrl("hf", { namespace: "beam-network" }),
    "https://s3.hf.co/beam-network",
  );
  assert.equal(resolveProviderProfileRegion("huggingface"), "us-east-1");
  assert.equal(resolveProviderProfileForcePathStyle("huggingface"), true);
});
