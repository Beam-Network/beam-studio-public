import type http from "node:http";
import {
  isLoopbackRemoteAddress,
  opsAuthorized,
} from "@beam-studio/shared/ops-auth";
import { hostAllowed, listenHost } from "@beam-studio/shared";
import { RoomMemberActionAssignments } from "./agent-control/action-assignments.js";
import { RoomMemberAssignmentLifecycle } from "./agent-control/action-assignment-lifecycle.js";
import { registerRoomMemberActionHost } from "./agent-control/action-host.js";
import { reconcileRoomWorkflowCancellations } from "./agent-control/workflow-cancellation.js";
import { registerWorkflowMcp } from "./studio/workflow-mcp.js";
import { registerRoomWorkflowRoutes } from "./agent-control/workflow-routes.js";
import { registerWorkflowExecutionAuthorizationRoutes } from "./studio/execution-authorization.js";
import Fastify from "fastify";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  checkPostgres,
  isPostgresUnavailableError,
  pgOne,
  WorkflowAuthorizationError,
  type LiveServiceConfig,
  type PgPool,
} from "@beam-studio/db";
import { derivedSecrets } from "@beam-studio/vault";
import {
  Telemetry,
  formatTraceparent,
  parseTraceparent,
  redactTelemetryValue,
  type TraceContext,
} from "@beam-studio/telemetry";
import {
  ApiLogController,
  createApiLogger,
  logCompletedRequest,
  type ApiLogger,
} from "./logging.js";
import { studioContracts } from "./studio/contracts.js";
import { registerStudioRoutes } from "./studio/routes.js";
import { startWorkflowRunPg } from "./studio/workflow-runs.js";
import { StudioSessionManager } from "./auth/session-manager.js";
import {
  registerStudioAuthKernel,
  studioRequestOrganizationId,
  studioRequestSession,
} from "./auth/request-context.js";
import { settleRouteAuth } from "./auth/kernel.js";
import { auth } from "./auth/policy.js";
import {
  createOrganizationAuthority,
  type OrganizationAuthority,
} from "./auth/organization-authority.js";
import {
  createInstanceAdmission,
  machineCallerAdmission,
  type InstanceAdmission,
} from "./auth/instance-admission.js";
import { createCreditClient } from "./billing/credit-client.js";
import { organizationBeamApiKey } from "./studio/store.js";
import { AgentControlRepository } from "./agent-control/repository.js";
import { AgentGateway } from "./agent-control/gateway.js";
import { RoomActionController } from "./agent-control/room-action-controller.js";
import { parseWebAgentControllerBindings } from "./agent-control/web-agent-controller-config.js";
import { registerV3RoomResolutionRoutes } from "./agent-control/v3-room-resolution.js";
import { registerAgentControlRoutes } from "./agent-control/routes.js";
import { RoomStorageTransferManager } from "./agent-control/room-storage-transfer-manager.js";
import {
  assertRoomArtifactOperationAuthorized,
  frozenArtifactPublications,
} from "./agent-control/room-artifact-authorization.js";
import { isAllowedStudioOrigin } from "./cors-policy.js";
import { registerFixtureRotationRoutes } from "./internal/fixture-campaigns.js";
import {
  closeOps,
  listenOps,
  registerOpsListenerGuard,
  studioOpsConfig,
} from "./internal/ops-listener.js";
import {
  registerStudioOpsRoutes,
  type StudioOpsRouteOptions,
} from "./internal/ops-routes.js";
import { registerUpdateRoutes } from "./updates/routes.js";
import type { UpdateMode } from "./updates/update-policy.js";
import type { UpdaterClient } from "./updates/updater-client.js";

type StartWorkflowRunBody = {
  input?: unknown;
};

const defaultLogger = createApiLogger();

