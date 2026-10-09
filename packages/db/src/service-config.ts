import { hostname } from "node:os";
import type { PgPool } from "./postgres.js";

const DEFAULTS: Record<string, number> = {
  WORKER_STALE_WORKER_TTL_MS: 60_000,
  WORKER_MAX_ATTEMPTS: 3,
  ORCHESTRATOR_POLL_INTERVAL_MS: 2_000,
  ORCHESTRATOR_BATCH_SIZE: 25,
  ORCHESTRATOR_TASK_MAX_ATTEMPTS: 3,
  WORKER_CANCELLATION_POLL_INTERVAL_MS: 1_000,
  NATS_TASK_REDELIVERY_DELAY_MS: 2_000,
  WORKER_ACTION_SANDBOX_TIMEOUT_MS: 300_000,
  WORKER_ACTION_SANDBOX_MEMORY_MB: 128,
};

export type ServiceConfigStatus = {
  version: number | null;
  applied: Record<string, number | boolean>;
  deployed: Record<string, string | null>;
  pendingRestart: string[];
  rejected: { key: string; reason: string }[];
};

export type LiveServiceConfig = {
  readonly service: string;
  readonly instanceId: string;
  int(key: string): number;
  flag(key: string): boolean;
  status(): ServiceConfigStatus;
  sync(): Promise<void>;
  stop(): void;
};

function intValue(env: NodeJS.ProcessEnv, key: string) {
  const fallback = DEFAULTS[key];
  if (fallback === undefined)
    throw new Error(`${key} is not a service configuration key.`);
  const raw = env[key];
  const value = Number(raw);
  return raw != null && raw !== "" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export async function startLiveServiceConfig(options: {
  service: string;
  pool?: PgPool;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  instanceId?: string;
  logger?: unknown;
  onChange?: () => void;
}): Promise<LiveServiceConfig> {
  const env = options.env ?? process.env;
  const deployed = Object.fromEntries(
    Object.keys(DEFAULTS).map((key) => [key, env[key] ?? null]),
  );
  return {
    service: options.service,
    instanceId: options.instanceId ?? `${hostname()}-${process.pid}`,
    int: (key) => intValue(env, key),
    flag: (key) => env[key] === "true",
    status: () => ({
      version: null,
      applied: Object.fromEntries(
        Object.keys(DEFAULTS).map((key) => [key, intValue(env, key)]),
      ),
      deployed: { ...deployed },
      pendingRestart: [],
      rejected: [],
    }),
    sync: async () => {},
    stop: () => {},
  };
}
