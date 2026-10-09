import { useQuery } from "@tanstack/react-query";
import type { BeamEnvironmentTemplate } from "@beam-studio/shared";
import { useEffect } from "react";
import { KeyRound } from "lucide-react";
import { apiGet } from "@/lib/api-client";

export type BillingApiKey = {
  id: string;
  name: string;
  baseUrl?: string | null;
  natsUrl?: string | null;
  environment?: string | null;
  source?: string | null;
  organizationName?: string | null;
  /** The Studio instance key, which new workflows and transfers default to. */
  instanceDefault?: boolean;
};

export const billingKeysQueryKey = ["/studio/api-keys"] as const;

export function useBillingApiKeys() {
  return useQuery({
    queryFn: () => apiGet<{ apiKeys?: BillingApiKey[] }>("/studio/api-keys"),
    queryKey: billingKeysQueryKey,
    select: (data) => data.apiKeys ?? [],
  });
}

/**
 * Picks the Beam API key a workflow charges its runs to.
 *
 * An organization holds one credit pool but may issue many keys against it,
 * each with its own cap and monthly budget, so the key has to be chosen rather
 * than inferred: charging an arbitrary one would spend an allowance assigned to
 * something else and report the usage against the wrong key.
 */
export function BillingKeySelect({
  beamTemplate,
  emptySelection,
  onChange,
  value,
}: {
  beamTemplate?: BeamEnvironmentTemplate | null;
  /**
   * What leaving the key unselected means, when it means something: a
   * workflow without a selected key is charged to its Beam Transfer step's
   * credential.
   */
  emptySelection?: BillingKeyEmptySelection | null;
  onChange: (apiKeyId: string) => void;
  value: string;
}) {
  const { data: keys = [], isPending } = useBillingApiKeys();
  const filteredKeys = beamTemplate
    ? keys.filter((key) => billingKeyMatchesTemplate(key, beamTemplate))
    : keys;
  const selectedKeyAvailable = filteredKeys.some((key) => key.id === value);
  useEffect(() => {
    if (value && !isPending && !selectedKeyAvailable) onChange("");
  }, [isPending, onChange, selectedKeyAvailable, value]);
  const missing = !isPending && filteredKeys.length === 0;
  const fallbackKey = emptySelection?.keyId
    ? keys.find((key) => key.id === emptySelection.keyId)
    : undefined;
  const unset = !isPending && !missing && !value && !emptySelection?.keyId;

  return (
    <div className="grid gap-2">
      <label className="grid gap-2 text-sm font-medium">
        Billing API key
        <select
          className="h-10 rounded-control border bg-background px-3 text-sm font-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          disabled={isPending || missing}
          onChange={(event) => onChange(event.target.value)}
          value={selectedKeyAvailable ? value : ""}
        >
          <option value="">
            {isPending
              ? "Loading keys…"
              : emptySelection?.keyId
                ? `${emptySelection.label}${fallbackKey ? ` (${fallbackKey.name})` : ""}`
                : "Select a key…"}
          </option>
          {filteredKeys.map((key) => (
            <option key={key.id} value={key.id}>
              {key.name}
              {key.instanceDefault ? " (instance default)" : ""}
              {key.organizationName ? ` — ${key.organizationName}` : ""}
            </option>
          ))}
        </select>
      </label>

      {missing ? (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <KeyRound aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {beamTemplate
              ? `No Beam API keys match ${beamTemplate.name}. Add or select a key for that Beam environment before running this.`
              : "No Beam API keys are configured. Add a Beam credential under Credentials before running this — runs are charged to a key and cannot start without one."}
          </span>
        </p>
      ) : null}

      {unset ? (
        <p className="flex items-start gap-2 text-xs text-warning dark:text-amber-500">
          <KeyRound aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {emptySelection?.warning ??
              "Runs will be refused until a key is selected."}
          </span>
        </p>
      ) : null}
    </div>
  );
}

export type BillingKeyEmptySelection = {
  /** The key an empty selection resolves to, or null when it resolves to none. */
  keyId: string | null;
  /** Option label for an empty selection that resolves to a key. */
  label: string;
  /** Why an empty selection resolves to no key, shown instead of the default. */
  warning?: string;
};

function billingKeyMatchesTemplate(
  key: BillingApiKey,
  template: BeamEnvironmentTemplate,
) {
  if (key.natsUrl && key.natsUrl !== template.natsUrl) return false;
  return sameUrlOrigin(key.baseUrl, template.baseUrl);
}

function sameUrlOrigin(left?: string | null, right?: string | null) {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
  }
}
