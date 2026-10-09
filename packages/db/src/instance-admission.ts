/**
 * Whether this deployment serves an organization.
 *
 * Studio verifies that an organization belongs to the caller, by asking Beam
 * with the caller's own token. That answers "is this org yours?" and was
 * mistaken for "is this org ours?", which nothing asked — so any Beam account
 * that could reach a deployment could use it as its own tenant. This is the
 * missing half: the deployment's own record of who it admits.
 *
 * It lives here rather than in the API because the MCP server validates its
 * tokens in its own process. A second copy of these rules there drifted within
 * one release: it admitted tokens only on a `claimed` instance, so every
 * upgraded (`adopted`) self-host refused every MCP token while the API kept
 * serving the same organizations. Both processes now build this authority and
 * differ only in how they read the two rows it needs.
 *
 * It reads only Studio's database. `/studio/session` is polled by the app
 * shell and `server.test.ts` pins the outbound Beam calls per request, so an
 * authority that called Beam here would be both slower and a broken contract.
 */

import { LOCAL_ORGANIZATION_ID } from "./database-url.js";
import type { SqlDatabase } from "./sql-database.js";

/**
 * - `unclaimed` — a fresh installation. Serves nobody until it is claimed.
 * - `adopted`   — was already serving people when instance governance arrived.
 *                 Behaves as it did before; still has no owner.
 * - `claimed`   — a team owns it and decides who else may use it.
 */
export type InstanceState = "unclaimed" | "adopted" | "claimed";
export type JoinPolicy = "open" | "request" | "closed";
export type MembershipRole = "owner" | "member";
export type MembershipStatus = "admitted" | "pending" | "revoked";

/**
 * - `admitted`: this deployment serves the organization.
 * - `unclaimed`: a fresh deployment nobody owns yet, so it serves nobody. An
 *   adopted deployment is not this: it was already serving people, and
 *   refusing them on the deploy that introduced ownership would be the outage
 *   this model exists to prevent.
 * - `pending`: the organization has asked to join and has not been answered.
 * - `revoked`: the owner removed it.
 * - `forbidden`: it was never admitted and the join policy will not take it.
 */
export type AdmissionOutcome =
  | "admitted"
  | "unclaimed"
  | "pending"
  | "revoked"
  | "forbidden";

export type AdmissionVerdict = {
  outcome: AdmissionOutcome;
  /** Set when the organization is admitted, for instance-admin decisions. */
  role: MembershipRole | null;
  /** What the caller would have to do to be let in, for the UI to explain. */
  joinPolicy: JoinPolicy;
  /**
   * Why the organization is admitted.
   *
   * - `recorded` — a decision someone made, stored in the database.
   * - `policy`   — nobody decided; an open instance takes all comers.
   * - `exempt`   — the deployment acting as itself.
   *
   * Machine callers require `recorded` or `exempt`; see
   * {@link admitsMachineCaller}.
   */
  source: "recorded" | "policy" | "exempt" | null;
};

export type InstanceSnapshot = {
  state: InstanceState;
  joinPolicy: JoinPolicy;
  ownerOrganizationId: string | null;
};

export type InstanceMembership = {
  role: MembershipRole;
  status: MembershipStatus;
};

/**
 * What a database that has never had the schema applied reads as: it has no
 * singleton row, and that is not permission.
 */
export const UNSEEDED_INSTANCE: InstanceSnapshot = {
  state: "unclaimed",
  joinPolicy: "closed",
  ownerOrganizationId: null,
};

/** The reads (and the one write) the authority needs, per process. */
export type InstanceAdmissionStore = {
  readInstance(): Promise<InstanceSnapshot>;
  readMembership(organizationId: string): Promise<InstanceMembership | null>;
  /** Records a join request. Only browser sessions ever ask for this. */
  requestAccess?(input: {
    organizationId: string;
    userId: string | null;
    email: string | null;
  }): Promise<void>;
};

