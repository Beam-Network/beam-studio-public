import assert from "node:assert/strict";
import test from "node:test";

import {
  huggingFaceProviderConfigSchema,
  transferProviderConfigSchema,
} from "./transfer.js";

const hf = {
  provider: "huggingface" as const,
  repo_id: "acme/corpus",
  path: "data/train.parquet",
  repo_type: "dataset" as const,
  token: "hf_token",
};

test("a Hugging Face config validates without bucket or key", () => {
  // The Hub addresses content by repo and path, so providerBaseSchema does not apply.
  const parsed = transferProviderConfigSchema.parse(hf);
  assert.equal(parsed.provider, "huggingface");
  assert.equal("bucket" in parsed, false);
});

test("every repo type the Hub exposes is accepted, buckets included", () => {
  for (const repo_type of ["model", "dataset", "space", "kernel", "bucket"] as const) {
    assert.equal(
      huggingFaceProviderConfigSchema.parse({ ...hf, repo_type }).repo_type,
      repo_type,
    );
  }
  assert.equal(huggingFaceProviderConfigSchema.safeParse({ ...hf, repo_type: "repo" }).success, false);
});

test("repo_id must name a namespace and a repo", () => {
  const result = huggingFaceProviderConfigSchema.safeParse({ ...hf, repo_id: "corpus" });
  assert.equal(result.success, false);
  assert.match(result.error?.issues[0]?.message ?? "", /namespace\/name/);
});

test("repo_type and revision are optional; the SDK supplies the defaults", () => {
  const parsed = huggingFaceProviderConfigSchema.parse({
    provider: "huggingface",
    repo_id: "acme/net",
    path: "model.safetensors",
    token: "hf_token",
  });
  assert.equal(parsed.repo_type, undefined);
  assert.equal(parsed.revision, undefined);
});

test("destination-only upload options are carried through", () => {
  const parsed = huggingFaceProviderConfigSchema.parse({
    ...hf,
    commit_message: "Add train.parquet",
    create_pr: true,
    allow_source_rehash: true,
  });
  assert.equal(parsed.commit_message, "Add train.parquet");
  assert.equal(parsed.create_pr, true);
  assert.equal(parsed.allow_source_rehash, true);
});

test("a token is required", () => {
  const { token: _token, ...withoutToken } = hf;
  assert.equal(huggingFaceProviderConfigSchema.safeParse(withoutToken).success, false);
});
