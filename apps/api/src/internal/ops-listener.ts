import type http from "node:http";
import type { FastifyInstance } from "fastify";

export type StudioOpsConfig = {
  port: number;
  secret: string | null;
  problem: string | null;
};

export function studioOpsConfig(
  _env: NodeJS.ProcessEnv = process.env,
  _apiPort?: number,
): StudioOpsConfig {
  return { port: 8789, secret: null, problem: null };
}

export function registerOpsListenerGuard(_server: FastifyInstance) {}

export function listenOps(
  _server: FastifyInstance,
  _port: number,
  _host: string,
): Promise<http.Server> {
  return Promise.reject(
    new Error("The Ops listener is not part of this distribution."),
  );
}

export function closeOps(_ops: http.Server | null) {
  return Promise.resolve();
}
