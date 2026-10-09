import { BEAM_TRANSFER_ACTION } from "./graph-semantics.js";

/** The fields a step contributes to the billing key, however it is stored. */
export type BillingKeyStep = {
  actionPackage?: unknown;
  enabled?: unknown;
  config?: unknown;
};

export type WorkflowBillingKey =
  | { apiKeyId: string; source: "workflow" | "transfer-step" }
  | { apiKeyId: null; reason: "missing" | "conflicting-transfer-keys" };

/**
 * The Beam API key a workflow's runs are authorized and charged with.
 *
 * A key selected in Workflow Settings always wins. Without one, the workflow
 * uses the Beam credential its Beam Transfer steps already name, so a customer
 * who picked a key for the transfer does not have to pick it a second time for
 * billing, including when the credential was created after the workflow.
 *
 * Only Beam Transfer steps count: their credential is by definition a Beam API
 * key of this organization, whereas other actions name credentials for other
 * services. Transfer steps naming different keys are ambiguous, and charging
 * one of them arbitrarily would spend an allowance meant for the other, so that
 * case asks for an explicit selection.
 */
export function resolveWorkflowBillingKey(
  selectedApiKeyId: unknown,
  steps: Iterable<BillingKeyStep>,
): WorkflowBillingKey {
  const selected = text(selectedApiKeyId);
  if (selected) return { apiKeyId: selected, source: "workflow" };

  const transferKeys = new Set<string>();
  for (const step of steps) {
    if (step.actionPackage !== BEAM_TRANSFER_ACTION) continue;
    if (step.enabled === false) continue;
    const credentialId = text(record(step.config).credentialId);
    if (credentialId) transferKeys.add(credentialId);
  }

  if (transferKeys.size === 1) {
    return { apiKeyId: [...transferKeys][0]!, source: "transfer-step" };
  }
  return {
    apiKeyId: null,
    reason: transferKeys.size ? "conflicting-transfer-keys" : "missing",
  };
}

/** Customer wording for a workflow that has no billing key to run with. */
export function missingBillingKeyMessage(
  reason: "missing" | "conflicting-transfer-keys",
) {
  return reason === "conflicting-transfer-keys"
    ? "This workflow's Beam Transfer steps use different Beam credentials. Select the billing API key under Workflow Settings before running."
    : "Select a Beam credential in the Beam Transfer step, or a billing API key under Workflow Settings, before running.";
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
