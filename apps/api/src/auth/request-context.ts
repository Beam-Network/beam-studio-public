import type { FastifyInstance, FastifyRequest } from "fastify";
import { STUDIO_SESSION_COOKIE } from "./browser-session.js";
import { registerAuthKernel, type AuthKernelOptions } from "./kernel.js";
import type { OrganizationAuthority } from "./organization-authority.js";
import {
  admitsMachineCaller,
  type InstanceAdmission,
} from "./instance-admission.js";
import type { RoutePolicy } from "./policy.js";
import { pgOne, type PgPool } from "@beam-studio/db";
import { type McpScope, parseMcpScopes } from "@beam-studio/shared";
import { hashMcpToken } from "../studio/repositories/record-helpers.js";
import { studioSessionFromMe, type StudioSession } from "./session.js";
import {
  studioCookie,
  type StudioSessionManager,
  type StudioSessionServices,
} from "./session-manager.js";

type Organization = {
  id: string;
  role?: string | null;
  restrictionStatus?: string | null;
};
/**
 * A signed-in browser. Carries OAuth services, so a handler can call Beam on
 * the user's behalf.
 */
type UserContext = {
  kind: "user";
  services: StudioSessionServices;
  session: StudioSession;
  organizationId: string | null;
  projectId: string | null;
};

/**
 * A machine holding a scoped token. It has no OAuth services and never will:
 * nobody is signed in, so there is no Beam session to delegate. A route whose
 * handler needs one therefore cannot accept a token, which is why `machine`
 * is opt-in per route rather than a blanket grant.
 */
type MachineContext = {
  kind: "machine";
  tokenId: string;
  scopes: readonly McpScope[];
  organizationId: string | null;
  projectId: string | null;
};

type Context = UserContext | MachineContext;
type SessionPolicy = Extract<RoutePolicy, { kind: "session" }>;

const contexts = new WeakMap<FastifyRequest, Context>();

/**
 * Installs the auth kernel with the Studio session verifier. Must be called
 * before any route is registered: the kernel's `onRoute` hook only sees routes
 * added after it, and a route it never sees is a route with no declared policy.
 */
export function registerStudioAuthKernel(
  server: FastifyInstance,
  sessions: StudioSessionManager,
  hooks: Omit<AuthKernelOptions, "verify"> & {
    pool?: PgPool;
    authority?: OrganizationAuthority;
    admission?: InstanceAdmission;
    /**
     * Reports a caller this deployment does not admit. Enforcement lands in a
     * later change; until then the count is how we learn which planes a
     * deny-by-default switch would actually break.
     */
    onAdmission?: (details: Record<string, unknown>) => void;
  } = {},
) {
  const { pool, authority, admission, onAdmission, ...rest } = hooks;
  registerAuthKernel(server, {
    ...rest,
    verify: async (policy, request) => {
      if (policy.kind === "session") {
        await verifyStudioSession(policy, request, sessions, pool, authority, {
          admission,
          onAdmission,
        });
      }
    },
  });
}

/**
 * Establishes the Studio request context for a session-authenticated route.
 *
 * This used to run as a hook that decided whether to authenticate by testing
 * the route path against the `/studio/` prefix, which left everything outside
 * that prefix unauthenticated by default. The work it does is unchanged; what
 * changed is that the auth kernel decides when it runs, from the policy the
 * route declares, so a route cannot opt out by being named something else.
 */
