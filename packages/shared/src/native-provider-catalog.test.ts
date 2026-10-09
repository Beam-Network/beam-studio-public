import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  getNativeProvider,
  nativeProviderDisplay,
  nativeProviders,
} from "./native-provider-catalog.js";
import { getProviderProfile } from "./provider-profiles.js";

const seedScriptPath = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "db",
  "scripts",
  "apply-beam-studio-target.mjs",
);

test("every native provider has a seeded provider profile", () => {
  // createCredential resolves secrets.provider_profiles by this id at save
  // time, so a catalog entry with no seeded row fails at runtime with
  // "Unsupported credential provider" rather than at build time.
  const seed = readFileSync(seedScriptPath, "utf8");
  for (const provider of nativeProviders) {
    assert.ok(
      seed.includes(`id: "${provider.id}"`),
      `native provider "${provider.id}" has no seeded provider_profiles row`,
    );
    assert.ok(
      seed.includes(`slug: "${provider.credentialType}"`),
      `credential type "${provider.credentialType}" is not seeded`,
    );
  }
});

test("native provider ids do not collide with S3-compatible profiles", () => {
  // credentialProviderMetadata checks getProviderProfile first, so a collision
  // would silently shadow the native entry.
  for (const provider of nativeProviders) {
    assert.equal(
      getProviderProfile(provider.id),
      undefined,
      `native provider "${provider.id}" collides with an S3-compatible profile`,
    );
  }
});

test("every native provider declares a logo and at least one required field", () => {
  for (const provider of nativeProviders) {
    assert.ok(provider.logo.startsWith("/"), `${provider.id} logo must be a root-relative path`);
    assert.ok(
      provider.fields.some((field) => field.required),
      `${provider.id} declares no required field`,
    );
  }
});

test("resolves display metadata case-insensitively and returns null when unknown", () => {
  assert.deepEqual(nativeProviderDisplay("Salesforce"), {
    logo: "/provider-logos/salesforce.png",
    name: "Salesforce",
  });
  assert.equal(getNativeProvider("salesforce-jwt")?.credentialType, "salesforce_jwt");
  assert.equal(nativeProviderDisplay("not-a-provider"), null);
});
