import {
  UNSEEDED_INSTANCE,
  pgMany,
  pgOne,
  type InstanceState,
  type JoinPolicy,
  type MembershipRole,
  type MembershipStatus,
  type PgClient,
  type PgPool,
} from "@beam-studio/db";
import { nowIso, timestampText } from "./record-helpers.js";

/**
 * Reads and writes which organizations this deployment serves.
 *
 * Unlike every sibling repository this one takes no `OrganizationScope`: it is
 * instance-scoped by definition, and a scope would suggest the rows belong to a
 * tenant when they are the record of which tenants exist.
 */

// The vocabulary is shared with the admission authority in the db package,
// which the MCP server uses too.
export {
  alwaysAdmitted,
  type InstanceState,
  type JoinPolicy,
  type MembershipRole,
  type MembershipStatus,
} from "@beam-studio/db";

export type InstanceRecord = {
  /** Identifies this installation to Beam; null only before the schema. */
  instanceId: string | null;
  state: InstanceState;
  ownerOrganizationId: string | null;
  joinPolicy: JoinPolicy;
  claimedAt: string | null;
  claimedByUserId: string | null;
  claimedByEmail: string | null;
};

export type InstanceOrganizationRecord = {
  organizationId: string;
  role: MembershipRole;
  status: MembershipStatus;
  requestedByUserId: string | null;
  requestedByEmail: string | null;
  decidedByUserId: string | null;
  decidedByEmail: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

type InstanceRow = {
  instance_id: string | null;
  state: string;
  owner_organization_id: string | null;
  join_policy: string;
  claimed_at: string | Date | null;
  claimed_by_user_id: string | null;
  claimed_by_email: string | null;
};

type MembershipRow = {
  organization_id: string;
  role: string;
  status: string;
  requested_by_user_id: string | null;
  requested_by_email: string | null;
  decided_by_user_id: string | null;
  decided_by_email: string | null;
  requested_at: string | Date | null;
  decided_at: string | Date | null;
  note: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const optionalTimestamp = (value: string | Date | null) =>
  value === null ? null : timestampText(value);

function toInstance(row: InstanceRow): InstanceRecord {
  return {
    instanceId: row.instance_id ? String(row.instance_id) : null,
    state: row.state as InstanceState,
    ownerOrganizationId: row.owner_organization_id,
    joinPolicy: row.join_policy as JoinPolicy,
    claimedAt: optionalTimestamp(row.claimed_at),
    claimedByUserId: row.claimed_by_user_id,
    claimedByEmail: row.claimed_by_email,
  };
}

function toMembership(row: MembershipRow): InstanceOrganizationRecord {
  return {
    organizationId: row.organization_id,
    role: row.role as MembershipRole,
    status: row.status as MembershipStatus,
    requestedByUserId: row.requested_by_user_id,
    requestedByEmail: row.requested_by_email,
    decidedByUserId: row.decided_by_user_id,
    decidedByEmail: row.decided_by_email,
    requestedAt: optionalTimestamp(row.requested_at),
    decidedAt: optionalTimestamp(row.decided_at),
    note: row.note,
    createdAt: timestampText(row.created_at),
    updatedAt: timestampText(row.updated_at),
  };
}

/**
 * The singleton row, seeded by the target schema.
 *
 * A database that has never had the schema applied has no row at all; callers
 * treat that as unclaimed and closed rather than as permission.
 */
export async function readInstance(
  client: PgPool | PgClient,
): Promise<InstanceRecord> {
  const row = await pgOne<InstanceRow>(
    client,
    `SELECT instance_id, state, owner_organization_id, join_policy, claimed_at,
            claimed_by_user_id, claimed_by_email
       FROM studio.instance
      WHERE id = 'singleton'`,
  );
  return row
    ? toInstance(row)
    : {
        ...UNSEEDED_INSTANCE,
        instanceId: null,
        claimedAt: null,
        claimedByUserId: null,
        claimedByEmail: null,
      };
}

export async function readInstanceOrganization(
  client: PgPool | PgClient,
  organizationId: string,
): Promise<InstanceOrganizationRecord | null> {
  const row = await pgOne<MembershipRow>(
    client,
    `SELECT * FROM studio.instance_organizations WHERE organization_id = $1`,
    [organizationId],
  );
  return row ? toMembership(row) : null;
}

export async function listInstanceOrganizations(
  client: PgPool | PgClient,
): Promise<InstanceOrganizationRecord[]> {
  const rows = await pgMany<MembershipRow>(
    client,
    `SELECT * FROM studio.instance_organizations
      ORDER BY role DESC, created_at ASC`,
  );
  return rows.map(toMembership);
}

/**
 * Claims an unclaimed instance for one organization.
 *
 * The guard is in the statement rather than in a preceding read, so two callers
 * racing to claim a fresh install cannot both succeed: the loser updates no
 * rows and is told the instance is already claimed.
 */
export async function claimInstance(
  client: PgPool | PgClient,
  input: {
    organizationId: string;
    userId: string | null;
    email: string | null;
  },
): Promise<boolean> {
  const timestamp = nowIso();
  const claimed = await pgOne<{ id: string }>(
    client,
    `UPDATE studio.instance
        SET state = 'claimed',
            owner_organization_id = $1,
            claimed_at = $2,
            claimed_by_user_id = $3,
            claimed_by_email = $4,
            updated_at = $2
      WHERE id = 'singleton' AND state <> 'claimed'
      RETURNING id`,
    [input.organizationId, timestamp, input.userId, input.email],
  );
  if (!claimed) {
    return false;
  }

  // An unclaimed instance should hold no owner row, but a stray one (a reset
  // done by hand, say) would fail the single-owner index below and leave the
  // instance claimed with no owner membership. Demote it first.
  await client.query(
    `UPDATE studio.instance_organizations
        SET role = 'member', updated_at = $2
      WHERE role = 'owner' AND organization_id <> $1`,
    [input.organizationId, timestamp],
  );
  await upsertInstanceOrganization(client, {
    organizationId: input.organizationId,
    role: "owner",
    status: "admitted",
    decidedByUserId: input.userId,
    decidedByEmail: input.email,
    note: "claimed this instance",
  });
  return true;
}

/**
 * Releases the installation: nobody owns it and it serves nobody until it is
 * claimed again. Membership rows stay, demoted, as the record of who used it.
 */
export async function releaseInstance(client: PgPool | PgClient) {
  const timestamp = nowIso();
  await client.query(
    `UPDATE studio.instance
        SET state = 'unclaimed',
            owner_organization_id = NULL,
            claimed_at = NULL,
            claimed_by_user_id = NULL,
            claimed_by_email = NULL,
            updated_at = $1
      WHERE id = 'singleton'`,
    [timestamp],
  );
  await client.query(
    `UPDATE studio.instance_organizations
        SET role = 'member', note = 'owner released this instance', updated_at = $1
      WHERE role = 'owner'`,
    [timestamp],
  );
}

export async function setJoinPolicy(
  client: PgPool | PgClient,
  joinPolicy: JoinPolicy,
) {
  await client.query(
    `UPDATE studio.instance
        SET join_policy = $1, updated_at = $2
      WHERE id = 'singleton'`,
    [joinPolicy, nowIso()],
  );
}

export async function upsertInstanceOrganization(
  client: PgPool | PgClient,
  input: {
    organizationId: string;
    role?: MembershipRole;
    status: MembershipStatus;
    requestedByUserId?: string | null;
    requestedByEmail?: string | null;
    decidedByUserId?: string | null;
    decidedByEmail?: string | null;
    note?: string | null;
  },
) {
  const timestamp = nowIso();
  const decided = input.decidedByUserId || input.decidedByEmail;
  await client.query(
    `INSERT INTO studio.instance_organizations (
       organization_id, role, status,
       requested_by_user_id, requested_by_email,
       decided_by_user_id, decided_by_email,
       requested_at, decided_at, note, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     ON CONFLICT (organization_id) DO UPDATE
     SET role = EXCLUDED.role,
         status = EXCLUDED.status,
         decided_by_user_id =
           COALESCE(EXCLUDED.decided_by_user_id,
                    studio.instance_organizations.decided_by_user_id),
         decided_by_email =
           COALESCE(EXCLUDED.decided_by_email,
                    studio.instance_organizations.decided_by_email),
         decided_at =
           COALESCE(EXCLUDED.decided_at, studio.instance_organizations.decided_at),
         note = COALESCE(EXCLUDED.note, studio.instance_organizations.note),
         updated_at = EXCLUDED.updated_at`,
    [
      input.organizationId,
      input.role ?? "member",
      input.status,
      input.requestedByUserId ?? null,
      input.requestedByEmail ?? null,
      input.decidedByUserId ?? null,
      input.decidedByEmail ?? null,
      input.status === "pending" ? timestamp : null,
      decided ? timestamp : null,
      input.note ?? null,
      timestamp,
    ],
  );
}

/**
 * Makes one organization the owner of this deployment.
 *
 * Shared by the in-product transfer and the `BEAM_STUDIO_OWNER_ORGANIZATION_ID`
 * recovery lever, so the two cannot drift. At most one row may hold the owner
 * role (`studio_instance_single_owner`), so the order is load-bearing: every
 * other owner is demoted before the new one is promoted. Promoting first fails
 * the unique index, which is how the lever once crash-looped the API.
 *
 * The outgoing owner keeps an admitted row and loses only the role, so a
 * handover does not lock the previous team out mid-transfer. The new owner is
 * admitted whatever its row said before — including none at all, or revoked —
 * because an owner that cannot use its own deployment is not an owner.
 *
 * Call it inside a transaction: the demotion and the promotion must land
 * together, or a failure between them leaves a deployment with no owner row.
 */
export async function transferInstanceOwnership(
  client: PgClient,
  input: {
    organizationId: string;
    decidedByUserId?: string | null;
    decidedByEmail?: string | null;
    previousOwnerNote?: string;
    newOwnerNote?: string;
  },
) {
  const timestamp = nowIso();
  const demoted = await pgMany<{ organization_id: string }>(
    client,
    `UPDATE studio.instance_organizations
        SET role = 'member',
            status = 'admitted',
            decided_by_user_id = COALESCE($2, decided_by_user_id),
            decided_by_email = COALESCE($3, decided_by_email),
            decided_at = CASE WHEN $2::text IS NULL AND $3::text IS NULL
                              THEN decided_at ELSE $5::timestamptz END,
            note = COALESCE($4, note),
            updated_at = $5
      WHERE role = 'owner' AND organization_id <> $1
      RETURNING organization_id`,
    [
      input.organizationId,
      input.decidedByUserId ?? null,
      input.decidedByEmail ?? null,
      input.previousOwnerNote ?? "ownership transferred away",
      timestamp,
    ],
  );
  const instance = await readInstance(client);
  const previous = instance.ownerOrganizationId;
  if (
    previous &&
    previous !== input.organizationId &&
    !demoted.some((row) => row.organization_id === previous) &&
    !(await readInstanceOrganization(client, previous))
  ) {
    // The instance names an owner with no row at all. It still keeps its
    // access, as a transfer promises. A row that exists is a decision someone
    // made (a revoke, say) and is left as it is.
    await upsertInstanceOrganization(client, {
      organizationId: previous,
      role: "member",
      status: "admitted",
      decidedByUserId: input.decidedByUserId ?? null,
      decidedByEmail: input.decidedByEmail ?? null,
      note: input.previousOwnerNote ?? "ownership transferred away",
    });
  }
  await upsertInstanceOrganization(client, {
    organizationId: input.organizationId,
    role: "owner",
    status: "admitted",
    decidedByUserId: input.decidedByUserId ?? null,
    decidedByEmail: input.decidedByEmail ?? null,
    note: input.newOwnerNote ?? "ownership transferred here",
  });
  await client.query(
    `UPDATE studio.instance
        SET owner_organization_id = $1, updated_at = $2
      WHERE id = 'singleton'`,
    [input.organizationId, timestamp],
  );
  return {
    previousOwnerOrganizationId: previous,
    demotedOrganizationIds: demoted.map((row) => row.organization_id),
  };
}

/**
 * Records that an organization asked to join.
 *
 * Only ever creates a `pending` row: an organization that was already admitted
 * or deliberately revoked must not be reset by its own members asking again.
 */
export async function requestInstanceAccess(
  client: PgPool | PgClient,
  input: {
    organizationId: string;
    userId: string | null;
    email: string | null;
  },
) {
  const timestamp = nowIso();
  await client.query(
    `INSERT INTO studio.instance_organizations (
       organization_id, role, status,
       requested_by_user_id, requested_by_email, requested_at,
       created_at, updated_at
     )
     VALUES ($1, 'member', 'pending', $2, $3, $4, $4, $4)
     ON CONFLICT (organization_id) DO NOTHING`,
    [input.organizationId, input.userId, input.email, timestamp],
  );
}
