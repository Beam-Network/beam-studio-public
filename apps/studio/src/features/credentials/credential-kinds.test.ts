import assert from "node:assert/strict";
import test from "node:test";
import {
  isStorageCredentialKind,
  showsStorageNetworkHint,
} from "./credential-kinds";

test("storage providers and Hugging Face tokens back storage endpoints", () => {
  for (const kind of [
    "s3",
    "r2",
    "hippius",
    "cloudflare-r2",
    "huggingface-hub",
  ])
    assert.equal(isStorageCredentialKind(kind), true, kind);
});

test("Beam API keys and service credentials do not", () => {
  for (const kind of ["beam", "beam_api_key", "slack", "salesforce", "", null])
    assert.equal(isStorageCredentialKind(kind), false, String(kind));
});

test("every storage credential kind, GCS included, shows the network hint", () => {
  for (const kind of [
    "s3",
    "r2",
    "hippius",
    "custom-s3",
    "huggingface",
    "huggingface-hub",
    "gcs",
  ])
    assert.equal(showsStorageNetworkHint(kind), true, kind);
  for (const kind of ["beam", "slack-bot", "salesforce", "", null])
    assert.equal(showsStorageNetworkHint(kind), false, String(kind));
});
