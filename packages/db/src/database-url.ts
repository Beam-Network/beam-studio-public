export type DatabaseEngine = "postgresql";
export type OrchestrationDatabaseMode = "postgresql";
export const LOCAL_ORGANIZATION_ID = "__local__";

export type OrchestrationDatabaseConfig = {
  mode: OrchestrationDatabaseMode;
  postgresUrl: string | null;
};

type Env = Readonly<Record<string, string | undefined>>;

export function databaseEngineForUrl(databaseUrl: string): DatabaseEngine {
  if (
    databaseUrl.startsWith("postgres://") ||
    databaseUrl.startsWith("postgresql://")
  ) {
    return "postgresql";
  }

  throw new Error(
    `Unsupported database URL "${databaseUrl}". PostgreSQL is required.`,
  );
}

export function readOrchestrationDatabaseConfig(
  env: Env = process.env,
): OrchestrationDatabaseConfig {
  return {
    mode: orchestrationDatabaseMode(env.ORCHESTRATION_DATABASE_MODE),
    postgresUrl: env.DATABASE_URL ?? null,
  };
}

function orchestrationDatabaseMode(
  value: string | undefined,
): OrchestrationDatabaseMode {
  if (!value || value === "postgresql") {
    return "postgresql";
  }

  throw new Error(
    `Unsupported ORCHESTRATION_DATABASE_MODE="${value}". Workflow orchestration now requires PostgreSQL.`,
  );
}
