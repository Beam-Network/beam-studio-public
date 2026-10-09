import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));
const migrationsDir = join(packageRoot, "src", "postgres-migrations");

loadEnvFile(join(workspaceRoot, ".env.local"));
loadEnvFile(join(workspaceRoot, ".env"));

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://beam:beam@127.0.0.1:5432/beam_studio";

const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

if (migrations.length === 0) {
  console.log("No PostgreSQL migrations found.");
  process.exit(0);
}

for (const migration of migrations) {
  const path = join(migrationsDir, migration);
  console.log(`Applying ${migration}`);
  const result = spawnSync(
    "psql",
    [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", path],
    {
      stdio: "inherit",
    },
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Applied ${migrations.length} PostgreSQL migration(s).`);

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
