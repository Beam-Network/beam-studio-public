import {
  missingBillingKeyMessage,
  resolveWorkflowBillingKey,
} from "@beam-studio/core/workflows/billing-key";
import type { BillingKeyEmptySelection } from "@/features/billing/billing-key-select";

type BillingStep = {
  actionPackageName: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

/**
 * The key a run of this workflow would be charged to: the one selected in
 * Workflow Settings or, without one, its Beam Transfer steps' credential. The
 * API resolves it the same way when the run starts.
 */
export function workflowBillingKey(
  apiKeyId: string | null | undefined,
  steps: BillingStep[],
) {
  return resolveWorkflowBillingKey(
    apiKeyId,
    steps.map((step) => ({
      actionPackage: step.actionPackageName,
      enabled: step.enabled,
      config: step.config,
    })),
  );
}

/** What leaving Workflow Settings' key unselected means for these steps. */
export function billingKeyEmptySelection(
  steps: BillingStep[],
): BillingKeyEmptySelection {
  const resolved = workflowBillingKey(null, steps);
  return resolved.apiKeyId !== null
    ? { keyId: resolved.apiKeyId, label: "Same as the Beam Transfer step" }
    : {
        keyId: null,
        label: "",
        warning: missingBillingKeyMessage(resolved.reason),
      };
}
