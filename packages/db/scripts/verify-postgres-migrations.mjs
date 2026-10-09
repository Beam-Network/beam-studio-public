import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));
const migrateScript = join(packageRoot, "scripts", "apply-postgres-migrations.mjs");

loadEnvFile(join(workspaceRoot, ".env.local"));
loadEnvFile(join(workspaceRoot, ".env"));

const baseUrl =
  process.env.DATABASE_URL ??
  "postgres://beam:beam@127.0.0.1:5432/beam_studio";

const testDatabaseName = `beam_migrations_${process.pid}_${Date.now()}`;
const targetUrl = databaseUrlForName(baseUrl, testDatabaseName);
const maintenanceUrl = databaseUrlForName(baseUrl, "postgres");

await createDatabase(maintenanceUrl, testDatabaseName);

try {
  applyMigrations(targetUrl, "empty database");
  applyMigrations(targetUrl, "idempotence pass");
  console.log("PostgreSQL migrations apply from empty database and are idempotent.");
} finally {
  await dropDatabase(maintenanceUrl, testDatabaseName);
}

function applyMigrations(databaseUrl, label) {
  console.log(`Verifying PostgreSQL migrations: ${label}`);
  const result = spawnSync(process.execPath, [migrateScript], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const error = new Error(`PostgreSQL migration verification failed during ${label}.`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

async function createDatabase(connectionString, databaseName) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(connectionString, databaseName) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()
      `,
      [databaseName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
}

function databaseUrlForName(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
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
