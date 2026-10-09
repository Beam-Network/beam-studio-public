import type { FastifyInstance, FastifyRequest, RouteOptions } from "fastify";
import { isHandlerVerified, type RoutePolicy } from "./policy.js";

/**
 * Routes whose handler performs its own verification record that they did so
 * here. A success response from such a route with no entry is a bug in the
 * handler, and the kernel turns it into a 500 rather than letting it out.
 */
const settled = new WeakSet<FastifyRequest>();

/** Called by a handler-verified route once it has accepted a credential. */
export function settleRouteAuth(request: FastifyRequest) {
  settled.add(request);
}

export function routeAuthSettled(request: FastifyRequest) {
  return settled.has(request);
}

export function routePolicy(request: FastifyRequest): RoutePolicy | undefined {
  return request.routeOptions.config?.auth;
}

function methodsOf(route: RouteOptions) {
  return Array.isArray(route.method) ? route.method : [route.method];
}

export type AuthKernelOptions = {
  /** Verifies the policies the kernel owns. Throws to deny. */
  verify: (policy: RoutePolicy, request: FastifyRequest) => Promise<void>;
  onDenied?: (details: {
    route: string;
    method: string;
    policy: RoutePolicy["kind"];
    code: string;
  }) => void;
  onMisconfigured?: (details: { route: string; method: string }) => void;
};

/**
 * Deny-by-default authentication.
 *
 * Authentication used to be selected by matching the route path against
 * `/studio/`, so every route registered outside that prefix was unauthenticated
 * unless its author independently added a check. Whether one had been added was
 * not visible to the build, the tests, or a reviewer reading the registration.
 *
 * Now the route declares its policy at registration and this decides. A route
 * with no policy cannot be registered, so the failure mode is a server that
 * refuses to start rather than an endpoint that quietly answers anybody.
 */
export function registerAuthKernel(
  server: FastifyInstance,
  options: AuthKernelOptions,
) {
  const policies = new Map<string, RoutePolicy>();

  // Fastify runs onRoute synchronously inside the server.get(...) call, so a
  // throw here aborts startup at the offending registration rather than
  // surfacing later as a request-time surprise.
  server.addHook("onRoute", (route) => {
    const policy = route.config?.auth;
    if (!policy) {
      throw new Error(
        `Route ${methodsOf(route).join("|")} ${route.url} declares no auth policy. ` +
          "Add { config: { auth: auth.<policy>() } } to its registration.",
      );
    }
    for (const method of methodsOf(route)) {
      policies.set(`${method} ${route.url}`, policy);
    }
  });

  server.decorate("authPolicies", policies as ReadonlyMap<string, RoutePolicy>);

  server.addHook("preHandler", async (request, reply) => {
    // An unmatched request has no route and belongs to the notFound handler.
    if (!request.routeOptions.url) return;

    const policy = routePolicy(request);
    if (!policy) {
      // Unreachable while onRoute is in place. Treated as a fault rather than
      // an allow, so that losing the hook can never mean losing the guard.
      options.onMisconfigured?.({
        route: request.routeOptions.url,
        method: request.method,
      });
      return reply.code(500).send({
        code: "auth_policy_missing",
        error: "Internal server error",
        statusCode: 500,
      });
    }

    reply.header("Cache-Control", "no-store");
    if (policy.kind === "public" || isHandlerVerified(policy)) return;

    try {
      await options.verify(policy, request);
    } catch (error) {
      const statusCode = Number(
        (error as { statusCode?: number }).statusCode ?? 401,
      );
      const code = String((error as { code?: string }).code ?? "unauthorized");
      options.onDenied?.({
        route: request.routeOptions.url,
        method: request.method,
        policy: policy.kind,
        code,
      });
      throw error;
    }
  });

  // The proof obligation for handler-verified routes.
  server.addHook("onSend", async (request, reply, payload) => {
    const policy = routePolicy(request);
    if (!policy || !isHandlerVerified(policy)) return payload;
    if (reply.statusCode >= 400 || settled.has(request)) return payload;

    options.onMisconfigured?.({
      route: request.routeOptions.url ?? "unmatched",
      method: request.method,
    });
    reply.code(500);
    reply.header("content-type", "application/json; charset=utf-8");
    return JSON.stringify({
      code: "auth_unsettled",
      error: "Internal server error",
      statusCode: 500,
    });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    authPolicies: ReadonlyMap<string, RoutePolicy>;
  }
}
