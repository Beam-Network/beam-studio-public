import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeRegistryPackages,
  registryIdentityConflictMessage,
  registryInstallable,
  registryInstallBlockedReason,
  registryPackageStates,
  registryRepositoryLink,
  type RegistryPackage,
} from "./registry-data";

const MANIFEST = "a".repeat(64);
const OTHER_MANIFEST = "b".repeat(64);
const ARTIFACT = "c".repeat(64);
const OTHER_ARTIFACT = "d".repeat(64);

function registryPackage(
  overrides: Partial<RegistryPackage> = {},
): RegistryPackage {
  return {
    id: "pkg",
    packageName: "@acme/archive",
    scope: "@acme",
    name: "archive",
    displayName: "Archive",
    visibility: "public",
    status: "active",
    trustLevel: "verified",
    latestVersion: "1.0.0",
    versionCount: 1,
    latestManifestChecksum: MANIFEST,
    latestArtifactChecksum: `sha256:${ARTIFACT}`,
    latestSourceRegistry: "public-registry",
    updatedAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

function merged(local: RegistryPackage, published: RegistryPackage) {
  const [item] = mergeRegistryPackages([local], [published]);
  assert.ok(item);
  return item;
}

test("the same version with the same checksums is installed", () => {
  const item = merged(
    registryPackage(),
    // The Registry reports checksums without the local sha256: prefix.
    registryPackage({ latestArtifactChecksum: ARTIFACT.toUpperCase() }),
  );
  assert.equal(item.installState, "installed");
  assert.equal(registryInstallable(item), false);
  assert.equal(registryIdentityConflictMessage(item), null);
});

test("the same version with a different manifest is an identity conflict", () => {
  const item = merged(
    registryPackage(),
    registryPackage({ latestManifestChecksum: OTHER_MANIFEST }),
  );
  assert.equal(item.installState, "identity-conflict");
  assert.equal(registryInstallable(item), false);
  assert.match(registryIdentityConflictMessage(item) ?? "", /1\.0\.0/);
  assert.deepEqual(
    registryPackageStates(item).map((state) => state.id),
    ["identity-conflict"],
  );
  // The installed release stays usable: nothing blocks adding it to a workflow.
  assert.equal(registryInstallBlockedReason(item), null);
});

test("the same version with a different artifact is an identity conflict", () => {
  const item = merged(
    registryPackage(),
    registryPackage({ latestArtifactChecksum: `sha256:${OTHER_ARTIFACT}` }),
  );
  assert.equal(item.installState, "identity-conflict");
});

test("a built-in action is compared by its manifest only", () => {
  // Built-ins record sha256:<manifest checksum> as their artifact checksum,
  // which never matches a published artifact.
  const builtin = registryPackage({
    latestArtifactChecksum: `sha256:${MANIFEST}`,
    latestSourceRegistry: "builtin",
    trustLevel: "builtin",
  });
  assert.equal(merged(builtin, registryPackage()).installState, "installed");
  assert.equal(
    merged(builtin, registryPackage({ latestManifestChecksum: OTHER_MANIFEST }))
      .installState,
    "identity-conflict",
  );
});

test("a newer published version is an available update", () => {
  const item = merged(
    registryPackage(),
    registryPackage({
      latestVersion: "1.1.0",
      latestManifestChecksum: OTHER_MANIFEST,
    }),
  );
  assert.equal(item.installState, "update-available");
  assert.equal(registryInstallable(item), true);
});

test("a package only the Registry publishes is installable", () => {
  const [item] = mergeRegistryPackages([], [registryPackage()]);
  assert.equal(item?.installState, "not-installed");
  assert.equal(registryInstallable(item!), true);
});

test("a GitHub repository directory becomes part of the link", () => {
  assert.deepEqual(
    registryRepositoryLink({
      url: "https://github.com/Beam-Network/beam-actions.git",
      directory: "actions/wait/",
    }),
    {
      href: "https://github.com/Beam-Network/beam-actions/tree/HEAD/actions/wait",
      label: "github.com/Beam-Network/beam-actions/actions/wait",
      directory: null,
    },
  );
});

test("another host keeps the directory beside the link", () => {
  assert.deepEqual(
    registryRepositoryLink({
      url: "https://gitlab.com/beam/actions",
      directory: "wait",
    }),
    {
      href: "https://gitlab.com/beam/actions",
      label: "gitlab.com/beam/actions",
      directory: "wait",
    },
  );
});

test("only credential-free https URLs are linked", () => {
  for (const url of [
    "javascript:alert(1)",
    "http://github.com/beam/actions",
    "https://token@github.com/beam/actions",
    "data:text/html,hi",
    "not a url",
  ]) {
    assert.equal(registryRepositoryLink({ url }), null, url);
  }
  assert.equal(registryRepositoryLink(null), null);
});

test("a directory that escapes the repository is dropped", () => {
  assert.equal(
    registryRepositoryLink({
      url: "https://github.com/beam/actions",
      directory: "../secrets",
    })?.href,
    "https://github.com/beam/actions",
  );
});
