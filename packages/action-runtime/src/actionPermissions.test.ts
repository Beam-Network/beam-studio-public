import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ActionManifest } from "@beam-studio/core";
import {
  assertExecutorCanLoadAction,
  defaultAllowedActionPermissions,
  sandboxRpcMethodsForAction,
} from "./actionPermissions.js";

test("v2 admission requires the probed native budget and a representable CPU limit", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../../core/src/workflows/fixtures/registry-v2/v2-single.valid.json", import.meta.url),
      "utf8",
    ),
  ) as ActionManifest;
  const options = {
    actionPackage: manifest.name,
    allowedActionPermissions: manifest.permissions,
    v2BudgetsAvailable: true,
  };
  assert.doesNotThrow(() => assertExecutorCanLoadAction(manifest, options));
  assert.throws(
    () => assertExecutorCanLoadAction(manifest, { ...options, v2BudgetsAvailable: false }),
    /enforced CPU and peak-memory limits/,
  );
  assert.throws(
    () => assertExecutorCanLoadAction({ ...manifest, contracts: {
      ...manifest.contracts!, resources: { ...manifest.contracts!.resources, cpuMillis: 999 },
    } }, options),
    /cannot be enforced/,
  );
});

test("storage delete permission exposes only the object delete RPC", () => {
  const manifest = {
    name: "@beam/object-storage-delete",
    version: "1.0.0",
    apiVersion: "workflow-actions/v1",
    runtime: { placements: ["local-workers"] },
    inputs: {},
    outputs: {},
    permissions: ["storage:delete"],
  } satisfies ActionManifest;

  assert.ok(defaultAllowedActionPermissions.includes("storage:delete"));
  assert.ok(
    sandboxRpcMethodsForAction(manifest).includes("beam.objectStorage.delete"),
  );
  assert.equal(
    sandboxRpcMethodsForAction(manifest).includes(
      "beam.objectStorage.download",
    ),
    false,
  );
  assert.equal(
    sandboxRpcMethodsForAction(manifest).includes("beam.objectStorage.upload"),
    false,
  );
});
