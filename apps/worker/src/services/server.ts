import {
  isLoopbackRemoteAddress,
  opsAuthorized,
} from "@beam-studio/shared/ops-auth";
import { hostAllowed, listenHost } from "@beam-studio/shared";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { PgPool } from "@beam-studio/db";
import { Telemetry } from "@beam-studio/telemetry";

export function buildWorkerServer(options: {
  pgPool: PgPool;
  telemetry?: Telemetry;
}) {
  const telemetry = options.telemetry ?? new Telemetry("worker");
  const server = Fastify({ logger: false });

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

  // /health answers a container healthcheck from inside the container;
  // /metrics is operational data and takes the deployment's ops token.
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
      await Promise.all([options.pgPool.query("SELECT 1"), telemetry.check()]);
      return {
        ok: true,
        service: "beam-studio-worker",
        checks: { database: "ok", telemetry: "ok" },
      };
    } catch {
      return reply.code(503).send({
        ok: false,
        service: "beam-studio-worker",
        checks: { database: "unavailable", telemetry: "unavailable" },
      });
    }
  });

  server.get("/metrics", async (_request, reply) => {
    try {
      const metrics = await telemetry.exportMetrics();
      reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return metrics;
    } catch {
      return reply.code(503).type("text/plain").send("metrics unavailable\n");
    }
  });

  return server;
}

export async function startWorkerServer(
  port: number,
  options: { pgPool: PgPool; telemetry?: Telemetry },
) {
  const server = buildWorkerServer(options);
  await server.listen({
    port,
    host: listenHost("WORKER_OBSERVABILITY_BIND_HOST"),
  });
  return server;
}

export async function stopWorkerServer(server: FastifyInstance) {
  await server.close();
}
