import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pgMany, pgOne, type PgPool } from "@beam-studio/db";
import {
  ciphertextKeyId,
  decryptString,
  encryptString,
  isLegacyCiphertext,
  vaultKeyId,
  vaultKeyring,
} from "@beam-studio/vault";
import { defaultRefreshTokenPath } from "../auth/secure-token-store.js";

/**
 * Re-encrypts every stored secret under the active vault key.
 *
 * This is the half of rotation that the keyring alone cannot do. Adding a new
 * key and retiring the old one makes both readable; nothing becomes safe to
 * *drop* until every value that was written under the old key has been
 * rewritten under the new one. Until this has run and reported zero remaining,
 * removing a key from `BEAM_STUDIO_SECRET_KEY_RETIRED` destroys data.
 *
 * It is idempotent and resumable: a value already under the active key is
 * skipped, so an interrupted run is finished by running it again. It reads and
 * writes one row at a time rather than in one transaction, because a rotation
 * over a large credential table should not hold locks for its duration and
 * because a partial rotation is a valid intermediate state.
 */

type ColumnSource = {
  kind: "column";
  /** Schema-qualified, because prod has no `public` on the search path. */
  table: string;
  keyColumns: readonly string[];
  column: string;
  /** Kept in step with the ciphertext where the table records it. */
  keyIdColumn?: string;
};

type JsonSource = {
  kind: "json";
  table: string;
  keyColumns: readonly string[];
  column: string;
  jsonKey: string;
};

type Source = ColumnSource | JsonSource;

/**
 * Every place a vault-encrypted value comes to rest.
 *
 * A table that does not exist is skipped rather than failing: the legacy
 * `public` tables only exist where the optional orchestration migration chain
 * was run, and a target-schema install has none of them.
 */
const SOURCES: readonly Source[] = [
  {
    kind: "column",
    table: "secrets.credential_versions",
    keyColumns: ["id"],
    column: "encrypted_payload",
    keyIdColumn: "encryption_key_id",
  },
  {
    kind: "column",
    table: "assistant.provider_settings",
    keyColumns: ["organization_id", "user_id"],
    column: "encrypted_api_key",
  },
  {
    kind: "json",
    table: "workflow.triggers",
    keyColumns: ["id"],
    column: "config_json",
    jsonKey: "token",
  },
  {
    kind: "column",
    table: "public.beam_api_keys",
    keyColumns: ["id"],
    column: "encrypted_api_key",
  },
  {
    kind: "column",
    table: "public.transfer_templates",
    keyColumns: ["id"],
    column: "encrypted_custom_api_key",
  },
];

export type RotationReport = {
  /** Per source: how many values were read, rewritten, and left alone. */
  sources: Array<{
    source: string;
    examined: number;
    rewritten: number;
    /** Values no configured key can read. Never rewritten, always reported. */
    unreadable: number;
  }>;
  refreshTokenFiles: {
    examined: number;
    rewritten: number;
    unreadable: number;
  };
  /** True when nothing anywhere still needs the active key applied. */
  complete: boolean;
  activeKeyId: string;
};

export async function rotateVaultCiphertext(
  pool: PgPool,
  options: { refreshTokenPath?: string } = {},
): Promise<RotationReport> {
  const keyring = vaultKeyring();
  const activeKeyId = keyring.active.id;

  const sources: RotationReport["sources"] = [];
  for (const source of SOURCES) {
    if (!(await tableExists(pool, source.table))) continue;
    sources.push(
      source.kind === "column"
        ? await rotateColumn(pool, source, activeKeyId)
        : await rotateJsonKey(pool, source, activeKeyId),
    );
  }

  const refreshTokenFiles = await rotateRefreshTokenFiles(
    options.refreshTokenPath ?? defaultRefreshTokenPath(),
    activeKeyId,
  );

  return {
    sources,
    refreshTokenFiles,
    // "Complete" means no value anywhere is still under a non-active key.
    // Unreadable values keep it false: they are not rotated, and dropping the
    // retired key would make their loss permanent rather than recoverable.
    complete:
      sources.every((entry) => entry.unreadable === 0) &&
      refreshTokenFiles.unreadable === 0,
    activeKeyId,
  };
}

async function tableExists(pool: PgPool, table: string) {
  const row = await pgOne<{ present: string | null }>(
    pool,
    "SELECT to_regclass($1)::text AS present",
    [table],
  );
  return Boolean(row?.present);
}

/** The value re-encrypted under the active key, or null when it is already there. */
function reencrypted(stored: string, activeKeyId: string) {
  if (!stored) return null;
  if (!isLegacyCiphertext(stored) && ciphertextKeyId(stored) === activeKeyId) {
    return null;
  }
  return encryptString(decryptString(stored));
}

