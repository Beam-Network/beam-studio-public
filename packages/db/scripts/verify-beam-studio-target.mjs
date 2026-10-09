import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));

loadEnvFile(join(workspaceRoot, ".env.local"));
loadEnvFile(join(workspaceRoot, ".env"));

const connectionString = process.env.DATABASE_URL ?? "";

const failures = [];
const warnings = [];

checkConnectionString("DATABASE_URL", connectionString);

if (connectionString) {
  await checkDatabase(connectionString);
}

checkSourceText();

if (warnings.length) {
  console.log("Warnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}

if (failures.length) {
  console.error("Beam Studio target verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Beam Studio target verification passed.");

function checkConnectionString(name, value, options = {}) {
  if (!value) {
    if (!options.optional) {
      failures.push(`${name} is not set.`);
    }
    return;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    failures.push(`${name} is not a valid URL.`);
    return;
  }

  const databaseName = url.pathname.replace(/^\/+/, "");
  if (databaseName !== "beam_studio") {
    failures.push(
      `${name} must target beam_studio; found ${databaseName || "(none)"}.`,
    );
  }
}

async function checkDatabase(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const database = await client.query("SELECT current_database() AS name");
    const databaseName = String(database.rows[0]?.name ?? "");
    if (databaseName !== "beam_studio") {
      failures.push(
        `Connected database is ${databaseName}, expected beam_studio.`,
      );
    }

    const publicTables = await scalar(
      client,
      `
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      `,
    );
    if (publicTables !== 0) {
      failures.push(`public schema contains ${publicTables} base table(s).`);
    }

    const expectedSchemas = [
      "identity",
      "secrets",
      "mcp",
      "actions",
      "workflow",
      "execution",
      "runtime",
      "meta",
    ];
    const schemaCount = await scalar(
      client,
      `
      SELECT COUNT(*)::int AS count
      FROM pg_namespace
      WHERE nspname = ANY($1::text[])
      `,
      [expectedSchemas],
    );
    if (schemaCount !== expectedSchemas.length) {
      failures.push(
        `Expected ${expectedSchemas.length} Beam Studio schemas, found ${schemaCount}.`,
      );
    }

    const counts = await client.query(
      `
      SELECT 'credential_types' AS name, COUNT(*)::int AS count
      FROM secrets.credential_types
      UNION ALL
      SELECT 'provider_profiles', COUNT(*)::int
      FROM secrets.provider_profiles
      UNION ALL
      SELECT 'action_packages', COUNT(*)::int
      FROM actions.packages
      UNION ALL
      SELECT 'credential_requirements', COUNT(*)::int
      FROM actions.credential_requirements
      `,
    );
    const requiredMinimums = new Map([
      // 15 seeded types and 50 profiles today; these are floors, not exact
      // counts, so they catch a seed that did not run without needing an edit
      // every time one is added.
      ["credential_types", 15],
      ["provider_profiles", 50],
      ["action_packages", 13],
      ["credential_requirements", 7],
    ]);
    for (const row of counts.rows) {
      const minimum = requiredMinimums.get(String(row.name));
      if (minimum !== undefined && Number(row.count) < minimum) {
        failures.push(
          `${row.name} has ${row.count} row(s), expected at least ${minimum}.`,
        );
      }
    }
  } finally {
    await client.end();
  }
}

async function scalar(client, sql, values = []) {
  const result = await client.query(sql, values);
  return Number(result.rows[0]?.count ?? 0);
}

function checkSourceText() {
  const files = [
    ".env.local",
    ".env.example",
    "README.md",
    "docker-compose.yml",
    "packages/db/drizzle.postgres.config.ts",
    "packages/db/scripts/apply-postgres-migrations.mjs",
    "packages/db/src/postgres.ts",
    "apps/api/src",
    "apps/orchestrator/src",
    "apps/worker/src",
    "apps/mcp-server/src",
  ].flatMap((entry) => collectFiles(join(workspaceRoot, entry)));

  for (const file of files) {
    const relative = file.slice(workspaceRoot.length + 1);
    const text = readFileSync(file, "utf8");
    if (text.includes("beam_orchestration")) {
      failures.push(`${relative} still references beam_orchestration.`);
    }
    if (/postgres:\/\/[^ \n]+\/beamcore\b/.test(text)) {
      failures.push(
        `${relative} still references a beamcore PostgreSQL database.`,
      );
    }
  }

  const runtimeFiles = files.filter((file) => {
    const relative = file.slice(workspaceRoot.length + 1);
    if (
      !/^(apps\/api\/src|apps\/orchestrator\/src|apps\/worker\/src)/.test(
        relative,
      )
    ) {
      return false;
    }
    const text = readFileSync(file, "utf8");
    return /\b(createPostgresPool|PgPool|PgClient|pgOne|pgMany|withPostgresTransaction|postgres)\b/.test(
      text,
    );
  });
  const legacyRuntimeTables = [
    "workflow_templates",
    "workflow_steps",
    "workflow_edges",
    "workflow_triggers",
    "workflow_trigger_edges",
    "workflow_plan_versions",
    "workflow_action_locks",
    "workflow_runs",
    "workflow_step_runs",
    "workflow_tasks",
    "workflow_task_attempts",
    "workflow_task_dead_letters",
    "workflow_artifacts",
    "workflow_events",
    "execution_plans",
    "execution_plan_nodes",
    "execution_plan_edges",
    "execution_plan_shards",
    "worker_runtime_state",
    "worker_capabilities",
    "execution_locations",
    "organizations",
    "action_packages",
  ];

  for (const file of runtimeFiles) {
    const relative = file.slice(workspaceRoot.length + 1);
    const text = readFileSync(file, "utf8");
    for (const table of legacyRuntimeTables) {
      const pattern = new RegExp(
        `\\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES|DELETE\\s+FROM)\\s+${table}\\b`,
        "i",
      );
      if (pattern.test(text)) {
        warnings.push(
          `${relative} appears to use legacy SQL table "${table}" without target-schema qualification.`,
        );
        break;
      }
    }
  }
}

function collectFiles(path) {
  if (!existsSync(path)) {
    return [];
  }
  const stat = statSync(path);
  if (stat.isFile()) {
    return shouldScan(path) ? [path] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      return [];
    }
    return collectFiles(join(path, entry.name));
  });
}

function shouldScan(path) {
  return /\.(ts|tsx|js|mjs|json|md|yml|yaml|env|example|local)$/.test(path);
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = unquote(trimmed.slice(separator + 1).trim());
    process.env[key] ??= value;
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
