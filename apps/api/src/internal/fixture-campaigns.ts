import type { FastifyInstance } from "fastify";
import type { PgPool } from "@beam-studio/db";

export function registerFixtureRotationRoutes(
  _server: FastifyInstance,
  _pool: PgPool,
  _env: NodeJS.ProcessEnv = process.env,
) {}
