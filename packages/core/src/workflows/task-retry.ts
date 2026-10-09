export type TaskRetryPolicy = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
};

const DEFAULT_POLICY: TaskRetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 2_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};

const POLICIES: Record<string, Partial<TaskRetryPolicy>> = {
  transfer: { maxAttempts: 5, initialDelayMs: 10_000, maxDelayMs: 300_000 },
  download: { maxAttempts: 4, initialDelayMs: 5_000, maxDelayMs: 120_000 },
  upload: { maxAttempts: 4, initialDelayMs: 5_000, maxDelayMs: 120_000 },
};

export function retryPolicyForTask(
  capability: string,
  configuredMaxAttempts: number,
): TaskRetryPolicy {
  const policy = { ...DEFAULT_POLICY, ...(POLICIES[capability] ?? {}) };
  return {
    ...policy,
    maxAttempts: Math.max(1, configuredMaxAttempts || policy.maxAttempts),
  };
}

export function retryDelayMs(policy: TaskRetryPolicy, attempt: number) {
  const exponent = Math.max(0, attempt - 1);
  const delay = policy.initialDelayMs * policy.backoffMultiplier ** exponent;
  return Math.min(policy.maxDelayMs, Math.round(delay));
}

export function parseRetryPolicy(value: unknown): TaskRetryPolicy {
  if (!value || typeof value !== "object") {
    return DEFAULT_POLICY;
  }
  const input = value as Partial<Record<keyof TaskRetryPolicy, unknown>>;
  return {
    maxAttempts: positiveInt(input.maxAttempts, DEFAULT_POLICY.maxAttempts),
    initialDelayMs: positiveInt(
      input.initialDelayMs,
      DEFAULT_POLICY.initialDelayMs,
    ),
    maxDelayMs: positiveInt(input.maxDelayMs, DEFAULT_POLICY.maxDelayMs),
    backoffMultiplier: Math.max(
      1,
      Number(input.backoffMultiplier ?? DEFAULT_POLICY.backoffMultiplier),
    ),
  };
}

function positiveInt(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
