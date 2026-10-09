import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionPermissionError,
  ActionPlacementError,
  ActionTrustError,
  builtinActionCatalog,
  createBuiltinActionRegistry,
  runActionHarness,
  runLinearWorkflow,
  type ActionJson,
  type ActionManifest,
  type WorkflowRunSnapshot,
} from "../index.js";
import { memoryStore } from "./test-helpers.js";

test("builtin catalog exposes versioned metadata for every action", () => {
  const catalog = builtinActionCatalog();
  assert.ok(catalog.length >= 10);
  const names = new Set<string>();

  for (const entry of catalog) {
    assert.match(entry.manifest.name, /^@beam\//);
    assert.equal(entry.manifest.trustLevel, "builtin");
    assert.ok(entry.manifest.inputs);
    assert.ok(entry.manifest.outputs);
    assert.ok(entry.catalog.category);
    assert.ok(entry.catalog.owner);
    assert.ok(entry.catalog.tags.length);
    assert.ok(entry.catalog.changelog.length);
    assert.ok(entry.checksum.length >= 32);
    const identity = `${entry.manifest.name}@${entry.manifest.version}`;
    assert.equal(names.has(identity), false);
    names.add(identity);
  }
  assert.equal(catalog.some((entry) => entry.manifest.name === "@beam/transfer"), false);
});

test("storage endpoint locks retain their published manifest while latest supports location", () => {
  const registry = createBuiltinActionRegistry();
  const original = registry.resolvePackage("@beam/object-storage-endpoint", "1.0.0");
  assert.equal(original.checksum, "97347e777cb638f9ca25465fbdf23bb9638c03f112f7013d14d4fbdc67801e92");
  const latest = registry.resolvePackage("@beam/object-storage-endpoint");
  assert.equal(latest.manifest.version, "1.1.0");
  assert.notEqual(latest.checksum, original.checksum);
  assert.ok((latest.manifest.configSchema?.properties as Record<string, unknown>).storageLocation);
  assert.equal((original.manifest.configSchema?.properties as Record<string, unknown>).storageLocation, undefined);
});

test("builtin registry rejects first-party packages outside the catalog", () => {
  const registry = createBuiltinActionRegistry();
  const manifest = {
    name: "@beam/private-test",
    version: "1.0.0",
    apiVersion: "workflow-actions/v1",
    runtime: { placements: ["local-workers"] },
    inputs: {},
    outputs: {},
  } satisfies ActionManifest;

  assert.throws(
    () =>
      registry.registerPackage({
        source: "builtin",
        manifest,
        execute: () => ({ outputs: {} }),
      }),
    ActionTrustError,
  );
});

test("action harness executes builtin actions with artifacts", async () => {
  const action = builtinActionCatalog().find(
    (entry) => entry.manifest.name === "@beam/upload",
  );
  assert.ok(action);

  const result = await runActionHarness(
    action.execute,
    {
      inputs: {
        endpoint: {
          provider: "s3",
          bucket: "beam-fixtures",
          objectKey: "output/report.csv",
          credentialId: "cred_s3",
        },
        content: "id\n1",
      },
    },
    {
      beam: {
        objectStorage: {
          upload: async (_endpoint: unknown, content: string) => ({
            bytes: Buffer.byteLength(content),
          }),
        },
      },
    },
  );

  assert.deepEqual(result.outputs, {
    uri: "s3://beam-fixtures/output/report.csv",
    bytes: 4,
  });
  assert.equal(result.artifacts.length, 1);
});

test("runner enforces permissions, trust levels, placements, and secret grants", async () => {
  const registry = createBuiltinActionRegistry();

  await assert.rejects(
    () =>
      runLinearWorkflow(workflow("@beam/upload", { content: "hello" }), {
        registry,
        store: memoryStore(),
        permissions: { allowed: ["storage:read"] },
      }),
    ActionPermissionError,
  );

  await assert.rejects(
    () =>
      runLinearWorkflow(workflow("@beam/webhook", {}), {
        registry,
        store: memoryStore(),
        placementPolicy: { allowedPlacements: ["custom"] },
      }),
    ActionPlacementError,
  );

  await assert.rejects(
    () =>
      runLinearWorkflow(workflow("@beam/webhook", {}), {
        registry,
        store: memoryStore(),
        trustPolicy: { allowedTrustLevels: ["verified"] },
      }),
    ActionTrustError,
  );
});

function workflow(
  actionPackage: string,
  inputBindings: Record<string, ActionJson>,
): WorkflowRunSnapshot {
  return {
    workflowRunId: `wfr_${actionPackage.replace(/[^\w]+/g, "_")}`,
    templateId: "wft_policy",
    templateSnapshot: {},
    runtimeInputs: {},
    steps: [
      {
        id: "step",
        position: 0,
        enabled: true,
        actionPackage,
        versionRange: "1.0.0",
        config: {},
        inputBindings,
      },
    ],
  };
}
