/**
 * Establishes instance ownership from the environment, at boot.
 *
 * This is the recovery lever, not the ordinary path: an instance is normally
 * claimed through the product with a code derived from its vault secret. An
 * operator who claimed with the wrong account, or inherited a deployment whose
 * owner has left, would otherwise be reduced to editing tables by hand.
 *
 * It sets ownership only, never the join policy. Who owns a deployment and who
 * it admits are different decisions, and a recovery step should not silently
 * reopen an instance its owner deliberately closed.
 *
 * What it does, by the state it finds:
 *
 * - unclaimed or adopted: claims the instance for the named organization.
 * - claimed by another organization: transfers ownership exactly as the
 *   in-product transfer does (the old owner keeps an admitted member row).
 * - claimed by the named organization: nothing, unless its owner row was lost,
 *   revoked or demoted, in which case the row is restored.
 *
 * The named organization does not have to be admitted already. "The claim
 * went to the wrong organization" is the case this exists for, and the right
 * one has often never been let in; it is admitted as owner.
 */

import {
  withPostgresTransaction,
  type PgClient,
  type PgPool,
} from "@beam-studio/db";
import {
  claimInstance,
  readInstance,
  readInstanceOrganization,
  transferInstanceOwnership,
} from "../studio/repositories/instance-access-repository.js";

const LEVER = "BEAM_STUDIO_OWNER_ORGANIZATION_ID";

export type InstanceBootstrapResult =
  | { applied: false; reason: "unset" }
  | { applied: false; reason: "unchanged"; organizationId: string }
  | {
      applied: true;
      organizationId: string;
      action: "claimed" | "transferred" | "restored";
      previousOwnerOrganizationId: string | null;
    };

export async function bootstrapInstanceOwner(
  pool: PgPool,
  ownerOrganizationId?: string | null,
): Promise<InstanceBootstrapResult> {
  const organizationId = ownerOrganizationId?.trim();
  if (!organizationId) {
    return { applied: false, reason: "unset" };
  }
  return withPostgresTransaction(pool, (client) =>
    applyOwner(client, organizationId),
  );
}

async function applyOwner(
  client: PgClient,
  organizationId: string,
): Promise<InstanceBootstrapResult> {
  // Serializes against an in-product claim or transfer racing this boot.
  await client.query(
    `SELECT id FROM studio.instance WHERE id = 'singleton' FOR UPDATE`,
  );
  const instance = await readInstance(client);

  if (instance.state !== "claimed") {
    const won = await claimInstance(client, {
      organizationId,
      userId: null,
      email: null,
    });
    if (!won) {
      // Only an unseeded database gets here: the row lock above rules out a
      // concurrent claim.
      throw new Error(
        `${LEVER} could not claim this instance: studio.instance has no singleton row`,
      );
    }
    return {
      applied: true,
      organizationId,
      action: "claimed",
      previousOwnerOrganizationId: null,
    };
  }

  if (instance.ownerOrganizationId === organizationId) {
    const membership = await readInstanceOrganization(client, organizationId);
    if (membership?.role === "owner" && membership.status === "admitted") {
      // Runs on every boot while the variable is set; nothing to write.
      return { applied: false, reason: "unchanged", organizationId };
    }
  }

  const { previousOwnerOrganizationId } = await transferInstanceOwnership(
    client,
    {
      organizationId,
      previousOwnerNote: `ownership moved by ${LEVER}`,
      newOwnerNote: `owner asserted by ${LEVER}`,
    },
  );
  return {
    applied: true,
    organizationId,
    action:
      previousOwnerOrganizationId === organizationId
        ? "restored"
        : "transferred",
    previousOwnerOrganizationId,
  };
}

type LeverLogger = {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
};

/**
 * Runs the lever at boot and reports what it did.
 *
 * Never throws. The lever exists to rescue a deployment, and a failure here
 * used to end the process, so the restart policy turned one bad value into a
 * crash loop that took the whole Studio down. Ownership is left as it was and
 * the API keeps serving; the error line says what to fix.
 */
export async function applyInstanceOwnerLever(
  pool: PgPool,
  ownerOrganizationId: string | null | undefined,
  logger: LeverLogger,
  /** Revokes an organization's instance key at Beam and here. */
  revokeInstanceKey: (organizationId: string) => Promise<unknown>,
): Promise<InstanceBootstrapResult | null> {
  // Moving ownership away from an organization revokes its instance key
  // first, as an in-product transfer does: a key left live would keep
  // charging an organization that no longer owns the installation.
  const target = ownerOrganizationId?.trim();
  if (target) {
    let previousOwner: string | null = null;
    try {
      const instance = await readInstance(pool);
      previousOwner =
        instance.state === "claimed" && instance.ownerOrganizationId !== target
          ? instance.ownerOrganizationId
          : null;
      if (previousOwner) await revokeInstanceKey(previousOwner);
    } catch (error) {
      logger.error(
        { err: error, organizationId: target, previousOwner },
        `${LEVER} could not revoke the previous owner's instance key; instance ownership is unchanged and the API keeps serving`,
      );
      return null;
    }
  }
  let owner: InstanceBootstrapResult;
  try {
    owner = await bootstrapInstanceOwner(pool, ownerOrganizationId);
  } catch (error) {
    logger.error(
      { err: error, organizationId: ownerOrganizationId?.trim() || null },
      `${LEVER} could not be applied; instance ownership is unchanged and the API keeps serving`,
    );
    return null;
  }
  if (!owner.applied) {
    if (owner.reason === "unchanged") {
      logger.info(
        { organizationId: owner.organizationId },
        `The organization named by ${LEVER} already owns this instance; the variable can be unset`,
      );
    }
    return owner;
  }
  // Warned rather than logged at info: this is a recovery lever, and an
  // instance whose ownership changes from the environment is one somebody
  // should know about.
  const details = {
    action: owner.action,
    previousOwnerOrganizationId: owner.previousOwnerOrganizationId,
    ownerOrganizationId: owner.organizationId,
  };
  if (owner.action === "transferred") {
    logger.warn(
      details,
      `Instance ownership moved from ${owner.previousOwnerOrganizationId ?? "(no owner)"} to ${owner.organizationId} by ${LEVER}`,
    );
  } else if (owner.action === "claimed") {
    logger.warn(
      details,
      `Instance claimed for ${owner.organizationId} by ${LEVER}`,
    );
  } else {
    logger.warn(
      details,
      `Owner row of ${owner.organizationId} restored by ${LEVER}`,
    );
  }
  return owner;
}
