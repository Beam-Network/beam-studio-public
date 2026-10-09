import type { McpScope } from "@beam-studio/shared";

/**
 * Deployment-wide secrets. Each names exactly one operator-held value, so a
 * route cannot accidentally accept the wrong one.
 */
export type ServiceSecretName =
  | "BEAM_STUDIO_SHARED_SECRET"
  | "BEAM_STUDIO_ROOM_STORAGE_TOKEN"
  /** Derived from BEAM_STUDIO_SECRET_KEY; see packages/shared/src/ops-auth.ts. */
  | "BEAM_STUDIO_OPS_TOKEN";

/**
 * Deployment-wide secrets a caller signs requests with. The secret itself
 * never travels, so a route with one of these accepts no bearer copy of it.
 */
export type SigningSecretName =
  "STUDIO_OPS_SECRET";

/**
 * How a route is authenticated.
 *
 * Every route declares one. There is no implicit value: a route registered
 * without a policy aborts startup, so a new route cannot be unauthenticated by
 * omission the way it could when authentication was selected by path prefix.
 *
 * The kernel verifies `session` itself, because that was the class the old
 * prefix gate governed and the one whose logic was worth centralising. Every
 * other credential is checked inside the handler, against per-resource state
 * the handler has already resolved, and the kernel holds those routes to a
 * proof obligation instead. See `isHandlerVerified` and kernel.ts.
 */
export type RoutePolicy =
  /** Deliberately unauthenticated. Pinned one-for-one by the route snapshot. */
  | { readonly kind: "public"; readonly reason: string }
  /** Signed browser-session cookie, plus a Beam-verified organization. */
  | {
      readonly kind: "session";
      /**
       * none     — never required, never verified (the account listings).
       * optional — verified against Beam memberships when one is supplied.
       * required — must be supplied and must be a membership of the account.
       */
      readonly organization: "none" | "optional" | "required";
      /** Only /studio/organization-context reads the organization from a body. */
      readonly organizationFrom: "context" | "body";
      /** Only /studio/project-context reads the project from a body. */
      readonly projectFrom: "context" | "body";
      /** Selecting an organization drops any project scoped to the old one. */
      readonly clearsProject: boolean;
      /** true refuses viewer, read_only and restricted members. */
      readonly mutating: boolean;
      /** Only GET /studio/session may answer for an unauthenticated caller. */
      readonly anonymous: "deny" | "probe";
      /**
       * Scopes a machine token may present instead of a browser session.
       *
       * Absent means the route is reachable only from a signed-in browser.
       * That is the default, because most of the surface either has no
       * machine use or would hand a token more than it should have: the
       * assistant can execute plans, and the MCP token admin routes would let
       * a token mint another one.
       */
      readonly machine?: readonly McpScope[];
      /**
       * What this route needs from the deployment itself, as opposed to from
       * the caller.
       *
       * required   — this deployment must admit the caller's organization.
       * claimFunnel — reachable before the instance admits anyone, so an
       *               unclaimed instance can still be claimed and a refused
       *               caller can still be told why. Pinned by a snapshot.
       * admin      — the caller must belong to the owning organization.
       */
      readonly instance?: "required" | "claimFunnel" | "admin";
    }
  /** The short-lived cookie issued when a browser starts device login. */
  | { readonly kind: "loginSession" }
  /** beam_mcp_ machine token. "per-tool" reads the tool's scope requirement. */
  | { readonly kind: "mcp"; readonly scopes: readonly McpScope[] | "per-tool" }
  | { readonly kind: "serviceSecret"; readonly secret: ServiceSecretName }
  /** HMAC over the method, target, time, a single-use nonce and the body. */
  | { readonly kind: "signedRequest"; readonly secret: SigningSecretName }
  /** Per-resource capability token, verified with the resource's state. */
  | { readonly kind: "capability"; readonly resource: string }
  /** Enrolled agent: HMAC access token, or a signed short-lived media ticket. */
  | {
      readonly kind: "agent";
      readonly credential: "accessToken" | "mediaTicket";
    }
  /** Workflow trigger secret carried as a path segment. */
  | { readonly kind: "webhookTrigger" }
  /**
   * The request body *is* the credential exchange — an enrollment code, an
   * Ed25519 proof of possession. Nothing can be verified before parsing it.
   */
  | { readonly kind: "credentialExchange"; readonly exchange: string };