function bearerToken(header: unknown) {
  const value = Array.isArray(header) ? header[0] : header;
  const presented = String(value ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  return presented.startsWith("beam_mcp_") ? presented : null;
}

/**
 * Authenticates a scoped machine token, for routes that opt into one.
 *
 * The organization comes from the token rather than a header, so a token
 * cannot be pointed at another tenant by changing a request. The scopes it
 * was issued with have to cover what the route asked for.
 */
async function verifyMachineToken(
  policy: SessionPolicy,
  request: FastifyRequest,
  token: string,
  pool: PgPool,
  authority?: OrganizationAuthority,
  admission?: InstanceAdmission,
) {
  const row = await pgOne<{
    id: string;
    organization_id: string;
    project_id: string | null;
    scopes_json: unknown;
  }>(
    pool,
    `SELECT id, organization_id, project_id, scopes_json
       FROM mcp.tokens
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [hashMcpToken(token)],
  );
  if (!row) throw denied("machine_token_invalid", 401);

  const granted = parseMcpScopes(JSON.stringify(row.scopes_json));
  const required = policy.machine ?? [];
  const missing = required.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    throw denied(`machine_scope_required:${missing.join(",")}`);
  }

  // Beam is the authority on whether the organization still exists and is
  // active. "unverified" is not a refusal: Studio may hold no key for it, or
  // Beam may be unreachable, and the token's own expiry and revocation remain
  // the primary control.
  const organizationId = String(row.organization_id);
  if ((await authority?.check(organizationId)) === "revoked") {
    throw denied("machine_token_organization_revoked", 403);
  }

  // Whether this deployment still serves the organization the token names.
  // Two deliberate differences from the Beam check directly above:
  //
  // "unverified" is tolerated there because Beam may be unreachable; here the
  // answer comes from this deployment's own rows, so absent means refuse.
  //
  // An open join policy must not admit on this path. A machine token proves
  // nothing about current Beam membership, so letting one admit its own
  // organization would let a token for an organization that has since been
  // removed quietly re-admit it. Admission is a browser-session decision.
  if (admission) {
    // The same rule the MCP server applies (admitsMachineCaller).
    if (!admitsMachineCaller(await admission.check(organizationId))) {
      throw denied("instance_organization_forbidden");
    }
  }

  contexts.set(request, {
    kind: "machine",
    tokenId: String(row.id),
    scopes: granted,
    organizationId,
    projectId: row.project_id ? String(row.project_id) : null,
  });
}

export async function verifyStudioSession(
  policy: SessionPolicy,
  request: FastifyRequest,
  sessions: StudioSessionManager,
  pool?: PgPool,
  authority?: OrganizationAuthority,
  instance?: {
    admission?: InstanceAdmission;
    onAdmission?: (details: Record<string, unknown>) => void;
  },
) {
  const token = policy.machine
    ? bearerToken(request.headers.authorization)
    : null;
  if (token) {
    if (!pool) throw denied("machine_token_unavailable", 503);
    return verifyMachineToken(
      policy,
      request,
      token,
      pool,
      authority,
      instance?.admission,
    );
  }

  const services = sessions.get(
    studioCookie(request.headers.cookie, STUDIO_SESSION_COOKIE),
  );
  const authenticated = services && (await services.oauth.hasSession());

  let context: Context;
  if (authenticated) {
    let session: StudioSession | null;
    try {
      session = studioSessionFromMe(await services.beamApi.getJson("/api/me"));
    } catch (error) {
      // The session probe reports an unusable upstream session as "signed out"
      // rather than failing the request.
      if (
        policy.anonymous === "probe" &&
        (error as { statusCode?: number }).statusCode === 401
      ) {
        return;
      }
      throw error;
    }
    if (!session) throw denied("invalid_profile", 502);
    context = {
      kind: "user",
      services,
      session,
      organizationId: null,
      projectId: null,
    };
  } else {
    if (policy.anonymous === "probe") return;
    throw denied("studio_session_required", 401);
  }

  contexts.set(request, context);

  const body = (request.body ?? {}) as Record<string, unknown>;
  context.organizationId =
    policy.organizationFrom === "body"
      ? value(body.organizationId)
      : requestedOrganizationId(request);
  context.projectId =
    policy.projectFrom === "body"
      ? value(body.projectId)
      : requestedProjectId(request);

  // What this deployment requires, as opposed to what the caller can prove.
  // The claim funnel is exempt: an unclaimed Studio has to stay claimable, and
  // a caller it refuses has to be able to find out why.
  const instancePolicy = policy.instance ?? "required";
  const admission =
    instancePolicy === "claimFunnel" ? undefined : instance?.admission;

  if (admission) {
    // Checked before the organization early-return: an account-level route is
    // still an action on this installation, and an unclaimed one serves nobody.
    const snapshot = await admission.instance();
    if (snapshot.state === "unclaimed") {
      throw denied("instance_unclaimed");
    }
  }

  if (policy.organization === "none") return;
  if (!context.organizationId) {
    if (policy.organization === "optional") return;
    throw denied("organization_required", 400);
  }
  const payload = await context.services.beamApi.getJson<{
    organizations?: Organization[];
  }>("/api/organizations");
  const organization = payload.organizations?.find(
    (item) => item.id === context.organizationId,
  );
  if (!organization) throw denied("organization_forbidden");

  // Beam has just confirmed the organization belongs to the caller. Whether it
  // belongs to *this deployment* is the separate question nothing used to ask.
  //
  // The order matters: asking after Beam means a caller cannot make this
  // deployment record anything about an organization they have nothing to do
  // with, simply by naming it in a header.
  if (admission) {
    const verdict = await admission.check(context.organizationId);
    if (verdict.outcome !== "admitted") {
      instance?.onAdmission?.({
        organizationId: context.organizationId,
        outcome: verdict.outcome,
        joinPolicy: verdict.joinPolicy,
        plane: "session",
        method: request.method,
        route: request.routeOptions?.url ?? request.url,
        userId: context.session.userId,
      });
      if (verdict.outcome === "pending") {
        throw denied("instance_join_pending");
      }
      if (verdict.outcome === "revoked") {
        throw denied("instance_organization_revoked");
      }
      if (verdict.joinPolicy === "request") {
        await admission.requestAccess(context.organizationId, {
          userId: context.session.userId,
          email: context.session.email ?? null,
        });
        throw denied("instance_join_pending");
      }
      throw denied("instance_organization_forbidden");
    }
    if (instancePolicy === "admin" && verdict.role !== "owner") {
      throw denied("instance_admin_required");
    }
  }

  if (policy.clearsProject) {
    context.projectId = null;
    return;
  }
  if (context.projectId) {
    const projects = await context.services.beamApi.getJson<{
      projects?: Array<{ id: string }>;
    }>(
      `/api/projects?organizationId=${encodeURIComponent(context.organizationId)}`,
    );
    if (
      !projects.projects?.some((project) => project.id === context.projectId)
    ) {
      throw denied("project_forbidden");
    }
  }
  if (
    policy.mutating &&
    (organization.role === "viewer" ||
      organization.role === "read_only" ||
      organization.restrictionStatus === "restricted")
  ) {
    throw denied("organization_read_only");
  }
}

export function studioRequestSession(request: FastifyRequest) {
  const context = contexts.get(request);
  return context?.kind === "user" ? context.session : null;
}

/**
 * The caller's OAuth services, for handlers that call Beam on their behalf.
 *
 * A machine token has none — nobody is signed in — so this refuses rather
 * than inventing a session. A route reaching here with a token means its
 * policy granted machine access it cannot actually honour, which is a
 * configuration error worth failing loudly.
 */
export function studioRequestAuth(request: FastifyRequest) {
  const context = contexts.get(request);
  if (context?.kind === "machine") {
    throw denied("machine_token_cannot_delegate", 403);
  }
  if (!context?.services) throw denied("studio_session_required", 401);
  return context.services;
}

/** The scopes a machine token presented, or null for a browser session. */
export function studioRequestMachineScopes(request: FastifyRequest) {
  const context = contexts.get(request);
  return context?.kind === "machine" ? context.scopes : null;
}
export function studioRequestOrganizationId(request: FastifyRequest) {
  const context = contexts.get(request);
  if (!context) throw denied("studio_session_required", 401);
  return context.organizationId;
}
export function studioRequestProjectId(request: FastifyRequest) {
  return contexts.get(request)?.projectId ?? null;
}
function requestedOrganizationId(request: FastifyRequest) {
  return (
    value(request.headers["x-organization-id"]) ??
    studioCookie(request.headers.cookie, "beam-studio.organization-id")
  );
}
function requestedProjectId(request: FastifyRequest) {
  return (
    value(request.headers["x-project-id"]) ??
    studioCookie(request.headers.cookie, "beam-studio.project-id")
  );
}
function value(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : null;
}
function denied(code: string, statusCode = 403) {
  return Object.assign(new Error("Studio authorization failed."), {
    code,
    statusCode,
  });
}
