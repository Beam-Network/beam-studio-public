/**
 * Whether this deployment serves an organization, read over the API's pool.
 *
 * The rules and their caching are `createInstanceAdmissionAuthority` in
 * `@beam-studio/db`, shared with the MCP server so the two planes can
 * never disagree about who this deployment serves. This file only supplies the
 * PostgreSQL reads and the join-request write.
 */

import {
  admitsMachineCaller,
  createInstanceAdmissionAuthority,
  type InstanceAdmissionAuthority,
  type PgPool,
} from "@beam-studio/db";
import {
  readInstance,
  readInstanceOrganization,
  requestInstanceAccess,
} from "../studio/repositories/instance-access-repository.js";

export {
  admitsMachineCaller,
  type AdmissionOutcome,
  type AdmissionVerdict,
  type InstanceSnapshot,
} from "@beam-studio/db";

export type InstanceAdmissionOptions = {
  pool: PgPool;
  /**
   * The Rooms consumer organization, admitted unconditionally. It is the
   * deployment acting as itself, not a tenant that was let in.
   */
  consumerOrganizationId?: string | null;
  now?: () => number;
  /** How long an answer is reused; see `createInstanceAdmissionAuthority`. */
  ttlMs?: number;
};

export function createInstanceAdmission(
  options: InstanceAdmissionOptions,
): InstanceAdmissionAuthority {
  const { pool, ...rest } = options;
  return createInstanceAdmissionAuthority({
    ...rest,
    store: {
      async readInstance() {
        const record = await readInstance(pool);
        return {
          state: record.state,
          joinPolicy: record.joinPolicy,
          ownerOrganizationId: record.ownerOrganizationId,
        };
      },
      async readMembership(organizationId) {
        const membership = await readInstanceOrganization(pool, organizationId);
        return membership
          ? { role: membership.role, status: membership.status }
          : null;
      },
      requestAccess: (input) => requestInstanceAccess(pool, input),
    },
  });
}

export type InstanceAdmission = InstanceAdmissionAuthority;

/**
 * The admission question for a machine caller, as a predicate: an enrolling
 * or token-refreshing agent, or a webhook trigger firing a run.
 *
 * These use the same rule as MCP tokens (`admitsMachineCaller`): an
 * organization is served only if its admission was recorded, or if it is
 * exempt (`__local__` and the Rooms consumer organization). An open join
 * policy admits browser sessions on first use, never machines. A long-lived
 * agent credential or webhook secret proves nothing about current Beam
 * membership, so letting one ride the open policy would serve an
 * organization nobody ever let in.
 */
export function machineCallerAdmission(admission: InstanceAdmissionAuthority) {
  return async (organizationId: string) =>
    admitsMachineCaller(await admission.check(organizationId));
}