/**
 * True when the handler, not the kernel, performs the verification.
 *
 * These credentials are checked against per-resource state the handler has
 * already resolved — a claim token and its lease generation, an enrollment
 * code, an Ed25519 challenge, a token row and its scopes. Reimplementing that
 * in the kernel would duplicate the state lookup and risk diverging from it, so
 * the kernel enforces a proof obligation instead: the handler must record that
 * it accepted a credential before a success response is allowed out.
 */
export function isHandlerVerified(policy: RoutePolicy) {
  return policy.kind !== "public" && policy.kind !== "session";
}

const SESSION_DEFAULTS = {
  kind: "session",
  organization: "required",
  organizationFrom: "context",
  projectFrom: "context",
  clearsProject: false,
  mutating: false,
  anonymous: "deny",
  instance: "required",
} as const;

type SessionPolicy = Extract<RoutePolicy, { kind: "session" }>;
type SessionOverrides = Partial<Omit<SessionPolicy, "kind">>;

const session = (overrides: SessionOverrides): RoutePolicy => ({
  ...SESSION_DEFAULTS,
  ...overrides,
});

/** Scopes a machine token may use on this route, if any. */
type Machine = { readonly machine?: readonly McpScope[] };

/**
 * Routes never write policy literals; they call these, so the set of possible
 * policies stays small enough to audit by reading this file.
 */
export const auth = {
  public: (reason: string): RoutePolicy => ({ kind: "public", reason }),

  /** Authenticated read inside a verified organization. */
  read: (scoped: Machine = {}): RoutePolicy => session(scoped),
  /** Authenticated write inside a verified organization. */
  write: (scoped: Machine = {}): RoutePolicy =>
    session({ ...scoped, mutating: true }),
  /** Listing projects works with or without an organization selected. */
  accountOptionalOrganization: (): RoutePolicy =>
    session({ organization: "optional" }),
  /** POST /studio/organization-context. */
  selectOrganization: (): RoutePolicy =>
    session({ organizationFrom: "body", clearsProject: true }),
  /** POST /studio/project-context. */
  selectProject: (): RoutePolicy => session({ projectFrom: "body" }),
  /** GET /studio/session: reports whoever is, or is not, signed in. */
  sessionProbe: (): RoutePolicy =>
    session({
      organization: "none",
      anonymous: "probe",
      // Identity, not authorization. The app shell gates the whole SPA on this
      // answer, so an unclaimed instance that refused it would redirect-loop
      // instead of offering the claim it is waiting for. It reports only who
      // the caller is, back to that caller.
      instance: "claimFunnel",
    }),

  /**
   * Reachable before this deployment admits anyone.
   *
   * Kept to the smallest set that lets a stranger be told "this Studio is
   * private" and lets the installing team claim it: the session probe, the
   * caller's own Beam organization list, and the claim routes themselves.
   * Pinned by `claim-funnel.snapshot.ts`, so widening it is a security
   * decision rather than a refactor.
   */
  claimFunnel: (): RoutePolicy =>
    session({ organization: "none", instance: "claimFunnel" }),

  /** Administering the deployment: only the owning organization. */
  instanceAdmin: (): RoutePolicy =>
    session({ mutating: true, instance: "admin" }),

  loginSession: (): RoutePolicy => ({ kind: "loginSession" }),
  mcpPerTool: (): RoutePolicy => ({ kind: "mcp", scopes: "per-tool" }),
  serviceSecret: (secret: ServiceSecretName): RoutePolicy => ({
    kind: "serviceSecret",
    secret,
  }),
  signedRequest: (secret: SigningSecretName): RoutePolicy => ({
    kind: "signedRequest",
    secret,
  }),
  capability: (resource: string): RoutePolicy => ({
    kind: "capability",
    resource,
  }),
  agent: (): RoutePolicy => ({ kind: "agent", credential: "accessToken" }),
  mediaTicket: (): RoutePolicy => ({
    kind: "agent",
    credential: "mediaTicket",
  }),
  webhookTrigger: (): RoutePolicy => ({ kind: "webhookTrigger" }),
  credentialExchange: (exchange: string): RoutePolicy => ({
    kind: "credentialExchange",
    exchange,
  }),
} as const;

declare module "fastify" {
  interface FastifyContextConfig {
    auth: RoutePolicy;
  }
}
