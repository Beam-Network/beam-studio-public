import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgPool } from "./postgres.js";
import { applyTargetSchema } from "./target-schema-application.mjs";

export async function ensurePostgresMigrations(pool: PgPool) {
  const targetSchemaPath = resolveTargetSchemaPath();

  const client = await pool.connect();
  try {
    await applyTargetSchema(client, readTargetSchema(targetSchemaPath));
  } finally {
    client.release();
  }
}

export function readTargetSchema(targetSchemaPath: string) {
  const parts = [readFileSync(targetSchemaPath, "utf8").trim()];
  const extensionDir = targetSchemaPath.replace(/\.sql$/, ".d");
  if (existsSync(extensionDir)) {
    for (const name of readdirSync(extensionDir).sort()) {
      if (!name.endsWith(".sql")) continue;
      const text = readFileSync(join(extensionDir, name), "utf8").trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n\n");
}

function resolveTargetSchemaPath() {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(currentDir, "beam-studio-target-schema.sql"),
    join(currentDir, "..", "..", "src", "beam-studio-target-schema.sql"),
  ];

  const targetSchemaPath = candidates.find((candidate) =>
    existsSync(candidate),
  );
  if (!targetSchemaPath) {
    throw new Error(
      `PostgreSQL target schema not found. Checked: ${candidates.join(", ")}`,
    );
  }

  return targetSchemaPath;
}
