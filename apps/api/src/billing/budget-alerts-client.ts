import { webEnv } from "../env.js";

/**
 * Monthly budget threshold alerts, read from the Beam management API.
 *
 * Studio reads these with a read-only service account credential rather than
 * an organization's Beam API key: it carries only the permissions it was
 * granted, and showing a warning bar does not warrant a key that can spend.
 *
 * Without a credential configured this returns no alerts rather than failing.
 * A missing warning bar is a smaller problem than a Studio that will not load.
 */

export type BudgetAlert = {
  id: string;
  targetType: string;
  threshold: number;
  usageCredits: number;
  budgetCredits: number;
  percentUsed: number;
  month: string;
  createdAt: string;
  acknowledgedAt: string | null;
  apiKey: { id: string; name: string | null; prefix: string | null } | null;
  project: { id: string; name: string | null } | null;
};

export type BudgetAlertsResult = {
  alerts: BudgetAlert[];
  /** False when no credential is configured, so the UI can stay quiet rather than claim all-clear. */
  configured: boolean;
  /**
   * The organization the credential speaks for. Studio serves several
   * organizations from one credential, so the caller has to check this against
   * the viewer rather than assume the alerts are theirs.
   */
  organizationId: string | null;
};

const REQUEST_TIMEOUT_MS = 8_000;

export async function fetchBudgetAlerts(options?: {
  fetch?: typeof globalThis.fetch;
  credential?: string;
  apiUrl?: string;
  limit?: number;
}): Promise<BudgetAlertsResult> {
  const credential = (options?.credential ?? webEnv.beamManagementCredential ?? "").trim();
  if (!credential) return { alerts: [], configured: false, organizationId: null };

  const doFetch = options?.fetch ?? globalThis.fetch;
  const base = options?.apiUrl ?? webEnv.apiUrl;
  const url = new URL("/v1/alerts", base);
  url.searchParams.set("unacknowledged", "true");
  url.searchParams.set("limit", String(options?.limit ?? 20));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await doFetch(url, {
      headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      // A warning bar is not worth surfacing an error banner over.
      return { alerts: [], configured: true, organizationId: null };
    }
    const payload = (await response.json()) as {
      alerts?: BudgetAlert[];
      organizationId?: string;
    };
    return {
      alerts: Array.isArray(payload.alerts) ? payload.alerts : [],
      configured: true,
      organizationId: payload.organizationId ?? null,
    };
  } catch {
    return { alerts: [], configured: true, organizationId: null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The one alert worth putting in a bar.
 *
 * Highest threshold first, then most recent, because a key at 95% matters more
 * than three keys at 50% and a bar has room for one line.
 */
export function mostUrgentAlert(alerts: BudgetAlert[]): BudgetAlert | null {
  if (alerts.length === 0) return null;
  const [first] = [...alerts].sort((a, b) => {
    if (b.threshold !== a.threshold) return b.threshold - a.threshold;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return first ?? null;
}
