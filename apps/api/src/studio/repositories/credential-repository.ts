import { decryptString } from "@beam-studio/vault";
import {
  pgMany,
  pgOne,
  withPostgresTransaction,
  type PgPool,
} from "@beam-studio/db";
import type { CredentialRecord } from "../store.js";
import {
  credentialRecordFromRow,
  normalizeCredentialPayload,
} from "./credential-projection.js";
import type { OrganizationScope } from "./organization-scope.js";
import { nowIso, parsePayload, type Row } from "./record-helpers.js";

/**
 * Credential persistence, scoped to one organization.
 *
 * The store reduced a missing organization to `""` and paired it with
 * `($1 = '' OR c.organization_id = $1)`, which reads as "no filter". A lost
 * scope therefore returned another tenant's decrypted secret by id, and
 * revoked credentials the caller never owned. These predicates are plain
 * equality, so no value widens them.
 */
export class CredentialRepository {
  constructor(
    private readonly pool: PgPool,
    private readonly vaultSecret: () => string,
  ) {}

  async list(scope: OrganizationScope): Promise<CredentialRecord[]> {
    const rows = await pgMany<Row>(
      this.pool,
      `SELECT c.*,
              ct.slug AS credential_type_slug,
              pp.id AS provider_profile_slug,
              pp.display_name AS provider_display_name
         FROM secrets.credentials c
         JOIN secrets.credential_types ct ON ct.id = c.credential_type_id
         LEFT JOIN secrets.provider_profiles pp ON pp.id = c.provider_profile_id
        WHERE c.status = 'active'
          AND c.organization_id = $1
        ORDER BY COALESCE(pp.display_name, ct.display_name), c.name`,
      [scope.organizationId],
    );
    return rows.map(credentialRecordFromRow);
  }

  /**
   * The decrypted payload. Authorized backend execution only: this is the one
   * place a stored secret leaves the database, so the scope is not optional.
   */
  async payload(scope: OrganizationScope, credentialId: string) {
    const row = await pgOne<Row>(
      this.pool,
      `SELECT cv.encrypted_payload
         FROM secrets.credentials c
         JOIN secrets.credential_versions cv ON cv.credential_id = c.id
        WHERE c.id = $1
          AND c.status = 'active'
          AND cv.status = 'active'
          AND c.organization_id = $2
        ORDER BY cv.version DESC
        LIMIT 1`,
      [credentialId, scope.organizationId],
    );
    if (!row) return null;
    return normalizeCredentialPayload(
      parsePayload(
        decryptString(String(row.encrypted_payload), this.vaultSecret()),
      ),
    );
  }

  /** Returns whether a credential in this organization was revoked. */
  async revoke(scope: OrganizationScope, credentialId: string) {
    return withPostgresTransaction(this.pool, async (client) => {
      const managed = await client.query(
        `SELECT 1 FROM secrets.credentials
          WHERE id = $1 AND organization_id = $2
            AND external_source = 'beam_studio_instance' AND status = 'active'`,
        [credentialId, scope.organizationId],
      );
      if ((managed.rowCount ?? 0) > 0) {
        // Deleting it here would leave the key live at Beam; revoking goes
        // through Settings → Access, which revokes it there first.
        throw Object.assign(
          new Error(
            "Studio manages its instance key. Revoke it under Settings → Access.",
          ),
          { code: "credential_managed_by_studio", statusCode: 409 },
        );
      }
      const referenced = await client.query(
        `SELECT 1 FROM studio.room_storage_bindings
          WHERE credential_id = $1 AND availability <> 'revoked' LIMIT 1`,
        [credentialId],
      );
      if ((referenced.rowCount ?? 0) > 0) {
        throw new Error(
          "Credential is attached to a room storage member. Remove every room binding before deleting it.",
        );
      }
      const timestamp = nowIso();
      const revoked = await client.query(
        `UPDATE secrets.credentials
            SET status = 'revoked', updated_at = $3
          WHERE id = $1 AND organization_id = $2`,
        [credentialId, scope.organizationId, timestamp],
      );
      if ((revoked.rowCount ?? 0) === 0) return false;
      await client.query(
        `UPDATE secrets.credential_versions
            SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2)
          WHERE credential_id = $1
            AND status = 'active'`,
        [credentialId, timestamp],
      );
      return true;
    });
  }
}
