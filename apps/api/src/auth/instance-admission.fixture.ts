import type { PgPool } from "@beam-studio/db";
import {
  createInstanceAdmission,
  type InstanceAdmission,
} from "./instance-admission.js";

/**
 * An admission authority for tests, seeded with the organizations a fixture's
 * deployment serves.
 *
 * Tests build servers over stub pools that answer only what the case under
 * test needs, so they have no `studio.instance` rows and would read as an
 * unclaimed deployment that serves nobody. That is the right production
 * default and the wrong fixture default: a test about organization isolation
 * should not have to restate what this installation is.
 *
 * It drives the real `createInstanceAdmission` over a pool that answers the
 * two instance reads, rather than faking the interface, so the caching and
 * verdict logic under test is the same code that runs in production.
 */
export function admittedInstance(
  organizationIds: readonly string[],
  options: {
    state?: "unclaimed" | "adopted" | "claimed";
    joinPolicy?: "open" | "request" | "closed";
    ownerOrganizationId?: string;
    consumerOrganizationId?: string;
  } = {},
): InstanceAdmission {
  const owner = options.ownerOrganizationId ?? organizationIds[0] ?? null;
  const admitted = new Set(organizationIds);
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      // Checked first: "studio.instance_organizations" contains
      // "studio.instance", so the looser match has to come second.
      if (sql.includes("studio.instance_organizations")) {
        const organizationId = String(values[0]);
        return admitted.has(organizationId)
          ? {
              rows: [
                {
                  organization_id: organizationId,
                  role: organizationId === owner ? "owner" : "member",
                  status: "admitted",
                  requested_by_user_id: null,
                  requested_by_email: null,
                  decided_by_user_id: null,
                  decided_by_email: null,
                  requested_at: null,
                  decided_at: null,
                  note: null,
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("studio.instance")) {
        return {
          rows: [
            {
              state: options.state ?? "claimed",
              owner_organization_id: owner,
              join_policy: options.joinPolicy ?? "closed",
              claimed_at: "2026-01-01T00:00:00.000Z",
              claimed_by_user_id: null,
              claimed_by_email: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PgPool;

  return createInstanceAdmission({
    pool,
    ttlMs: 0,
    consumerOrganizationId: options.consumerOrganizationId ?? null,
  });
}
