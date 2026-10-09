import {
  LOCAL_ORGANIZATION_ID,
  type PgClient,
  type PgPool,
} from "@beam-studio/db";

/**
 * Ensures an organization row exists before something references it.
 *
 * Tenant-scoped tables carry a foreign key to `identity.organizations`, and
 * Studio learns organizations from Beam rather than owning them, so the row is
 * created lazily by whichever write path needs it first. It lives here rather
 * than in `store.ts` because `store.ts` imports this directory, so a
 * repository cannot import back from it.
 */
export async function ensureIdentityOrganization(
  client: PgPool | PgClient,
  organizationId?: string | null,
) {
  const orgId = organizationId?.trim() || LOCAL_ORGANIZATION_ID;
  const slug =
    orgId === LOCAL_ORGANIZATION_ID
      ? "local"
      : orgId
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "organization";
  const timestamp = new Date().toISOString();
  await client.query(
    `
    INSERT INTO identity.organizations (
      id, slug, name, metadata_json, created_at, updated_at
    )
    VALUES ($1, $2, $3, '{}'::jsonb, $4, $4)
    ON CONFLICT(id) DO UPDATE
    SET name = EXCLUDED.name,
        updated_at = EXCLUDED.updated_at
    `,
    [orgId, slug, orgId === LOCAL_ORGANIZATION_ID ? "Local" : orgId, timestamp],
  );
  return orgId;
}