export type InstanceAdmissionAuthorityOptions = {
  store: InstanceAdmissionStore;
  /**
   * The Rooms consumer organization, admitted unconditionally. It is the
   * deployment acting as itself, not a tenant that was let in.
   */
  consumerOrganizationId?: string | null;
  now?: () => number;
  /**
   * How long an answer is reused. Short on purpose: this runs on every
   * request, and an admission that takes effect a minute later reads as a
   * broken UI. Mutations call `forget()` so the wait is normally zero — but
   * only in the process that made them, so another process that must see a
   * revoke at once (the MCP server) passes 0.
   */
  ttlMs?: number;
};

/** Organizations this deployment serves regardless of what the database says. */
export function alwaysAdmitted(consumerOrganizationId?: string | null) {
  const ids = new Set<string>([LOCAL_ORGANIZATION_ID]);
  const consumer = consumerOrganizationId?.trim();
  if (consumer) {
    // The Rooms consumer bootstrap runs as this organization. Leaving it out
    // would make the deployment's own agents unmanageable through its own UI.
    ids.add(consumer);
  }
  return ids;
}

/**
 * Whether a machine caller (an MCP token, on the MCP server or as an API
 * bearer) may act for the organization in this verdict.
 *
 * An open join policy does not admit here. A token proves nothing about
 * current Beam membership, so letting one admit its own organization would let
 * a token for an organization that has since been removed quietly re-admit it.
 * Admission by policy is a browser-session decision; a machine caller needs a
 * recorded one.
 */
export function admitsMachineCaller(verdict: AdmissionVerdict) {
  return verdict.outcome === "admitted" && verdict.source !== "policy";
}

type Entry<T> = { value: T; checkedAt: number };

const DEFAULT_TTL_MS = 10_000;
const INSTANCE_CACHE_KEY = "singleton";

