import { createInstanceKeyService } from "../studio/instance-key.js";
import { readInstance } from "../studio/repositories/instance-access-repository.js";
import { createPostgresPool } from "@beam-studio/db";
import { revokeInstanceKeyForUninstall } from "./instance-key-revoke.js";

/**
 * Revokes this Studio's instance key at Beam and here.
 *
 * Shipped in the api image as `/app/apps/api/dist/ops/instance-key-revoke-cli.js`
 * and run inside the api container, which holds the vault key that decrypts
 * the instance key. `beam-updater uninstall` runs it before stopping Studio.
 * Exits non-zero when a key may still be live, so the operator is told to
 * revoke it in the Console.
 */
async function main() {
  const pool = createPostgresPool();
  try {
    const outcome = await revokeInstanceKeyForUninstall({
      readOwner: async () => {
        const instance = await readInstance(pool);
        return instance.state === "claimed"
          ? instance.ownerOrganizationId
          : null;
      },
      revoke: (organizationId) =>
        createInstanceKeyService().revoke(organizationId),
    });
    process.stderr.write(outcome.message, () => process.exit(outcome.exitCode));
  } finally {
    void pool.end().catch(() => {});
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
