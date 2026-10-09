import type { FastifyInstance } from "fastify";
import type { LiveServiceConfig, PgPool } from "@beam-studio/db";
import type { StudioOpsConfig } from "./ops-listener.js";

export type StudioOpsRouteOptions = {
  ops: StudioOpsConfig;
  liveConfig?: LiveServiceConfig | null;
};

export function registerStudioOpsRoutes(
  _server: FastifyInstance,
  _pool: PgPool,
  _options: StudioOpsRouteOptions,
) {}