export function createInstanceAdmissionAuthority(
  options: InstanceAdmissionAuthorityOptions,
) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const exempt = alwaysAdmitted(options.consumerOrganizationId);

  const instanceCache = new Map<string, Entry<InstanceSnapshot>>();
  const organizationCache = new Map<string, Entry<AdmissionVerdict>>();
  // Concurrent requests share one query rather than each making their own.
  const inflightInstance = new Map<string, Promise<InstanceSnapshot>>();
  const inflightOrganization = new Map<string, Promise<AdmissionVerdict>>();

  async function loadInstance(): Promise<InstanceSnapshot> {
    const snapshot = await store.readInstance();
    instanceCache.set(INSTANCE_CACHE_KEY, {
      value: snapshot,
      checkedAt: now(),
    });
    return snapshot;
  }

  async function instance(): Promise<InstanceSnapshot> {
    const cached = instanceCache.get(INSTANCE_CACHE_KEY);
    if (cached && now() - cached.checkedAt < ttlMs) return cached.value;

    const existing = inflightInstance.get(INSTANCE_CACHE_KEY);
    if (existing) return existing;

    const pending = loadInstance().finally(() => {
      inflightInstance.delete(INSTANCE_CACHE_KEY);
    });
    inflightInstance.set(INSTANCE_CACHE_KEY, pending);
    return pending;
  }

  async function resolve(organizationId: string): Promise<AdmissionVerdict> {
    const snapshot = await instance();
    const joinPolicy = snapshot.joinPolicy;

    if (exempt.has(organizationId)) {
      // The exemption guarantees admission — the deployment's own
      // organizations are served even before it is claimed. It must not also
      // decide the role. An owner that happens to be the Rooms consumer
      // organization was otherwise demoted to member and refused from every
      // instance-admin route on the instance it owns.
      const own = await store.readMembership(organizationId);
      return {
        outcome: "admitted",
        role: own?.role ?? "member",
        joinPolicy,
        source: own?.status === "admitted" ? "recorded" : "exempt",
      };
    }
    // Only a fresh installation refuses outright. An adopted one carries on
    // exactly as before and is evaluated against its membership and policy
    // below, which is what keeps this change invisible to live deployments.
    if (snapshot.state === "unclaimed") {
      return { outcome: "unclaimed", role: null, joinPolicy, source: null };
    }

    const membership = await store.readMembership(organizationId);
    if (membership?.status === "admitted") {
      return {
        outcome: "admitted",
        role: membership.role,
        joinPolicy,
        source: "recorded",
      };
    }
    if (membership?.status === "revoked") {
      return { outcome: "revoked", role: null, joinPolicy, source: null };
    }
    if (membership?.status === "pending") {
      return { outcome: "pending", role: null, joinPolicy, source: null };
    }

    // No row. An open instance admits on first use, but the row is written by
    // the caller that proved Beam membership, never here — this is a read.
    return joinPolicy === "open"
      ? { outcome: "admitted", role: "member", joinPolicy, source: "policy" }
      : { outcome: "forbidden", role: null, joinPolicy, source: null };
  }

  async function load(organizationId: string): Promise<AdmissionVerdict> {
    const verdict = await resolve(organizationId);
    organizationCache.set(organizationId, { value: verdict, checkedAt: now() });
    return verdict;
  }

  return {
    /** The deployment's own state, for the claim funnel and the settings UI. */
    instance,

    /** Whether this deployment serves an organization. */
    async check(organizationId: string): Promise<AdmissionVerdict> {
      const cached = organizationCache.get(organizationId);
      if (cached && now() - cached.checkedAt < ttlMs) return cached.value;

      const existing = inflightOrganization.get(organizationId);
      if (existing) return existing;

      const pending = load(organizationId).finally(() => {
        inflightOrganization.delete(organizationId);
      });
      inflightOrganization.set(organizationId, pending);
      return pending;
    },

    /**
     * Records that an organization asked to join, when the policy invites it.
     *
     * Called only after Beam has confirmed the caller belongs to the
     * organization, so a stranger cannot make this deployment file requests
     * about organizations they have nothing to do with. Creating a row is
     * enough — an already-admitted or deliberately revoked organization is
     * left alone, and a closed instance records nothing at all rather than
     * becoming a stranger's inbox.
     */
    async requestAccess(
      organizationId: string,
      user: { userId: string | null; email: string | null },
    ) {
      if (!store.requestAccess) {
        throw new Error("This admission store cannot record join requests.");
      }
      const snapshot = await instance();
      if (snapshot.joinPolicy !== "request") return false;
      await store.requestAccess({
        organizationId,
        userId: user.userId,
        email: user.email,
      });
      organizationCache.delete(organizationId);
      return true;
    },

    /**
     * Drops cached answers after a decision, so an admit or a revoke takes
     * effect on the next request instead of after the TTL.
     */
    forget(organizationId?: string) {
      instanceCache.delete(INSTANCE_CACHE_KEY);
      if (organizationId) {
        organizationCache.delete(organizationId);
        return;
      }
      organizationCache.clear();
    },
  };
}

export type InstanceAdmissionAuthority = ReturnType<
  typeof createInstanceAdmissionAuthority
>;

/**
 * The store for a process that reads through the synchronous bridge (the MCP
 * server). Takes a getter so the connection is opened lazily and reopened
 * after the process closes it. A failed read rejects like any other query, so
 * an outage is answered as unavailable, never as a refusal.
 */
export function synchronousInstanceAdmissionStore(
  database: () => SqlDatabase,
): InstanceAdmissionStore {
  return {
    async readInstance() {
      const row = database()
        .prepare(
          `SELECT state, owner_organization_id, join_policy
             FROM studio.instance
            WHERE id = 'singleton'`,
        )
        .get();
      if (!row) return UNSEEDED_INSTANCE;
      return {
        state: String(row.state) as InstanceState,
        joinPolicy: String(row.join_policy) as JoinPolicy,
        ownerOrganizationId:
          row.owner_organization_id == null
            ? null
            : String(row.owner_organization_id),
      };
    },
    async readMembership(organizationId) {
      const row = database()
        .prepare(
          `SELECT role, status
             FROM studio.instance_organizations
            WHERE organization_id = :organizationId`,
        )
        .get({ organizationId });
      return row
        ? {
            role: String(row.role) as MembershipRole,
            status: String(row.status) as MembershipStatus,
          }
        : null;
    },
  };
}
