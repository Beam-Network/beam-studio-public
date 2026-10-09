import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const registryData = source("features/registry/registry-data.ts");
const registryRoute = source("routes/registry.tsx");
const registryDetail = source("routes/registry_.$scope.$name.tsx");
const workflowEditor = source("features/workflows/workflow-graph-editor.tsx");
const workflowValidation = source(
  "features/workflows/workflow-graph-validation.ts",
);
const actionCatalog = source("features/workflows/action-catalog-dialog.tsx");
const dialog = source("components/ui/dialog.tsx");

test("Registry UI exposes installed, available, deprecated, blocked, vulnerable, and advisory states", () => {
  for (const state of [
    "installed",
    "available",
    "deprecated",
    "blocked",
    "vulnerable",
    "advisory",
  ]) {
    assert.match(registryData, new RegExp(`id: "${state}`));
  }
  assert.match(registryRoute, /registryPackageStates\(item\)/);
  assert.match(actionCatalog, /registryInstallBlockedReason/);
  assert.match(registryDetail, /<AdvisoryList/);
  assert.match(workflowValidation, /is blocked by Registry policy/);
  assert.match(workflowValidation, /Registry security advisor/);
});

test("Registry detail compares manifests and explains exact install identity", () => {
  assert.match(registryData, /compareRegistryManifests/);
  assert.match(registryDetail, /Installed and available identity/);
  assert.match(registryDetail, /Manifest checksum/);
  assert.match(registryDetail, /Artifact checksum/);
  assert.match(registryDetail, /Artifact reference/);
  assert.match(registryDetail, /Source/);
  assert.match(registryDetail, /Trust/);
});

test("workflow save blocks on action-lock confirmation and renders old and proposed identities", () => {
  assert.match(workflowEditor, /workflow_action_lock_confirmation_required/);
  assert.match(workflowEditor, /Review workflow action lock changes/);
  assert.match(workflowEditor, /Current lock/);
  assert.match(workflowEditor, /Proposed lock/);
  assert.match(workflowEditor, /Confirm lock changes/);
  assert.match(workflowEditor, /artifact \{lock\.artifactChecksum/);
});

test("Registry update surfaces explain that workflow locks do not change silently", () => {
  assert.match(
    registryRoute,
    /does not silently change existing workflow locks/,
  );
  assert.match(
    actionCatalog,
    /Existing\s+workflow[\s\S]*locks will remain unchanged/,
  );
});

test("Action marketplace keeps the shared dialog fixed to the viewport", () => {
  assert.match(dialog, /fixed left-1\/2 top-1\/2/);
  assert.doesNotMatch(actionCatalog, /<DialogContent className="relative/);
});

function source(path) {
  return readFileSync(join(sourceRoot, path), "utf8");
}
