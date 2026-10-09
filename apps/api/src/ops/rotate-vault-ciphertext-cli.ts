import { createPostgresPool } from "@beam-studio/db";
import { webEnv } from "../env.js";
import {
  formatRotationReport,
  rotateVaultCiphertext,
} from "./rotate-vault-ciphertext.js";

/**
 * `pnpm --filter @beam-studio/api vault:rotate`
 *
 * Run it after putting a new key in `BEAM_STUDIO_SECRET_KEY` and the previous
 * one in `BEAM_STUDIO_SECRET_KEY_RETIRED`, with every service restarted so
 * none of them is still writing under the old key. It exits non-zero while
 * anything remains unreadable, so a deployment pipeline cannot treat a partial
 * rotation as a finished one.
 */
async function main() {
  const pool = createPostgresPool(webEnv.databaseUrl);
  try {
    const report = await rotateVaultCiphertext(pool);
    process.stdout.write(`${formatRotationReport(report)}\n`);
    process.exitCode = report.complete ? 0 : 1;
  } finally {
    await pool.end();
  }
}

await main();
