import type { PgPool } from "@beam-studio/db";
import { installPublicRegistryPackage } from "./store.js";

/**
 * Registry actions a fresh Studio installs on its own.
 *
 * `@beam/transfer` is Studio's main use case, but it is released from the
 * Registry rather than bundled, so a new installation used to list it as
 * "Available — Install" and send the customer on a detour before their first
 * workflow could move anything.
 */
export const PREINSTALLED_REGISTRY_ACTIONS = ["@beam/transfer"] as const;

export type PreinstallOutcome = {
  packageName: string;
  outcome: "present" | "installed" | "failed";
  /** Why the install failed, for the log. */
  reason?: string;
};

type Install = (packageName: string) => Promise<unknown>;

const installLatest: Install = (packageName) =>
  installPublicRegistryPackage({ packageName, range: "latest" });

/**
 * Installs the latest Registry release of each preinstalled action that has no
 * usable release yet, and leaves an installed one alone: updates stay an
 * explicit choice on the Registry page.
 *
 * Never raises. The Registry is an external service, and nothing else Studio
 * serves depends on it; a failed install leaves the action installable by hand.
 */
export async function ensurePreinstalledRegistryActions(
  pool: PgPool,
  install: Install = installLatest,
): Promise<PreinstallOutcome[]> {
  const outcomes: PreinstallOutcome[] = [];
  for (const packageName of PREINSTALLED_REGISTRY_ACTIONS) {
    try {
      if (await hasUsableRelease(pool, packageName)) {
        outcomes.push({ packageName, outcome: "present" });
        continue;
      }
      await install(packageName);
      outcomes.push(
        (await hasUsableRelease(pool, packageName))
          ? { packageName, outcome: "installed" }
          : {
              packageName,
              outcome: "failed",
              reason: "the install left no active release",
            },
      );
    } catch (error) {
      outcomes.push({
        packageName,
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

async function hasUsableRelease(pool: PgPool, packageName: string) {
  const result = await pool.query(
    `SELECT 1
     FROM actions.package_versions version
     JOIN actions.packages package ON package.id=version.package_id
     WHERE package.package_name=$1
       AND version.status IN ('active','deprecated')
     LIMIT 1`,
    [packageName],
  );
  return result.rows.length > 0;
}