export async function buildServer(options: {
  pgPool: PgPool;
  telemetry?: Telemetry;
  logger?: ApiLogger;
  sessions?: StudioSessionManager;
  /** Injected by tests; otherwise built from the credit client below. */
  authority?: OrganizationAuthority;
  /** Injected by tests; otherwise reads this deployment's own admission rows. */
  admission?: InstanceAdmission;
  updates?: { mode?: UpdateMode; updater?: UpdaterClient };
  ops?: StudioOpsRouteOptions;
}) {
  const telemetry = options.telemetry ?? new Telemetry("api");
  const logger = options.logger ?? defaultLogger;
  const requestSpans = new WeakMap<
    object,
    {
      startedAt: number;
      span: ReturnType<Telemetry["startSpan"]>;
    }
  >();
  const server = Fastify({
    // request.log and server.log write through the service logger, so its
    // level (LOG_LEVEL) and redaction apply to them too. Typed as the base
    // logger so this stays the plain FastifyInstance every route module takes.
    loggerInstance: logger as FastifyBaseLogger,
    // One line per request, written by the onResponse hook below.
    logController: new ApiLogController(),
  });
  const responseCodes = new WeakMap<object, string>();
  const sessions = options.sessions ?? new StudioSessionManager();
  // Registered before any route: onRoute only sees routes added after the hook,
  // so anything registered above this line would be invisible to the kernel.
  // Beam is asked whether the organization a machine token names is still
  // active. The only credential Studio holds that speaks for an organization
  // without a signed-in user is that organization's own stored Beam API key,
  // and /api/keys/verify is what Studio already uses to check one.
  const credits = createCreditClient();
  const organizationAuthority =
    options.authority ??
    createOrganizationAuthority({
      resolveKey: (organizationId) => organizationBeamApiKey(organizationId),
      verifyKey: async (apiKey) => {
        try {
          await credits.resolveKeyId(apiKey);
          return "valid";
        } catch (error) {
          return (error as { code?: string }).code === "invalid_key"
            ? "rejected"
            : "unavailable";
        }
      },
    });

  // Whether this deployment serves an organization at all, as opposed to
  // whether the organization belongs to the caller. Reads Studio's own rows.
  const instanceAdmission =
    options.admission ??
    createInstanceAdmission({
      pool: options.pgPool,
      consumerOrganizationId:
        process.env.BEAM_STUDIO_CONSUMER_ORGANIZATION_ID?.trim() ?? null,
    });

  registerStudioAuthKernel(server, sessions, {
    pool: options.pgPool,
    authority: organizationAuthority,
    admission: instanceAdmission,
    // A caller outside the admitted organizations is refused 403 with a
    // stable code (instance_organization_forbidden, instance_join_pending,
    // ...), and that refusal is already the one "request completed" warning.
    // The admission detail (organization, join policy, plane) and the policy
    // detail only matter when debugging.
    onAdmission: (details) =>
      logger.debug(
        details,
        "Caller is outside this deployment's admitted organizations",
      ),
    onDenied: (details) => logger.debug(details, "Auth kernel denied request"),
    onMisconfigured: (details) =>
      logger.fatal(details, "Route answered without an auth decision"),
  });
  registerFixtureRotationRoutes(server, options.pgPool);

  server.setErrorHandler((error, request, reply) => {
    const apiError =
      error instanceof Error
        ? error
        : new Error(String(error ?? "Unknown error"));
    const statusCodeValue = (error as { statusCode?: unknown }).statusCode;
    const explicitStatus =
      typeof statusCodeValue === "number" && statusCodeValue >= 400;
    // PostgreSQL restarting or unreachable is not a bug in the request: it is
    // answered 503 and marked retryable, and the pool reconnects on its own.
    const databaseUnavailable =
      !explicitStatus && isPostgresUnavailableError(error);
    const statusCode = explicitStatus
      ? (statusCodeValue as number)
      : databaseUnavailable
        ? 503
        : 500;

    // An expected refusal (4xx) is logged once, as the "request completed"
    // warning with its code. Only a failure (5xx, including any error without
    // a status) gets this extra line with the error message.
    if (statusCode >= 500) {
      request.log.error(
        {
          error: redactTelemetryValue(apiError.message, "error"),
          method: request.method,
          route: request.routeOptions.url ?? "unmatched",
          statusCode,
          correlationId: requestSpans.get(request)?.span.context.correlationId,
          traceId: requestSpans.get(request)?.span.context.traceId,
        },
        "API request failed",
      );
    }

    if (databaseUnavailable) {
      return reply.code(503).send({
        code: "database_unavailable",
        correlationId:
          requestSpans.get(request)?.span.context.correlationId ?? request.id,
        error: "The Studio database is unavailable. Retry shortly.",
        retryable: true,
        statusCode: 503,
      });
    }

    return reply.code(statusCode).send({
      code: errorCode(error, statusCode),
      correlationId:
        requestSpans.get(request)?.span.context.correlationId ?? request.id,
      details: errorDetails(error),
      error:
        statusCode >= 500 && (error as { expose?: unknown }).expose !== true
          ? "Internal server error"
          : apiError.message,
      action: errorAction(error),
      retryable: errorRetryable(error),
      statusCode,
    });
  });

  server.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: "not_found",
      correlationId:
        requestSpans.get(request)?.span.context.correlationId ?? request.id,
      error: "Not found",
      statusCode: 404,
    }),
  );

  // DNS rebinding needs a name whose DNS answer can be flipped to a private
  // address; the victim's browser then sends that name as Host. Binding
  // loopback does not prevent it — validating Host does. Loopback names and IP
  // literals are always accepted, so an install reached by IP needs no
  // configuration.
  server.addHook("onRequest", async (request, reply) => {
    if (!hostAllowed(request.headers.host)) {
      return reply.code(421).send({
        code: "host_not_allowed",
        error: "Misdirected Request",
        statusCode: 421,
      });
    }
  });

  server.addHook("onRequest", async (request, reply) => {
    const correlationId =
      correlationHeader(request.headers["x-correlation-id"]) ?? request.id;
    const traceparent = Array.isArray(request.headers.traceparent)
      ? request.headers.traceparent[0]
      : request.headers.traceparent;
    const parent = parseTraceparent(traceparent, correlationId);
    const span = telemetry.startSpan("api.request", {
      parent,
      correlationId,
      attributes: { "http.request.method": request.method },
    });
    requestSpans.set(request, { startedAt: Date.now(), span });
    reply.header("X-Correlation-Id", correlationId);
    reply.header("traceparent", formatTraceparent(span.context));
    applyCorsHeaders(
      request.headers.origin,
      reply,
      request.headers["access-control-request-private-network"] === "true",
    );

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  // After the hook above, so an Ops route refused on the wrong listener gets
  // the same correlation, trace and CORS headers as a route that is missing.
  registerOpsListenerGuard(server);
  registerStudioOpsRoutes(
    server,
    options.pgPool,
    options.ops ?? { ops: studioOpsConfig() },
  );

  server.addHook("onResponse", async (request, reply) => {
    const active = requestSpans.get(request);
    if (!active) return;
    const route = boundedRoute(request.routeOptions.url);
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
    const labels = {
      method: request.method.toLowerCase(),
      route,
      status_class: statusClass,
    };
    telemetry.add("beam_api_requests_total", 1, labels);
    telemetry.observe(
      "beam_api_request_duration_seconds",
      Math.max(0, Date.now() - active.startedAt) / 1_000,
      labels,
    );
    active.span.end(reply.statusCode >= 500 ? "error" : "ok", {
      "http.route": route,
      "http.response.status_code": reply.statusCode,
    });
    logCompletedRequest(request, reply, {
      durationMs: Date.now() - active.startedAt,
      correlationId: active.span.context.correlationId,
      code: responseCodes.get(request),
    });
  });

  server.addHook("preSerialization", async (request, reply, payload) => {
    if (reply.statusCode < 400 || !isPlainObject(payload)) {
      return payload;
    }
    const code =
      typeof payload.code === "string"
        ? payload.code
        : reply.statusCode === 404
          ? "not_found"
          : "request_error";
    // Kept for the completion log line, so a refusal such as a 409
    // room_consumer_unavailable says why without logging the body.
    responseCodes.set(request, code);
    return {
      code,
      correlationId:
        typeof payload.correlationId === "string"
          ? payload.correlationId
          : (requestSpans.get(request)?.span.context.correlationId ??
            request.id),
      error:
        typeof payload.error === "string" ? payload.error : "Request failed",
      ...(isPlainObject(payload.details) ? { details: payload.details } : {}),
      ...(typeof payload.action === "string" ? { action: payload.action } : {}),
      ...(typeof payload.retryable === "boolean"
        ? { retryable: payload.retryable }
        : {}),
      statusCode:
        typeof payload.statusCode === "number"
          ? payload.statusCode
          : reply.statusCode,
    };
  });

  // Health of the API as a whole: telemetry and PostgreSQL. Every Studio
  // route needs the database, so while it is down the probe answers 503 with
  // `checks.database: "unavailable"`, and 200 again once it is back, like the
  // worker's /health. The compose healthcheck only marks the container
  // unhealthy: `restart: unless-stopped` restarts on exit, not on health, so a
  // database outage does not become an API restart loop.
  const sendHealth = async (
    request: FastifyRequest,
    reply: FastifyReply,
    fields: Record<string, unknown>,
  ) => {
    const [telemetryCheck, databaseCheck] = await Promise.allSettled([
      telemetry.check(),
      checkPostgres(options.pgPool),
    ]);
    const checks = {
      telemetry: telemetryCheck.status === "fulfilled" ? "ok" : "unavailable",
      database: databaseCheck.status === "fulfilled" ? "ok" : "unavailable",
    };
    if (checks.telemetry === "ok" && checks.database === "ok") {
      return { ok: true, ...fields, checks };
    }
    const code =
      checks.database === "ok" ? "service_unavailable" : "database_unavailable";
    responseCodes.set(request, code);
    // Serialized here so the error envelope hook keeps `checks`, which is what
    // tells an operator which dependency is down.
    return reply
      .code(503)
      .type("application/json; charset=utf-8")
      .send(
        JSON.stringify({
          ok: false,
          ...fields,
          checks,
          code,
          error:
            code === "database_unavailable"
              ? "The Studio database is unavailable."
              : "Telemetry is unavailable.",
          statusCode: 503,
        }),
      );
  };

  server.get(
    "/health",
    { config: { auth: auth.public("liveness; no tenant data") } },
    (request, reply) =>
      sendHealth(request, reply, { service: "beam-studio-api" }),
  );

  server.get(
    "/metrics",
    {
      config: { auth: auth.serviceSecret("BEAM_STUDIO_OPS_TOKEN") },
    },
    async (request, reply) => {
      // Operational data: per-route request counts, status classes and
      // workflow run totals. Reachable from inside the container so a scrape
      // sidecar and the healthcheck path keep working; otherwise it takes the
      // deployment's ops token.
      if (
        !isLoopbackRemoteAddress(request.socket.remoteAddress) &&
        !opsAuthorized(request.headers.authorization)
      ) {
        return reply.code(401).send({
          code: "ops_authentication_required",
          error: "Unauthorized",
          statusCode: 401,
        });
      }
      settleRouteAuth(request);
      try {
        const metrics = await telemetry.exportMetrics();
        reply.header(
          "Content-Type",
          "text/plain; version=0.0.4; charset=utf-8",
        );
        return metrics;
      } catch (error) {
        logger.warn(
          {
            error: redactTelemetryValue(
              error instanceof Error ? error.message : String(error),
            ),
          },
          "API telemetry exporter unavailable",
        );
        return reply.code(503).type("text/plain").send("metrics unavailable\n");
      }
    },
  );

  server.get(
    "/studio/health",
    { config: { auth: auth.public("liveness") } },
    (request, reply) =>
      sendHealth(request, reply, {
        service: "beam-studio-api",
        boundary: "studio-api",
      }),
  );

  server.get(
    "/studio/contracts",
    { config: { auth: auth.public("static client/server contract shapes") } },
    async () => studioContracts(),
  );

  server.post<{
    Params: { id: string };
    Body: StartWorkflowRunBody;
  }>(
    "/workflows/:id/runs",
    { config: { auth: auth.write({ machine: ["run:workflows"] }) } },
    async (request, reply) => {
      const requestSpan = requestSpans.get(request)?.span;
      const workflowSpan = telemetry.startSpan("workflow.run.queue", {
        parent: requestSpan?.context,
        correlationId: requestSpan?.context.correlationId,
        attributes: { "workflow.trigger": "api" },
      });
      // Enqueue the durable billing intent together with the root run.
      const template = await options.pgPool.query(
        "SELECT api_key_id, organization_id FROM workflow.templates WHERE id = $1 AND organization_id = $2",
        [request.params.id, studioRequestOrganizationId(request)],
      );
      if (!template.rows[0]) {
        workflowSpan.end("error");
        return reply.code(404).send({ error: "Workflow not found" });
      }
      try {
        const workflowRunId = await startWorkflowRunPg(
          options.pgPool,
          request.params.id,
          objectValue(request.body.input),
          {
            traceContext: workflowSpan.context,
            organizationId: studioRequestOrganizationId(request) ?? undefined,
            initiatingPrincipalId:
              studioRequestSession(request)?.userId ?? null,
          },
        );
        workflowSpan.context.correlationId = workflowRunId;
        if (requestSpan) {
          requestSpan.context.correlationId = workflowRunId;
          requestSpan.setAttribute("workflow.run_id", workflowRunId);
        }
        workflowSpan.setAttribute("workflow.run_id", workflowRunId);
        workflowSpan.end();
        telemetry.add("beam_workflow_runs_total", 1, {
          service: "api",
          trigger: "api",
          status: "queued",
        });
        reply.header("X-Correlation-Id", workflowRunId);
        reply.header("traceparent", formatTraceparent(workflowSpan.context));
        return reply
          .code(202)
          .send({ workflowRunId, correlationId: workflowRunId });
      } catch (error) {
        workflowSpan.end("error", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  const agentRepository = new AgentControlRepository(
    options.pgPool,
    agentControlTokenSecrets(),
    undefined,
    // Enrollment and token refresh follow the machine-caller rule: an open
    // join policy does not admit an agent, a recorded admission does.
    machineCallerAdmission(instanceAdmission),
  );
  const agentGateway = new AgentGateway(agentRepository, logger);
  const roomActionController = new RoomActionController(
    options.pgPool,
    agentRepository,
    parseWebAgentControllerBindings(),
    logger,
  );
  registerV3RoomResolutionRoutes(server, options.pgPool, roomActionController);
  const roomStorageTransfers = new RoomStorageTransferManager(
    options.pgPool,
    agentRepository,
    agentGateway,
    logger,
  );
  agentGateway.setRoomStorageRequestHandler((agentId, request) =>
    roomStorageTransfers.handleAgentRequest(agentId, request),
  );
  roomStorageTransfers.registerRoutes(server);
  const memberAssignments = new RoomMemberActionAssignments(
    options.pgPool,
    agentRepository,
    agentGateway,
    undefined,
    roomActionController,
  );
  roomStorageTransfers.setArtifactCopyAuthorization(async (job, locator) => {
    const capability = await pgOne<{ authorization_token: string }>(
      options.pgPool,
      "SELECT authorization_token FROM execution.executor_assignment_capabilities WHERE assignment_id=$1",
      [locator.assignmentId],
    );
    if (!capability)
      throw new WorkflowAuthorizationError("executor_capability_invalid");
    const context = await memberAssignments.authorizeAssignment(
      locator.assignmentId,
      `Bearer ${capability.authorization_token}`,
    );
    const plan = frozenArtifactPublications(context.task.metadata_json)[
      locator.port
    ];
    if (
      context.assignment.id !== locator.assignmentId ||
      Number(context.assignment.attempt) !== locator.attempt ||
      context.run.id !== job.workflowRunId ||
      context.stepRun.id !== job.workflowStepRunId ||
      context.room?.roomId !== job.roomId ||
      context.assignment.member_id !== job.sourceMemberId ||
      !plan ||
      plan.availability !== "durable" ||
      plan.roomId !== job.roomId ||
      plan.channelId !== job.channelId ||
      plan.sourceMemberId !== job.sourceMemberId ||
      plan.requiredUntil !== locator.requiredUntil ||
      `${plan.retentionObligationId}:${locator.index}` !==
        locator.retentionObligationId ||
      JSON.stringify(plan.targetMemberIds) !==
        JSON.stringify(job.targetMemberIds) ||
      Date.parse(plan.requiredUntil) <= Date.now()
    )
      throw new WorkflowAuthorizationError(
        "executor_artifact_publication_unplanned",
      );
    assertRoomArtifactOperationAuthorized(context.roomSnapshot!, job.roomId, {
      kind: "output.copy",
      location: {
        roomId: job.roomId,
        channelId: job.channelId,
        sourceMemberId: job.sourceMemberId,
        recipientMemberIds: job.targetMemberIds,
      },
    });
  });
  const memberLifecycle = new RoomMemberAssignmentLifecycle(
    options.pgPool,
    memberAssignments,
    agentRepository,
    agentGateway,
    async (assignment, capability) => {
      const response = await server.inject({
        method: "POST",
        url: `/api/internal/executor-assignments/${encodeURIComponent(assignment.id)}/host`,
        headers: { authorization: `Bearer ${capability}` },
        payload: { method: "beam.rooms.cancel", args: [] },
      });
      if (response.statusCode !== 200)
        throw new Error("Room resource cleanup is still unconfirmed.");
    },
    roomStorageTransfers,
    roomActionController,
  );
  memberAssignments.registerRoutes(server);
  registerRoomMemberActionHost(
    server,
    options.pgPool,
    memberAssignments,
    roomStorageTransfers,
  );
  roomStorageTransfers.start();
  let reconcilingMemberAssignments = false;
  const memberTimer = setInterval(async () => {
    if (reconcilingMemberAssignments) return;
    reconcilingMemberAssignments = true;
    try {
      try {
        await roomActionController.tick();
      } catch (error) {
        logger.warn(
          {
            code:
              (error as { code?: string }).code ?? "room_action_tick_failed",
          },
          "Protected room action reconciliation failed",
        );
      }
      await memberLifecycle.tick();
    } catch (error) {
      logger.warn({ error }, "Room-member assignment reconciliation failed");
    } finally {
      reconcilingMemberAssignments = false;
    }
  }, 2000);
  memberTimer.unref();
  let reconcilingRoomCancellations = false;
  const roomCancellationTimer = setInterval(async () => {
    if (reconcilingRoomCancellations) return;
    reconcilingRoomCancellations = true;
    try {
      await reconcileRoomWorkflowCancellations(
        options.pgPool,
        agentRepository,
        agentGateway,
        roomStorageTransfers,
      );
    } catch (error) {
      logger.warn({ error }, "Room cancellation reconciliation failed");
    } finally {
      reconcilingRoomCancellations = false;
    }
  }, 5000);
  roomCancellationTimer.unref();
  server.addHook("onClose", async () => {
    clearInterval(roomCancellationTimer);
    clearInterval(memberTimer);
    roomStorageTransfers.stop();
    await roomActionController.close();
    await agentGateway.close();
    sessions.shutdown();
  });
  registerRoomWorkflowRoutes(
    server,
    options.pgPool,
    agentRepository,
    agentGateway,
    roomStorageTransfers,
  );
  registerWorkflowExecutionAuthorizationRoutes(server, options.pgPool);
  registerWorkflowMcp(server, options.pgPool, agentRepository);
  await registerAgentControlRoutes(server, {
    repository: agentRepository,
    gateway: agentGateway,
    // The room consumer enrolls for the instance owner unless
    // BEAM_STUDIO_CONSUMER_ORGANIZATION_ID names an organization.
    instance: () => instanceAdmission.instance(),
  });
  await registerStudioRoutes(server, {
    pgPool: options.pgPool,
    sessions,
    admission: instanceAdmission,
  });
  registerUpdateRoutes(server, options.updates);

  return server;
}

/**
 * Agent token signing secrets, active first.
 *
 * Derived rather than defaulted: there is no value this can fall back to that
 * is both usable and secret. `vaultSecretFromEnv` throws when the vault key is
 * absent or a published placeholder. Retired keys stay in the list so a
 * rotation does not disconnect every agent until the old key is dropped; an
 * explicitly configured secret has no keyring and so has no retired entries.
 */
function agentControlTokenSecrets() {
  const configured = process.env.BEAM_STUDIO_AGENT_TOKEN_SECRET?.trim();
  if (configured) return [configured];
  return derivedSecrets("beam-studio.agent-control.v1");
}

export async function startServer(
  port: number,
  options: {
    pgPool: PgPool;
    telemetry?: Telemetry;
    logger?: ApiLogger;
    sessions?: StudioSessionManager;
    liveConfig?: LiveServiceConfig;
  },
) {
  const logger = options.logger ?? defaultLogger;
  const ops = studioOpsConfig(process.env, port);
  if (ops.problem) logger.error({ code: "studio_ops_disabled" }, ops.problem);
  const server = await buildServer({
    ...options,
    ops: { ops, liveConfig: options.liveConfig ?? null },
  });
  const host = listenHost("API_BIND_HOST");
  let opsServer: http.Server | null = null;
  server.addHook("onClose", async () => {
    await closeOps(opsServer);
  });
  await server.listen({ port, host });
  // Only a configured secret opens the ops port: without one the routes are
  // disabled anyway, and an install that never uses them binds nothing extra.
  // A failure here is logged, not fatal: Studio serves everything else.
  if (ops.secret) {
    try {
      opsServer = await listenOps(server, ops.port, host);
      logger.info({ port: ops.port }, "Ops API listening");
    } catch (error) {
      logger.error(
        { code: "studio_ops_listen_failed", port: ops.port, err: error },
        "Could not open the Ops API port; the Ops API stays disabled",
      );
    }
  }
  return server;
}

export async function stopServer(server: FastifyInstance) {
  await server.close();
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function applyCorsHeaders(
  origin: string | undefined,
  reply: {
    header(name: string, value: string): unknown;
  },
  privateNetworkRequested = false,
) {
  if (isAllowedStudioOrigin(origin)) {
    reply.header("Access-Control-Allow-Origin", origin as string);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Vary", "Origin");
    // Only answer a private-network preflight that actually asked for one.
    if (privateNetworkRequested) {
      reply.header("Access-Control-Allow-Private-Network", "true");
    }
  }

  reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  reply.header(
    "Access-Control-Allow-Headers",
    `${
      process.env.STUDIO_CORS_ALLOWED_HEADERS ??
      "Content-Type,Authorization,X-Correlation-Id,X-Beam-Environment,X-Beam-Environment-Template,X-Organization-Id,X-Project-Id,traceparent"
    },If-None-Match`,
  );
  reply.header(
    "Access-Control-Expose-Headers",
    "X-Correlation-Id,traceparent,ETag",
  );
  reply.header("Access-Control-Max-Age", "86400");
}

function correlationHeader(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[a-zA-Z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : null;
}

function boundedRoute(value: string | undefined) {
  if (!value) return "unmatched";
  return value.length <= 120 ? value : "other";
}

function errorCode(error: unknown, statusCode: number) {
  const explicit = (error as { code?: unknown })?.code;
  if (typeof explicit === "string" && explicit) {
    return explicit;
  }
  return statusCode >= 500 ? "internal_error" : "request_error";
}

function errorDetails(error: unknown) {
  const details = (error as { details?: unknown })?.details;
  return isPlainObject(details) ? details : undefined;
}

function errorAction(error: unknown) {
  const action = (error as { action?: unknown })?.action;
  return typeof action === "string" && action ? action : undefined;
}

function errorRetryable(error: unknown) {
  const retryable = (error as { retryable?: unknown })?.retryable;
  return typeof retryable === "boolean" ? retryable : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