async function rotateColumn(
  pool: PgPool,
  source: ColumnSource,
  activeKeyId: string,
) {
  const keys = source.keyColumns.join(", ");
  const rows = await pgMany<Record<string, string | null>>(
    pool,
    `SELECT ${keys}, ${source.column} AS stored
       FROM ${source.table}
      WHERE ${source.column} IS NOT NULL AND ${source.column} <> ''`,
  );

  let rewritten = 0;
  let unreadable = 0;
  for (const row of rows) {
    const stored = String(row.stored ?? "");
    const where = source.keyColumns
      .map((column, index) => `${column} = $${index + 2}`)
      .join(" AND ");
    const values = source.keyColumns.map((column) => row[column]);
    let next: string | null;
    try {
      next = reencrypted(stored, activeKeyId);
    } catch {
      // Left exactly as it is. Rewriting would need the plaintext, which is
      // the thing we cannot get; reporting it is what stops an operator from
      // retiring the key that would have read it.
      unreadable += 1;
      continue;
    }
    if (!next) continue;
    const setKeyId = source.keyIdColumn
      ? `, ${source.keyIdColumn} = $${source.keyColumns.length + 2}`
      : "";
    await pool.query(
      `UPDATE ${source.table} SET ${source.column} = $1${setKeyId} WHERE ${where}`,
      source.keyIdColumn ? [next, ...values, activeKeyId] : [next, ...values],
    );
    rewritten += 1;
  }
  return {
    source: `${source.table}.${source.column}`,
    examined: rows.length,
    rewritten,
    unreadable,
  };
}

async function rotateJsonKey(
  pool: PgPool,
  source: JsonSource,
  activeKeyId: string,
) {
  const keys = source.keyColumns.join(", ");
  const rows = await pgMany<Record<string, string | null>>(
    pool,
    `SELECT ${keys}, ${source.column}->>'${source.jsonKey}' AS stored
       FROM ${source.table}
      WHERE ${source.column} ? '${source.jsonKey}'
        AND ${source.column}->>'${source.jsonKey}' <> ''`,
  );

  let rewritten = 0;
  let unreadable = 0;
  for (const row of rows) {
    const stored = String(row.stored ?? "");
    let next: string | null;
    try {
      next = reencrypted(stored, activeKeyId);
    } catch {
      unreadable += 1;
      continue;
    }
    if (!next) continue;
    const where = source.keyColumns
      .map((column, index) => `${column} = $${index + 2}`)
      .join(" AND ");
    await pool.query(
      `UPDATE ${source.table}
          SET ${source.column} = jsonb_set(${source.column}, '{${source.jsonKey}}', to_jsonb($1::text))
        WHERE ${where}`,
      [next, ...source.keyColumns.map((column) => row[column])],
    );
    rewritten += 1;
  }
  return {
    source: `${source.table}.${source.column}->>${source.jsonKey}`,
    examined: rows.length,
    rewritten,
    unreadable,
  };
}

/**
 * The OAuth refresh tokens, which live in files rather than the database.
 *
 * One file per browser session under `<store path>.sessions/`. They are the
 * easiest part of a rotation to forget, and forgetting them signs every user
 * out the moment the old key is dropped.
 */
async function rotateRefreshTokenFiles(basePath: string, activeKeyId: string) {
  const directory = `${basePath}.sessions`;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return { examined: 0, rewritten: 0, unreadable: 0 };
  }

  let examined = 0;
  let rewritten = 0;
  let unreadable = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    let payload: { version?: number; encrypted_refresh_token?: string };
    try {
      payload = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    const stored = String(payload.encrypted_refresh_token ?? "");
    if (!stored) continue;
    examined += 1;
    let next: string | null;
    try {
      next = reencrypted(stored, activeKeyId);
    } catch {
      unreadable += 1;
      continue;
    }
    if (!next) continue;
    // Written and renamed, the same way the store itself writes, so an exit
    // mid-rotation cannot leave a half-written session file.
    const temporary = `${path}.${activeKeyId}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ ...payload, encrypted_refresh_token: next })}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, path);
    rewritten += 1;
  }
  return { examined, rewritten, unreadable };
}

/** One line per source, safe to print: ids are HMACs, never key material. */
export function formatRotationReport(report: RotationReport) {
  const lines = [`active key ${report.activeKeyId}`];
  for (const entry of report.sources) {
    lines.push(
      `${entry.source}: ${entry.rewritten}/${entry.examined} rewritten` +
        (entry.unreadable ? `, ${entry.unreadable} UNREADABLE` : ""),
    );
  }
  const files = report.refreshTokenFiles;
  lines.push(
    `oauth refresh tokens: ${files.rewritten}/${files.examined} rewritten` +
      (files.unreadable ? `, ${files.unreadable} UNREADABLE` : ""),
  );
  lines.push(
    report.complete
      ? "complete — every value is readable under the active key, retired keys can be dropped"
      : "INCOMPLETE — values remain that no configured key can read; do not drop any retired key",
  );
  return lines.join("\n");
}
