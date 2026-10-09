import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decryptString,
  encryptString,
  vaultSecretFromEnv,
} from "@beam-studio/vault";
import {
  createPostgresPool,
  prepareWorkflowJobCutoverPg,
  recordWorkflowCutoverBackupPg,
  migrateJobsToWorkflowsPg,
  resumeWorkflowJobCutoverPg,
  assertWorkflowCutoverDrainedPg,
} from "../src/index.js";

const [command, expectedTarget, backupFile] = process.argv.slice(2);
const url = new URL(process.env.DATABASE_URL ?? "");
const target = `${url.hostname}:${url.port || "5432"}${url.pathname}`;
if (target !== expectedTarget)
  throw new Error(
    `Confirm the database target by passing ${target} after the command. Credentials must stay in DATABASE_URL.`,
  );
const pool = createPostgresPool(url.toString());
try {
  if (command === "prepare") {
    const state = await prepareWorkflowJobCutoverPg(pool);
    console.log({ target, status: state?.status });
  } else if (command === "backup") {
    if (!backupFile) throw new Error("Supply a new local backup file path.");
    const path = resolve(backupFile);
    const state = (
      await pool.query(
        "SELECT status FROM meta.workflow_cutovers WHERE id='workflow-first-v1'",
      )
    ).rows[0];
    if (state?.status !== "prepared")
      throw new Error("Prepare the cutover before backup.");
    await assertWorkflowCutoverDrainedPg(pool);
    // libpq environment avoids exposing the DSN/password through process arguments.
    const env = {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer",
    };
    async function run(binary: string, args: string[], output?: number) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, args, {
          env,
          stdio: ["ignore", output ?? "ignore", "pipe"],
          windowsHide: true,
        });
        // Do not echo provider errors that may contain connection secrets.
        child.stderr?.resume();
        child.on("error", () =>
          reject(
            new Error(
              `${binary} could not start. Install the PostgreSQL client tools.`,
            ),
          ),
        );
        child.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  `${binary} failed with exit code ${code}; backup was not recorded.`,
                ),
              ),
        );
      });
    }
    // Exclusive creation prevents concurrent invocations or symlinks from
    // overwriting an archive. Backups contain credentials and are owner-only.
    const file = await open(path, "wx", 0o600);
    try {
      await run("pg_dump", ["--format=custom", "--no-password"], file.fd);
      await file.sync();
    } finally {
      await file.close();
    }
    await run("pg_restore", ["--list", path]);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const backup = {
      path,
      sha256: hash.digest("hex"),
      bytes: (await stat(path)).size,
    };
    await recordWorkflowCutoverBackupPg(pool, backup);
    console.log({ target, backup });
  } else if (command === "migrate") {
    console.log({
      target,
      report: await migrateJobsToWorkflowsPg(pool, {
        wrapLegacyBillingKey(encryptedKey) {
          const secret = vaultSecretFromEnv();
          return encryptString(
            JSON.stringify({ api_key: decryptString(encryptedKey, secret) }),
            secret,
          );
        },
      }),
    });
  } else if (command === "resume") {
    console.log({ target, report: await resumeWorkflowJobCutoverPg(pool) });
  } else if (command === "status") {
    const state = (
      await pool.query(
        "SELECT status,prepared_at,migrated_at,resumed_at,report_json FROM meta.workflow_cutovers WHERE id='workflow-first-v1'",
      )
    ).rows[0];
    console.log({ target, state });
  } else
    throw new Error(
      "Usage: workflow-job-cutover.ts prepare|backup|migrate|resume|status host:port/database [backup-file]",
    );
} finally {
  await pool.end();
}
