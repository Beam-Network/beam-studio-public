import { createPostgresPool, type InstanceState } from "@beam-studio/db";
import { readInstance } from "../studio/repositories/instance-access-repository.js";
import { claimCodeOutput } from "./instance-claim-code.js";

/**
 * Prints the code that claims this Studio in Settings → Access.
 *
 * Shipped in the api image as `/app/apps/api/dist/ops/instance-claim-code-cli.js`
 * and run inside the api container, which holds the key the API checks
 * against. Operators reach it through `sudo beam-updater claim-code`; the
 * installer runs it with `--unclaimed-only` at the end of an install.
 *
 * It writes the code to stdout only — never to a log — and exits non-zero only
 * when the code cannot be derived at all.
 */
const STATE_TIMEOUT_MS = 5_000;

async function readState(): Promise<InstanceState | null> {
  let pool: ReturnType<typeof createPostgresPool> | undefined;
  try {
    pool = createPostgresPool();
    const read = readInstance(pool).then((instance) => instance.state);
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), STATE_TIMEOUT_MS).unref(),
    );
    return await Promise.race([read, timeout]);
  } catch {
    return null;
  } finally {
    // Not awaited: a pool stuck connecting must not hold the answer back.
    void pool?.end().catch(() => {});
  }
}

async function main() {
  const unclaimedOnly = process.argv.slice(2).includes("--unclaimed-only");
  const output = claimCodeOutput({ state: await readState(), unclaimedOnly });
  process.stderr.write(output.stderr);
  process.stdout.write(output.stdout, () => process.exit(0));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
