import {
  isLoopbackRemoteAddress,
  opsAuthorized,
} from "@beam-studio/shared/ops-auth";
import {
  beamRevision,
  hostAllowed,
  listenHost,
} from "@beam-studio/shared";
import Fastify, { LogController } from "fastify";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { LiveServiceConfig, PgPool } from "@beam-studio/db";
import { Telemetry } from "@beam-studio/telemetry";
import {
  builtinActionCatalog,
  createBuiltinActionRegistry,
} from "@beam-studio/core";
import {
  commandPublicationStatePg,
  estimateGlobalLoadPg,
  observabilitySnapshotPg,
} from "./postgresOrchestration.js";

/**
 * Every route here is an ops probe or scrape, so a line per request would be
 * noise. Only failures are logged: Fastify's error handler still writes a 5xx
 * (a failing /ready included), as do its stream and serializer errors.
 */
class FailureLogController extends LogController {
  override incomingRequest() {}
  override requestCompleted(
    error: Error | null,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (error) super.requestCompleted(error, request, reply);
  }
}

type ReportedConfig = Pick<LiveServiceConfig, "instanceId" | "status">;

export function buildServer(options: {
  pgPool: PgPool;
  taskPublisherReady?: () => boolean | Promise<boolean>;
  telemetry?: Telemetry;
  /** Service logger; without one, Fastify logging stays disabled. */
  logger?: FastifyBaseLogger;
  liveConfig?: ReportedConfig;
}) {
  const telemetry = options.telemetry ?? new Telemetry("orchestrator");
  const server = Fastify({
    loggerInstance: options.logger,
    logController: new FailureLogController(),
  });

  // Same rule as the other listeners: loopback names and IP literals are
  // always accepted, any other name must be in BEAM_STUDIO_ALLOWED_HOSTS.
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
    if (request.routeOptions.url === "/health") return;
    if (isLoopbackRemoteAddress(request.socket.remoteAddress)) return;
    if (opsAuthorized(request.headers.authorization)) return;
    return reply.code(401).send({
      code: "ops_authentication_required",
      error: "Unauthorized",
      statusCode: 401,
    });
  });

  server.get("/health", async (_request, reply) => {
    try {
      await telemetry.check();
      return {
        ok: true,
        service: "beam-studio-orchestrator",
        revision: beamRevision(),
        instanceId: options.liveConfig?.instanceId ?? null,
        config: options.liveConfig?.status() ?? null,
        checks: { telemetry: "ok" },
      };
    } catch {
      return reply.code(503).send({
        ok: false,
        service: "beam-studio-orchestrator",
        checks: { telemetry: "unavailable" },
      });
    }
  });

  server.get("/ready", async () => {
    await options.pgPool.query("SELECT 1");
    verifyBuiltinRegistry();
    const taskPublisherReady = options.taskPublisherReady
      ? await options.taskPublisherReady()
      : true;
    if (!taskPublisherReady) {
      throw new Error("Task publisher is not ready.");
    }
    return {
      ok: true,
      service: "beam-studio-orchestrator",
      checks: {
        database: "ok",
        builtinRegistry: "ok",
        taskPublisher: "ok",
      },
    };
  });

  server.get("/metrics", async (_request, reply) => {
    try {
      const [load, publication, snapshot] = await Promise.all([
        estimateGlobalLoadPg(options.pgPool),
        commandPublicationStatePg(options.pgPool),
        observabilitySnapshotPg(options.pgPool),
      ]);
      telemetry.set(
        "beam_orchestrator_worker_load_score",
        numberMetric(load.averageLoadScore),
      );
      telemetry.set(
        "beam_orchestrator_active_workers",
        numberMetric(load.activeWorkerCount),
      );
      telemetry.set(
        "beam_orchestrator_command_outbox_pending",
        numberMetric(publication.pendingCount),
      );
      telemetry.set(
        "beam_orchestrator_command_outbox_pending_with_error",
        numberMetric(publication.pendingWithErrorCount),
      );
      telemetry.set(
        "beam_orchestrator_command_outbox_oldest_seconds",
        numberMetric(publication.oldestUnpublishedSeconds),
      );
      for (const [state, value] of Object.entries(snapshot.queueDepth)) {
        telemetry.set("beam_workflow_queue_depth", value, { state });
      }
      telemetry.set(
        "beam_workflow_queue_oldest_age_seconds",
        snapshot.oldestQueueAgeSeconds,
      );
      for (const [status, value] of Object.entries(snapshot.workers)) {
        telemetry.set("beam_workers", value, { status });
      }
      telemetry.set(
        "beam_worker_heartbeat_age_seconds",
        snapshot.stalestWorkerHeartbeatSeconds,
        { status: "stale" },
      );
      const metrics = await telemetry.exportMetrics();
      reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return metrics;
    } catch {
      return reply.code(503).type("text/plain").send("metrics unavailable\n");
    }
  });

  server.get("/workers/load", async () => estimateGlobalLoadPg(options.pgPool));
  server.get("/commands/publication", async () =>
    commandPublicationStatePg(options.pgPool),
  );

  return server;
}

function verifyBuiltinRegistry() {
  const registry = createBuiltinActionRegistry();
  for (const entry of builtinActionCatalog()) {
    registry.resolvePackage(entry.manifest.name, entry.manifest.version);
  }
}

function numberMetric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function startServer(
  port: number,
  options: {
    pgPool: PgPool;
    taskPublisherReady?: () => boolean | Promise<boolean>;
    telemetry?: Telemetry;
    logger?: FastifyBaseLogger;
    liveConfig?: ReportedConfig;
  },
) {
  const server = buildServer(options);
  await server.listen({ port, host: listenHost("ORCHESTRATOR_BIND_HOST") });
  return server;
}

export async function stopServer(server: FastifyInstance) {
  await server.close();
}
