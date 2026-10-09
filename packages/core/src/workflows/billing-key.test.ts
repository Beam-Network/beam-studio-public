import assert from "node:assert/strict";
import test from "node:test";
import {
  missingBillingKeyMessage,
  resolveWorkflowBillingKey,
} from "./billing-key.js";

const transfer = (credentialId: string, enabled = true) => ({
  actionPackage: "@beam/transfer",
  enabled,
  config: { credentialId },
});

test("a key selected in Workflow Settings wins over the transfer step", () => {
  assert.deepEqual(
    resolveWorkflowBillingKey(" workflow-key ", [transfer("transfer-key")]),
    { apiKeyId: "workflow-key", source: "workflow" },
  );
});

test("without a selected key the Beam Transfer step's credential bills", () => {
  assert.deepEqual(
    resolveWorkflowBillingKey(null, [
      transfer("transfer-key"),
      transfer("transfer-key"),
      transfer(""),
    ]),
    { apiKeyId: "transfer-key", source: "transfer-step" },
  );
});

test("other actions' credentials never become the billing key", () => {
  assert.deepEqual(
    resolveWorkflowBillingKey("", [
      {
        actionPackage: "@beam/object-storage-endpoint",
        config: { credentialId: "storage-key" },
      },
      { config: { credentialId: "action-key" } },
    ]),
    { apiKeyId: null, reason: "missing" },
  );
});

test("a disabled transfer step does not choose the key", () => {
  assert.deepEqual(
    resolveWorkflowBillingKey(undefined, [
      transfer("disabled-key", false),
      transfer("active-key"),
    ]),
    { apiKeyId: "active-key", source: "transfer-step" },
  );
});

test("transfer steps naming different keys need an explicit selection", () => {
  const resolved = resolveWorkflowBillingKey(null, [
    transfer("first-key"),
    transfer("second-key"),
  ]);
  assert.deepEqual(resolved, {
    apiKeyId: null,
    reason: "conflicting-transfer-keys",
  });
  assert.match(
    missingBillingKeyMessage("conflicting-transfer-keys"),
    /Workflow Settings/,
  );
  assert.match(missingBillingKeyMessage("missing"), /Beam Transfer step/);
});
