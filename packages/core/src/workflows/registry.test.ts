import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionManifestError,
  ActionPackageNotFoundError,
  LocalActionRegistry,
  RemoteActionInstallError,
  validateActionManifest,
  type ActionManifest,
} from "../index.js";

const manifest = {
  name: "@beam/test",
  version: "1.2.3",
  apiVersion: "workflow-actions/v1",
  runtime: { placements: ["local-workers"] },
  inputs: {},
  outputs: {},
} satisfies ActionManifest;

test("validates action package manifests", () => {
  assert.doesNotThrow(() => validateActionManifest(manifest));
  assert.throws(
    () => validateActionManifest({ ...manifest, name: "beam.test" }),
    ActionManifestError,
  );
});

test("registers and resolves builtin action versions", () => {
  const registry = new LocalActionRegistry();
  registry.registerPackage({
    source: "builtin",
    manifest,
    execute: () => ({ outputs: { ok: true } }),
  });
  registry.registerPackage({
    source: "builtin",
    manifest: { ...manifest, version: "1.3.0" },
    execute: () => ({ outputs: { ok: true } }),
  });

  assert.equal(
    registry.resolvePackage("@beam/test", "^1.2.0").manifest.version,
    "1.3.0",
  );
  assert.equal(
    registry.resolvePackage("@beam/test", "1.2.3").manifest.version,
    "1.2.3",
  );
  assert.throws(
    () => registry.resolvePackage("@beam/test", "^2.0.0"),
    ActionPackageNotFoundError,
  );
});

test("rejects remote installation in V1", () => {
  const registry = new LocalActionRegistry();
  assert.throws(() => registry.installRemote(), RemoteActionInstallError);
});
