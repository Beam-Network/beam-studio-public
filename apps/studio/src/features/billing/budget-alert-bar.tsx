import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { apiGet } from "@/lib/api-client";
import {
  formatCreditAmount,
  formatCredits,
  toHundredths,
} from "@/lib/format-credits";

/**
 * A budget warning, where the work happens.
 *
 * A budget that only reports itself in the Beam console is a budget nobody
 * acts on: the person composing a workflow here is the one who decides whether
 * to run it, and they are not looking at another product's notification centre.
 */

type BudgetAlert = {
  id: string;
  targetType: string;
  threshold: number;
  usageCredits: number;
  budgetCredits: number;
  percentUsed: number;
  createdAt: string;
  apiKey: { id: string; name: string | null; prefix: string | null } | null;
  project: { id: string; name: string | null } | null;
};

type BudgetAlertsResponse = {
  alerts: BudgetAlert[];
  configured: boolean;
  mostUrgent: BudgetAlert | null;
};

/**
 * How many *other* budgets are in trouble.
 *
 * Counting alert rows read "+2 more alerts" the moment one key crossed 50, 80
 * and 95 in a single charge -- which is the ordinary case, not an unusual one.
 * It said three things were wrong when one budget had been spent. Counting
 * distinct targets makes the number mean what a reader assumes it means.
 */
function otherTargetCount(alerts: BudgetAlert[], shown: BudgetAlert) {
  const key = (alert: BudgetAlert) =>
    alert.apiKey?.id ?? alert.project?.id ?? `${alert.targetType}:organization`;
  const shownKey = key(shown);
  return new Set(alerts.map(key).filter((id) => id !== shownKey)).size;
}

function targetName(alert: BudgetAlert) {
  if (alert.apiKey) return alert.apiKey.name || alert.apiKey.prefix || "an API key";
  if (alert.project) return alert.project.name || "a project";
  return "this organization";
}

export function useBudgetAlerts() {
  return useQuery({
    queryKey: ["budget-alerts"],
    queryFn: ({ signal }) => apiGet<BudgetAlertsResponse>("/studio/budget-alerts", signal),
    // Budgets move at the pace of spend, not of clicks.
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
    retry: false,
  });
}

export function BudgetAlertBar({ className }: { className?: string }) {
  const { data } = useBudgetAlerts();
  const alert = data?.mostUrgent;

  // Nothing to say when no credential is configured, when nothing has crossed a
  // threshold, or while the first read is still in flight. A bar that flashes on
  // every page load teaches people to ignore it.
  if (!data?.configured || !alert) return null;

  const spent =
    toHundredths(alert.budgetCredits) > 0 &&
    toHundredths(alert.usageCredits) >= toHundredths(alert.budgetCredits);
  const otherCount = otherTargetCount(data.alerts, alert);

  return (
    <div
      role="status"
      className={[
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-control border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900",
        "dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
      <span>
        <strong className="font-medium">{targetName(alert)}</strong>{" "}
        {spent ? "has spent its monthly budget" : `passed ${alert.threshold}% of its monthly budget`}
        {" — "}
        {formatCreditAmount(alert.usageCredits)} of {formatCredits(alert.budgetCredits)} used.
      </span>
      {otherCount > 0 && (
        <span className="text-xs opacity-80">
          +{otherCount} other {otherCount === 1 ? "budget" : "budgets"}
        </span>
      )}
    </div>
  );
}
