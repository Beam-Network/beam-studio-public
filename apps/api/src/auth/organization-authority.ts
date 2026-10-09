/**
 * Whether Studio still has valid authority for an organization.
 *
 * A machine token records the organization it was issued for and nothing
 * else, so once issued it keeps working until it is revoked or expires — even
 * if the organization was disabled upstream. Beam is the authority on that,
 * and the only credential Studio holds that speaks for an organization
 * without a signed-in user is the organization's own stored Beam API key. If
 * Beam rejects that key, Studio no longer has standing to act for the
 * organization, and a token issued for it should stop working.
 *
 * This verifies the organization, not that the token's issuing user is still
 * a member. Checking the user would need a credential that speaks for the
 * user, and a machine token has none.
 */

export type AuthorityOutcome = "valid" | "revoked" | "unverified";

/** How Beam answered for a key, or that it could not be reached. */
export type KeyVerdict = "valid" | "rejected" | "unavailable";

type Entry = {
  verdict: Exclude<AuthorityOutcome, "unverified">;
  checkedAt: number;
};

export type OrganizationAuthorityOptions = {
  /** The organization's stored Beam API key, or null if it holds none. */
  resolveKey: (organizationId: string) => Promise<string | null>;
  /** Asks Beam whether the key still authenticates. */
  verifyKey: (apiKey: string) => Promise<KeyVerdict>;
  now?: () => number;
  /** How long an answer is reused before asking Beam again. */
  ttlMs?: number;
  /**
   * How long a previous success is honoured while Beam is unreachable. A
   * transient outage should not lock every machine caller out at once; a
   * sustained one eventually does.
   */
  graceMs?: number;
};

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_GRACE_MS = 30 * 60_000;

export function createOrganizationAuthority(
  options: OrganizationAuthorityOptions,
) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const cache = new Map<string, Entry>();
  // Concurrent requests for one organization share a single check rather than
  // each making their own call to Beam.
  const inflight = new Map<string, Promise<AuthorityOutcome>>();

  async function resolve(organizationId: string): Promise<AuthorityOutcome> {
    const cached = cache.get(organizationId);
    if (cached && now() - cached.checkedAt < ttlMs) return cached.verdict;

    const key = await options.resolveKey(organizationId);
    if (!key) {
      // Studio holds no key for this organization, so there is nothing to ask
      // Beam with. The token's own expiry and revocation still apply.
      return "unverified";
    }

    const verdict = await options.verifyKey(key);
    if (verdict === "rejected") {
      cache.set(organizationId, { verdict: "revoked", checkedAt: now() });
      return "revoked";
    }
    if (verdict === "valid") {
      cache.set(organizationId, { verdict: "valid", checkedAt: now() });
      return "valid";
    }

    // Beam was unreachable. Ride a recent success rather than locking every
    // machine caller out over a blip.
    if (cached?.verdict === "valid" && now() - cached.checkedAt < graceMs) {
      return "valid";
    }
    return "unverified";
  }

  return {
    /**
     * "revoked" means Beam explicitly rejected the organization's key.
     * "unverified" means the check could not be made — no key is stored, or
     * Beam is unreachable beyond the grace window. Callers decide what to do
     * with that; the token's own expiry and revocation are the primary control
     * either way.
     */
    async check(organizationId: string): Promise<AuthorityOutcome> {
      const existing = inflight.get(organizationId);
      if (existing) return existing;
      const pending = resolve(organizationId).finally(() => {
        inflight.delete(organizationId);
      });
      inflight.set(organizationId, pending);
      return pending;
    },
    /** Drops a cached answer, so the next check asks Beam again. */
    forget(organizationId: string) {
      cache.delete(organizationId);
    },
  };
}

export type OrganizationAuthority = ReturnType<
  typeof createOrganizationAuthority
>;
