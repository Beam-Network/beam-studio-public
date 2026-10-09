import assert from "node:assert/strict";
import test from "node:test";
import {
  billingKeyEmptySelection,
  workflowBillingKey,
} from "./workflow-billing-key";

const transfer = (credentialId: string) => ({
  actionPackageName: "@beam/transfer",
  enabled: true,
  config: { credentialId },
});

test("an unselected billing key follows the Beam Transfer step", () => {
  assert.deepEqual(billingKeyEmptySelection([transfer("beam_key")]), {
    keyId: "beam_key",
    label: "Same as the Beam Transfer step",
  });
  assert.equal(
    workflowBillingKey(null, [transfer("beam_key")]).apiKeyId,
    "beam_key",
  );
});

test("a selected billing key is what runs are charged to", () => {
  assert.equal(
    workflowBillingKey("settings_key", [transfer("beam_key")]).apiKeyId,
    "settings_key",
  );
});

test("without a transfer credential the selection explains what is missing", () => {
  const selection = billingKeyEmptySelection([transfer("")]);
  assert.equal(selection.keyId, null);
  assert.match(selection.warning ?? "", /Beam Transfer step/);
});
