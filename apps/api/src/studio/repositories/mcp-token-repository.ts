import { pgMany, type PgPool } from "@beam-studio/db";
import {
  assertMcpScopes,
  mcpScopesJson,
  parseMcpScopes,
  type McpScope,
} from "@beam-studio/shared";
import { ensureIdentityOrganization } from "./identity-organization.js";
import type { OrganizationScope } from "./organization-scope.js";
import {
  createRawMcpToken,
  hashMcpToken,
  newId,
  normalizeOptionalIsoDate,
  nowIso,
  timestampText,
} from "./record-helpers.js";
import { StudioValidationError } from "../validation-error.js";

export type McpTokenRow = {
  id: string;
  organization_id: string;
  name: string;
  prefix: string | null;
  scopes_json: unknown;
  expires_at: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type McpTokenRecord = {
  id: string;
  organizationId: string;
  name: string;
  tokenPrefix: string;
  scopes: McpScope[];
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
};

export type McpTokenUsageSummary = {
  tokenId: string;
  successCount: number;
  failureCount: number;
  lastActivityAt: string | null;
};

function requestedScopes(scopes: readonly string[]) {
  try {
    return assertMcpScopes(scopes);
  } catch (error) {
    throw Object.assign(new Error((error as Error).message), {
      code: "mcp_scopes_invalid",
      statusCode: 400,
      expose: true,
    });
  }
}

/**
 * MCP token persistence.
 *
 * Every operation takes a verified {@link OrganizationScope}. The predicates
 * are plain equality rather than the store's `(:organizationId = '' OR …)`
 * form, so there is no value that widens a statement to other tenants — which
 * previously meant a revoke or delete could act on any token by ID alone.
 */
export class McpTokenRepository {
  constructor(private readonly pool: PgPool) {}

  async list(scope: OrganizationScope): Promise<McpTokenRecord[]> {
    const rows = await pgMany<McpTokenRow>(
      this.pool,
      `SELECT * FROM mcp.tokens
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [scope.organizationId],
    );
    return rows.map((row) => this.toRecord(row));
  }

  async create(
    scope: OrganizationScope,
    input: {
      name: string;
      scopes: readonly string[];
      expiresAt?: string | null;
    },
  ) {
    const name = input.name.trim();
    if (!name) {
      throw new StudioValidationError(
        "mcp_token_name_required",
        "Token name is required.",
        { field: "name" },
      );
    }

    const expiresAt = normalizeOptionalIsoDate(input.expiresAt);
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      throw new StudioValidationError(
        "expiration_date_invalid",
        "Expiration date must be in the future.",
        { field: "expiresAt" },
      );
    }
    const scopes = requestedScopes(input.scopes);
    const token = createRawMcpToken();
    const timestamp = nowIso();
    const record: McpTokenRecord = {
      id: newId("mcp"),
      organizationId: scope.organizationId,
      name,
      tokenPrefix: token.slice(0, 18),
      scopes,
      expiresAt,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUsedAt: null,
      revokedAt: null,
      status: "active",
    };

    // mcp.tokens references identity.organizations, and on a fresh database
    // nothing has written this organization yet (Studio learns it from Beam).
    await ensureIdentityOrganization(this.pool, scope.organizationId);
    await this.pool.query(
      `INSERT INTO mcp.tokens (
         id, organization_id, name, token_hash, prefix,
         scopes_json, expires_at, created_at, updated_at, last_used_at, revoked_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
      [
        record.id,
        record.organizationId,
        record.name,
        hashMcpToken(token),
        record.tokenPrefix,
        mcpScopesJson(scopes),
        record.expiresAt,
        record.createdAt,
        record.updatedAt,
        record.lastUsedAt,
        record.revokedAt,
      ],
    );

    return { token, record };
  }

  async usageSummaries(
    scope: OrganizationScope,
  ): Promise<McpTokenUsageSummary[]> {
    const rows = await pgMany<Record<string, unknown>>(
      this.pool,
      `SELECT token_id,
              SUM(CASE WHEN metadata_json->>'status' = 'success' THEN 1 ELSE 0 END) AS success_count,
              SUM(CASE WHEN metadata_json->>'status' = 'failure' THEN 1 ELSE 0 END) AS failure_count,
              MAX(created_at) AS last_activity_at
         FROM mcp.audit_events
        WHERE token_id IS NOT NULL
          AND organization_id = $1
        GROUP BY token_id`,
      [scope.organizationId],
    );
    return rows.map((row) => ({
      tokenId: String(row.token_id),
      successCount: Number(row.success_count ?? 0),
      failureCount: Number(row.failure_count ?? 0),
      lastActivityAt: row.last_activity_at
        ? String(row.last_activity_at)
        : null,
    }));
  }

  /** Returns whether a token in this organization was revoked. */
  async revoke(scope: OrganizationScope, tokenId: string) {
    const timestamp = nowIso();
    const result = await this.pool.query(
      `UPDATE mcp.tokens
          SET revoked_at = COALESCE(revoked_at, $3),
              status = 'revoked',
              updated_at = $4
        WHERE id = $1 AND organization_id = $2`,
      [tokenId, scope.organizationId, timestamp, timestamp],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Returns whether a token in this organization was deleted. */
  async delete(scope: OrganizationScope, tokenId: string) {
    const result = await this.pool.query(
      `DELETE FROM mcp.tokens WHERE id = $1 AND organization_id = $2`,
      [tokenId, scope.organizationId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private toRecord(row: McpTokenRow): McpTokenRecord {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      name: String(row.name),
      tokenPrefix: row.prefix ? String(row.prefix) : "",
      scopes: parseMcpScopes(
        row.scopes_json ? JSON.stringify(row.scopes_json) : null,
      ),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      createdAt: timestampText(row.created_at),
      updatedAt: timestampText(row.updated_at),
      lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      status: mcpTokenStatus(row),
    };
  }
}

function mcpTokenStatus(row: McpTokenRow): McpTokenRecord["status"] {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) {
    return "expired";
  }
  return "active";
}
