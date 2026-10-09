import { createHash } from "node:crypto";
import {
  describeFrequency,
  parseScheduleFrequency,
} from "@beam-studio/core";
import {
  admitsMachineCaller,
  createInstanceAdmissionAuthority,
  synchronousInstanceAdmissionStore,
  type InstanceAdmissionAuthority,
  legacyProductTablesPresent,
  LegacyProductRetiredError,
  LOCAL_ORGANIZATION_ID,
  openSynchronousPostgres,
  type SqlDatabase,
} from "@beam-studio/db";
import { createMcpLogger } from "./logging.js";
import {
  parseMcpScopes,
  isRunStatus,
  type McpScope,
  type RunStatus,
  builtinBeamEnvironmentTemplates,
} from "@beam-studio/shared";
import {
  decryptString,
  encryptString,
  vaultSecretFromEnv,
} from "@beam-studio/vault";

type Row = Record<string, unknown>;

export type ApiKeyRecord = {
  id: string;
  name: string;
  baseUrl: string;
  source: "local" | "organization";
  organizationId: string | null;
  organizationName: string | null;
  status: string | null;
  secretAvailable: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CredentialRecord = {
  id: string;
  organizationId: string;
  name: string;
  kind: string;
  payloadPreview: string;
  createdAt: string;
  updatedAt: string;
};

export type TransferTemplateRecord = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  apiKeyId: string;
  apiKeyName: string | null;
  customApiKeyConfigured: boolean;
  baseUrl: string | null;
  beamServerUrl: string | null;
  enabled: boolean;
  frequency: string;
  sourceCount: number;
  destinationCount: number;
  runCount: number;
  lastRunStatus: RunStatus | null;
  createdAt: string;
  updatedAt: string;
};

export type RunRecord = {
  id: string;
  transferTemplateId: string;
  transferName: string | null;
  status: RunStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
  queuedAt: string | null;
  nextAttemptAt: string | null;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  beamTransferId: string | null;
  trigger: string;
};

export type ScheduleRecord = {
  id: string;
  transferTemplateId: string;
  transferName: string | null;
  frequency: string;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type McpTokenAuth = {
  id: string;
  organizationId: string;
  name: string;
  scopes: McpScope[];
};

export type McpAuditEventInput = {
  organizationId?: string | null;
  tokenId?: string | null;
  action: string;
  target: string;
  status: "success" | "failure";
  ipAddress?: string | null;
  userAgent?: string | null;
  clientName?: string | null;
  error?: string | null;
};

const globalForMcp = globalThis as typeof globalThis & {
  __beamStudioMcpDb?: SqlDatabase;
};

const DEFAULT_BEAM_BASE_URL = builtinBeamEnvironmentTemplates.prod.baseUrl;
const CUSTOM_API_KEY_SELECT_VALUE = "__custom_api_key__";
const MCP_DATABASE_QUERY_TIMEOUT_MS = 10_000;

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function databaseUrl() {
  return (
    process.env.DATABASE_URL ??
    "postgres://beam:beam@127.0.0.1:5432/beam_studio"
  );
}

function beamDefaultBaseUrl() {
  return process.env.BEAM_DEFAULT_BASE_URL ?? DEFAULT_BEAM_BASE_URL;
}

function vaultSecret() {
  return vaultSecretFromEnv();
}

function hashMcpToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function db() {
  if (globalForMcp.__beamStudioMcpDb) {
    return globalForMcp.__beamStudioMcpDb;
  }
  const database = openSynchronousPostgres(databaseUrl(), {
    queryTimeoutMs: MCP_DATABASE_QUERY_TIMEOUT_MS,
    logger: storeLogger(),
    name: "mcp-store",
  });
  globalForMcp.__beamStudioMcpDb = database;
  return database;
}

let mcpStoreLogger: ReturnType<typeof createMcpLogger> | undefined;

/** The MCP service logger, for connection failures of the store's bridge. */
function storeLogger() {
  mcpStoreLogger ??= createMcpLogger();
  return mcpStoreLogger;
}

/**
 * `SELECT 1` for the /health probe. A failure is reported rather than thrown;
 * the bridge reconnects on the next query once PostgreSQL is back.
 */
export function checkStudioDatabase(): { ok: boolean } {
  try {
    db().prepare("SELECT 1").get();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function one<T>(sql: string, params: Record<string, unknown> = {}) {
  return db().prepare(sql).get(params) as T | undefined;
}

function many<T>(sql: string, params: Record<string, unknown> = {}) {
  return db().prepare(sql).all(params) as T[];
}

function organizationFilterValue(organizationId?: string | null) {
  return organizationId?.trim() ?? "";
}

let legacyProductState: boolean | null = null;

/**
 * Whether this database still has the pre-workflow transfer tables. The target
 * schema does not create them, so on a fresh Studio database the transfer,
 * schedule and run readers return nothing and the writers refuse with
 * LegacyProductRetiredError instead of a missing-relation error.
 */
function legacyProductStateAvailable() {
  legacyProductState ??= legacyProductTablesPresent(db());
  return legacyProductState;
}

function requireLegacyProductState(message: string) {
  if (!legacyProductStateAvailable()) {
    throw new LegacyProductRetiredError(message);
  }
}

const retiredTransfers =
  "Transfer templates are retired on this Studio database. Use beam.create_workflow and beam.run_workflow instead.";
const retiredSchedules =
  "Transfer schedules are retired on this Studio database. Use workflow schedule triggers instead.";
const retiredRuns =
  "Transfer runs are retired on this Studio database. Use beam.run_workflow and beam.cancel_workflow_run instead.";

function organizationIdForApiKey(apiKeyId: string) {
  const row = one<Row>(
    "SELECT organization_id FROM organization_api_keys_cache WHERE id = :id",
    {
      id: apiKeyId,
    },
  );
  return row?.organization_id
    ? String(row.organization_id)
    : LOCAL_ORGANIZATION_ID;
}

function requireApiKeyInOrganization(
  apiKeyId: string,
  organizationId?: string | null,
) {
  const scopedOrganizationId = organizationFilterValue(organizationId);
  if (!scopedOrganizationId) {
    return;
  }

  const row = one<Row>(
    "SELECT organization_id FROM organization_api_keys_cache WHERE id = :id",
    {
      id: apiKeyId,
    },
  );
  if (row && String(row.organization_id) === scopedOrganizationId) {
    return;
  }

  const localKey = one<Row>("SELECT id FROM beam_api_keys WHERE id = :id", {
    id: apiKeyId,
  });
  if (!localKey) {
    throw new Error("API key not found for the selected organization.");
  }
}

function requireTransferInOrganization(
  transferId: string,
  organizationId?: string | null,
) {
  const scopedOrganizationId = organizationFilterValue(organizationId);
  if (!scopedOrganizationId) {
    return;
  }

  const row = one<Row>(
    "SELECT id FROM transfer_templates WHERE id = :id AND organization_id = :organizationId",
    { id: transferId, organizationId: scopedOrganizationId },
  );
  if (!row) {
    throw new Error("Transfer template not found.");
  }
}

function bool(value: unknown) {
  return Number(value) === 1;
}

function runStatus(value: unknown): RunStatus {
  const status = String(value);
  if (isRunStatus(status)) {
    return status;
  }

  throw new Error(`Unknown run status: ${status}`);
}

function isCustomApiKeyId(apiKeyId: string) {
  return (
    apiKeyId === CUSTOM_API_KEY_SELECT_VALUE || apiKeyId.startsWith("custom:")
  );
}

function encryptOptionalSecret(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? encryptString(trimmed, vaultSecret()) : null;
}

function maxRunAttempts() {
  const value = Number(process.env.WORKER_MAX_ATTEMPTS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3;
}

function appendExecutionLog(
  runId: string | null,
  event: string,
  payload: unknown,
  database = db(),
) {
  database
    .prepare(
      `
    INSERT INTO execution_logs (id, run_id, event, payload, created_at, level)
    VALUES (:id, :runId, :event, :payload, :createdAt, 'info')
  `,
    )
    .run({
      id: id("log"),
      runId,
      event,
      payload: JSON.stringify(payload),
      createdAt: now(),
    });
}

export function getStudioDatabasePath() {
  return databaseUrl();
}

let instanceAdmission: InstanceAdmissionAuthority | undefined;

export function closeStudioStore() {
  globalForMcp.__beamStudioMcpDb?.close?.();
  delete globalForMcp.__beamStudioMcpDb;
  instanceAdmission = undefined;
}

/**
 * Whether this deployment still serves an organization.
 *
 * The MCP server validates tokens in its own process, against `mcp.tokens`
 * directly, so the admission check in the API does not cover it. Without this
 * a token minted before an organization was revoked would keep working here
 * after it stopped working everywhere else.
 *
 * It is the API's own authority (`createInstanceAdmissionAuthority`) and the
 * API's machine-caller rule, not a copy: an earlier copy here admitted only on
 * a claimed instance, which locked every token out of every upgraded install.
 * Unlike the API it does not cache (`ttlMs: 0`): an admit or revoke made
 * through the API cannot tell this process to forget, and the MCP server is
 * low-traffic next to the app shell's session polling, so a stale allow is
 * worse here than a query.
 */
async function organizationAdmitted(organizationId: string) {
  instanceAdmission ??= createInstanceAdmissionAuthority({
    store: synchronousInstanceAdmissionStore(db),
    consumerOrganizationId: process.env.BEAM_STUDIO_CONSUMER_ORGANIZATION_ID,
    ttlMs: 0,
  });
  return admitsMachineCaller(await instanceAdmission.check(organizationId));
}

/**
 * A valid token whose organization this deployment does not serve.
 *
 * Distinct from an unknown token (null): the caller holds a real credential,
 * so it is answered 403 with a stable code rather than a 401 that would send
 * a client off to re-authenticate for nothing.
 */
export class McpOrganizationNotAdmittedError extends Error {
  readonly code = "instance_organization_forbidden";
  readonly statusCode = 403;

  constructor(
    readonly tokenId: string,
    readonly organizationId: string,
  ) {
    super("This Studio does not serve the token's organization.");
    this.name = "McpOrganizationNotAdmittedError";
  }
}

/**
 * The token's grant, or null when the token is unknown, revoked or expired.
 * Throws {@link McpOrganizationNotAdmittedError} when the token is valid but
 * its organization is not admitted here.
 */
export async function authenticateMcpToken(
  token: string,
): Promise<McpTokenAuth | null> {
  const tokenHash = hashMcpToken(token.trim());
  const row = one<Row>(
    `
    SELECT id, organization_id, name, scopes_json
    FROM mcp.tokens
    WHERE token_hash = :tokenHash
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > :now)
    `,
    { tokenHash, now: now() },
  );

  if (!row) {
    return null;
  }

  if (!(await organizationAdmitted(String(row.organization_id)))) {
    throw new McpOrganizationNotAdmittedError(
      String(row.id),
      String(row.organization_id),
    );
  }

  db()
    .prepare(
      `
    UPDATE mcp.tokens
    SET last_used_at = :lastUsedAt,
      updated_at = :updatedAt
    WHERE id = :id
    `,
    )
    .run({
      id: String(row.id),
      lastUsedAt: now(),
      updatedAt: now(),
    });

  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    scopes: parseMcpScopes(
      row.scopes_json ? JSON.stringify(row.scopes_json) : null,
    ),
  };
}

export function recordMcpAuditEvent(input: McpAuditEventInput) {
  db()
    .prepare(
      `
    INSERT INTO mcp.audit_events (
      id, organization_id, token_id, event_type, subject_type, subject_id,
      ip_address, user_agent, metadata_json, created_at
    )
    VALUES (
      :id, :organizationId, :tokenId, :action, 'mcp', :target,
      :ipAddress, :userAgent, :metadata, :createdAt
    )
    `,
    )
    .run({
      id: id("mcp_audit"),
      organizationId: input.organizationId ?? null,
      tokenId: input.tokenId ?? null,
      action: input.action,
      target: input.target,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      // The target schema has no dedicated status/client/error columns; these
      // are event detail rather than structure, so they live in the payload.
      metadata: JSON.stringify({
        status: input.status,
        ...(input.clientName ? { clientName: input.clientName } : {}),
        ...(input.error ? { error: input.error } : {}),
      }),
      createdAt: now(),
    });
}

/**
 * Beam API keys visible to the organization: its stored `beam_api_key`
 * credentials, plus the legacy local and cached organization keys on databases
 * that still have those tables. Secrets are never returned.
 */
export function listApiKeys(
  filters: { organizationId?: string | null } = {},
): ApiKeyRecord[] {
  const organizationId = organizationFilterValue(filters.organizationId);
  const credentialKeys = many<Row>(
    `
    SELECT c.id, c.organization_id, c.name, c.metadata_json, c.status,
      c.created_at, c.updated_at
    FROM secrets.credentials c
    JOIN secrets.credential_types ct ON ct.id = c.credential_type_id
    WHERE ct.slug = 'beam_api_key'
      AND c.status = 'active'
      AND (:organizationId = '' OR c.organization_id = :organizationId)
    ORDER BY c.name
    `,
    { organizationId },
  ).map((row) => {
    const metadata = (row.metadata_json ?? {}) as Row;
    const baseUrl = metadata.baseUrl ?? metadata.base_url;
    return {
      id: String(row.id),
      name: String(row.name),
      baseUrl: baseUrl ? String(baseUrl) : beamDefaultBaseUrl(),
      source: "local" as const,
      organizationId: row.organization_id ? String(row.organization_id) : null,
      organizationName: null,
      status: String(row.status).toUpperCase(),
      secretAvailable: true,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  });
  if (!legacyProductStateAvailable()) return credentialKeys;

  // Legacy local keys carry no organization: they belong to the single local
  // organization. A scoped caller sees one only when it is that organization
  // or one of its own transfers is bound to the key.
  const localKeys = many<Row>(
    `
    SELECT k.id, k.name, k.base_url, k.created_at, k.updated_at
    FROM beam_api_keys k
    WHERE :organizationId = ''
       OR :organizationId = :localOrganizationId
       OR EXISTS (
         SELECT 1 FROM transfer_templates t
         WHERE t.api_key_id = k.id AND t.organization_id = :organizationId
       )
    ORDER BY k.name
    `,
    { organizationId, localOrganizationId: LOCAL_ORGANIZATION_ID },
  ).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    source: "local" as const,
    organizationId: null,
    organizationName: null,
    status: "ACTIVE",
    secretAvailable: true,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));

  const organizationKeys = many<Row>(
    `
    SELECT *
    FROM organization_api_keys_cache
    WHERE (:organizationId = '' OR organization_id = :organizationId)
    ORDER BY organization_name, name
    `,
    { organizationId },
  ).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    baseUrl: beamDefaultBaseUrl(),
    source: "organization" as const,
    organizationId: String(row.organization_id),
    organizationName: row.organization_name
      ? String(row.organization_name)
      : null,
    status: row.status ? String(row.status) : null,
    secretAvailable: false,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));

  const legacyKeys = [...organizationKeys, ...localKeys];
  const legacyIds = new Set(legacyKeys.map((key) => key.id));
  return [
    ...legacyKeys,
    ...credentialKeys.filter((key) => !legacyIds.has(key.id)),
  ];
}

export function listCredentials(
  filters: { organizationId?: string | null } = {},
): CredentialRecord[] {
  const organizationId = organizationFilterValue(filters.organizationId);

  return many<Row>(
    `
    SELECT
      c.*,
      ct.slug AS kind,
      cv.encrypted_payload
    FROM secrets.credentials c
    JOIN secrets.credential_types ct ON ct.id = c.credential_type_id
    JOIN LATERAL (
      SELECT encrypted_payload
      FROM secrets.credential_versions
      WHERE credential_id = c.id AND status = 'active'
      ORDER BY version DESC
      LIMIT 1
    ) cv ON true
    WHERE c.status = 'active'
      AND (:organizationId = '' OR c.organization_id = :organizationId)
    ORDER BY ct.slug, c.name
    `,
    { organizationId },
  ).map((row) => {
    let payloadPreview = "Encrypted payload";
    try {
      const payload = JSON.parse(
        decryptString(String(row.encrypted_payload), vaultSecret()),
      ) as Row;
      const keys = Object.keys(payload);
      payloadPreview = keys.length
        ? keys.slice(0, 4).join(", ")
        : "Empty payload";
    } catch {
      payloadPreview = "Could not decrypt with current secret";
    }

    return {
      id: String(row.id),
      organizationId: String(row.organization_id ?? LOCAL_ORGANIZATION_ID),
      name: String(row.name),
      kind: String(row.kind),
      payloadPreview,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  });
}

export function listTransfers(
  filters: {
    q?: string;
    state?: string;
    organizationId?: string | null;
    limit?: number;
  } = {},
): TransferTemplateRecord[] {
  if (!legacyProductStateAvailable()) return [];
  const rows = many<Row>(
    `
    SELECT
      t.*,
      CASE
        WHEN t.encrypted_custom_api_key IS NOT NULL THEN COALESCE(k.name, ok.name, 'Custom API key')
        ELSE COALESCE(k.name, ok.name)
      END AS api_key_name,
      COALESCE(t.beam_server_url, k.base_url, :defaultBaseUrl) AS base_url,
      COALESCE(src.count, 0) AS source_count,
      COALESCE(dst.count, 0) AS destination_count,
      COALESCE(run_counts.count, 0) AS run_count,
      last_run.status AS last_run_status,
      schedule.frequency AS frequency
    FROM transfer_templates t
    LEFT JOIN beam_api_keys k ON k.id = t.api_key_id
    LEFT JOIN organization_api_keys_cache ok ON ok.id = t.api_key_id
    LEFT JOIN (SELECT transfer_template_id, COUNT(*) AS count FROM transfer_sources GROUP BY transfer_template_id) src
      ON src.transfer_template_id = t.id
    LEFT JOIN (SELECT transfer_template_id, COUNT(*) AS count FROM transfer_destinations GROUP BY transfer_template_id) dst
      ON dst.transfer_template_id = t.id
    LEFT JOIN (SELECT transfer_template_id, COUNT(*) AS count FROM runs GROUP BY transfer_template_id) run_counts
      ON run_counts.transfer_template_id = t.id
    LEFT JOIN (
      SELECT r1.transfer_template_id, r1.status
      FROM runs r1
      INNER JOIN (
        SELECT transfer_template_id, MAX(created_at) AS created_at
        FROM runs
        GROUP BY transfer_template_id
      ) latest ON latest.transfer_template_id = r1.transfer_template_id AND latest.created_at = r1.created_at
    ) last_run ON last_run.transfer_template_id = t.id
    LEFT JOIN (
      SELECT DISTINCT ON (transfer_template_id)
        transfer_template_id, frequency
      FROM schedules
      ORDER BY transfer_template_id, updated_at DESC
    ) schedule ON schedule.transfer_template_id = t.id
    WHERE (:q = '' OR LOWER(t.name) LIKE LOWER(:likeQ) OR LOWER(COALESCE(t.description, '')) LIKE LOWER(:likeQ))
      AND (:state = 'all' OR (:state = 'enabled' AND t.enabled = 1) OR (:state = 'disabled' AND t.enabled = 0))
      AND (:organizationId = '' OR t.organization_id = :organizationId)
    ORDER BY t.updated_at DESC, t.created_at DESC
    LIMIT :limit
    `,
    {
      q: filters.q?.trim() ?? "",
      likeQ: `%${filters.q?.trim() ?? ""}%`,
      state: filters.state ?? "all",
      organizationId: organizationFilterValue(filters.organizationId),
      defaultBaseUrl: beamDefaultBaseUrl(),
      limit: Math.min(Math.max(filters.limit ?? 120, 1), 120),
    },
  );

  return rows.map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id ?? LOCAL_ORGANIZATION_ID),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    apiKeyId: String(row.api_key_id),
    apiKeyName: row.api_key_name ? String(row.api_key_name) : null,
    customApiKeyConfigured: Boolean(row.encrypted_custom_api_key),
    baseUrl: row.base_url ? String(row.base_url) : null,
    beamServerUrl: row.beam_server_url ? String(row.beam_server_url) : null,
    enabled: bool(row.enabled),
    frequency: row.frequency ? String(row.frequency) : "manual",
    sourceCount: Number(row.source_count ?? 0),
    destinationCount: Number(row.destination_count ?? 0),
    runCount: Number(row.run_count ?? 0),
    lastRunStatus: row.last_run_status ? runStatus(row.last_run_status) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export function getTransfer(
  transferId: string,
  organizationId?: string | null,
) {
  return (
    listTransfers({ organizationId }).find(
      (transfer) => transfer.id === transferId,
    ) ?? null
  );
}

export function createTransfer(input: {
  organizationId?: string | null;
  name: string;
  description?: string | null;
  apiKeyId: string;
  customApiKey?: string | null;
  beamServerUrl?: string | null;
  notificationWebhookUrl?: string | null;
  slackWebhookUrl?: string | null;
  notifyOnStart: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnCancel: boolean;
  enabled: boolean;
  frequency?: string | null;
}) {
  requireLegacyProductState(retiredTransfers);
  const timestamp = now();
  const customApiKey = input.customApiKey?.trim() ?? "";
  const transferId = id("tpl");
  const selectedApiKeyId = input.apiKeyId.trim();
  const storedApiKeyId =
    selectedApiKeyId && !isCustomApiKeyId(selectedApiKeyId)
      ? selectedApiKeyId
      : customApiKey
        ? `custom:${transferId}`
        : "";

  if (!input.name.trim() || (!storedApiKeyId && !customApiKey)) {
    throw new Error("Name and API key are required.");
  }

  const organizationId =
    organizationFilterValue(input.organizationId) ||
    (isCustomApiKeyId(storedApiKeyId)
      ? LOCAL_ORGANIZATION_ID
      : organizationIdForApiKey(storedApiKeyId));
  if (!isCustomApiKeyId(storedApiKeyId)) {
    requireApiKeyInOrganization(storedApiKeyId, input.organizationId);
  }

  db()
    .prepare(
      `
    INSERT INTO transfer_templates (
      id, organization_id, name, description, api_key_id, beam_server_url,
      encrypted_custom_api_key,
      encrypted_notification_webhook_url, encrypted_slack_webhook_url,
      notify_on_start, notify_on_success, notify_on_failure, notify_on_cancel,
      enabled, created_at, updated_at
    )
    VALUES (
      :id, :organizationId, :name, :description, :apiKeyId, :beamServerUrl,
      :encryptedCustomApiKey,
      :encryptedNotificationWebhookUrl, :encryptedSlackWebhookUrl,
      :notifyOnStart, :notifyOnSuccess, :notifyOnFailure, :notifyOnCancel,
      :enabled, :createdAt, :updatedAt
    )
  `,
    )
    .run({
      id: transferId,
      organizationId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      apiKeyId: storedApiKeyId,
      beamServerUrl: input.beamServerUrl?.trim() || null,
      encryptedCustomApiKey: customApiKey
        ? encryptString(customApiKey, vaultSecret())
        : null,
      encryptedNotificationWebhookUrl: encryptOptionalSecret(
        input.notificationWebhookUrl,
      ),
      encryptedSlackWebhookUrl: encryptOptionalSecret(input.slackWebhookUrl),
      notifyOnStart: input.notifyOnStart ? 1 : 0,
      notifyOnSuccess: input.notifyOnSuccess ? 1 : 0,
      notifyOnFailure: input.notifyOnFailure ? 1 : 0,
      notifyOnCancel: input.notifyOnCancel ? 1 : 0,
      enabled: input.enabled ? 1 : 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

  if (input.frequency?.trim() && input.frequency.trim() !== "manual") {
    createSchedule({
      organizationId,
      transferTemplateId: transferId,
      frequency: input.frequency.trim(),
      enabled: input.enabled,
    });
  }

  return transferId;
}

export function listSchedules(
  filters: { organizationId?: string | null } = {},
): ScheduleRecord[] {
  if (!legacyProductStateAvailable()) return [];
  return many<Row>(
    `
    SELECT s.*, t.name AS transfer_name
    FROM schedules s
    LEFT JOIN transfer_templates t ON t.id = s.transfer_template_id
    WHERE (:organizationId = '' OR t.organization_id = :organizationId)
    ORDER BY s.enabled DESC, s.updated_at DESC
    `,
    { organizationId: organizationFilterValue(filters.organizationId) },
  ).map((row) => ({
    id: String(row.id),
    transferTemplateId: String(row.transfer_template_id),
    transferName: row.transfer_name ? String(row.transfer_name) : null,
    frequency: String(row.frequency),
    enabled: bool(row.enabled),
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export function createSchedule(input: {
  organizationId?: string | null;
  transferTemplateId: string;
  frequency: string;
  enabled: boolean;
  nextRunAt?: string | null;
}) {
  requireLegacyProductState(retiredSchedules);
  requireTransferInOrganization(input.transferTemplateId, input.organizationId);
  const frequency = parseScheduleFrequency(input.frequency);
  if (!frequency) {
    throw new Error(`Invalid schedule frequency: ${input.frequency}`);
  }

  const timestamp = now();
  const scheduleId = id("sch");
  db()
    .prepare(
      `
    INSERT INTO schedules (
      id, transfer_template_id, frequency, enabled, next_run_at, created_at, updated_at
    )
    VALUES (:id, :transferTemplateId, :frequency, :enabled, :nextRunAt, :createdAt, :updatedAt)
  `,
    )
    .run({
      id: scheduleId,
      transferTemplateId: input.transferTemplateId,
      frequency: describeFrequency(frequency),
      enabled: input.enabled ? 1 : 0,
      nextRunAt: input.nextRunAt || null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  return scheduleId;
}

export function listRuns(
  filters: {
    transferId?: string;
    status?: string;
    organizationId?: string | null;
    limit?: number;
  } = {},
): RunRecord[] {
  if (!legacyProductStateAvailable()) return [];
  return many<Row>(
    `
    SELECT r.*, t.name AS transfer_name
    FROM runs r
    LEFT JOIN transfer_templates t ON t.id = r.transfer_template_id
    WHERE (:transferId = '' OR r.transfer_template_id = :transferId)
      AND (:status = 'all' OR r.status = :status)
      AND (:organizationId = '' OR t.organization_id = :organizationId)
    ORDER BY r.created_at DESC
    LIMIT :limit
    `,
    {
      transferId: filters.transferId ?? "",
      status: filters.status ?? "all",
      organizationId: organizationFilterValue(filters.organizationId),
      limit: Math.min(Math.max(filters.limit ?? 120, 1), 120),
    },
  ).map((row) => ({
    id: String(row.id),
    transferTemplateId: String(row.transfer_template_id),
    transferName: row.transfer_name ? String(row.transfer_name) : null,
    status: runStatus(row.status),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    updatedAt: row.updated_at ? String(row.updated_at) : null,
    queuedAt: row.queued_at ? String(row.queued_at) : null,
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    beamTransferId: row.beam_transfer_id ? String(row.beam_transfer_id) : null,
    trigger: String(row.trigger ?? "manual"),
  }));
}

export function getRun(runId: string, organizationId?: string | null) {
  const run =
    listRuns({ organizationId }).find((item) => item.id === runId) ?? null;
  if (!run) {
    return null;
  }

  const transfers = many<Row>(
    "SELECT * FROM run_transfers WHERE run_id = :id ORDER BY created_at",
    { id: runId },
  ).map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    sourceName: row.source_name ? String(row.source_name) : null,
    destinationName: row.destination_name ? String(row.destination_name) : null,
    status: String(row.status),
    beamTransferId: row.beam_transfer_id ? String(row.beam_transfer_id) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
  }));
  const logs = many<Row>(
    `
    SELECT id, event, payload, created_at, level, worker_id
    FROM execution_logs
    WHERE run_id = :id
    ORDER BY created_at DESC
    LIMIT 40
    `,
    { id: runId },
  ).map((row) => ({
    id: String(row.id),
    event: String(row.event),
    payload: String(row.payload),
    createdAt: String(row.created_at),
    level: String(row.level ?? "info"),
    workerId: row.worker_id ? String(row.worker_id) : null,
  }));

  return { run, transfers, logs };
}

export function getRunByBeamTransferId(
  beamTransferId: string,
  organizationId?: string | null,
) {
  if (!legacyProductStateAvailable()) return null;
  const row = one<Row>(
    `
    SELECT DISTINCT r.id, r.created_at
    FROM runs r
    LEFT JOIN transfer_templates t ON t.id = r.transfer_template_id
    LEFT JOIN run_transfers rt ON rt.run_id = r.id
    WHERE (r.beam_transfer_id = :beamTransferId OR rt.beam_transfer_id = :beamTransferId)
      AND (:organizationId = '' OR t.organization_id = :organizationId)
    ORDER BY r.created_at DESC
    LIMIT 1
    `,
    {
      beamTransferId,
      organizationId: organizationFilterValue(organizationId),
    },
  );
  return row ? getRun(String(row.id), organizationId) : null;
}

export function startRun(transferId: string, organizationId?: string | null) {
  requireLegacyProductState(retiredRuns);
  const transfer = getTransfer(transferId, organizationId);
  if (!transfer) {
    throw new Error("Transfer template not found.");
  }

  const timestamp = now();
  const runId = id("run");
  const database = db();
  database.exec("BEGIN");
  try {
    database
      .prepare(
        `
      INSERT INTO runs (
        id, transfer_template_id, status, started_at, completed_at, error,
        created_at, updated_at, queued_at, next_attempt_at, attempts, max_attempts,
        trigger, idempotency_key
      )
      VALUES (
        :id, :transferTemplateId, 'queued', NULL, NULL, NULL,
        :createdAt, :updatedAt, :queuedAt, :nextAttemptAt, 0, :maxAttempts,
        'manual', :idempotencyKey
      )
    `,
      )
      .run({
        id: runId,
        transferTemplateId: transferId,
        createdAt: timestamp,
        updatedAt: timestamp,
        queuedAt: timestamp,
        nextAttemptAt: timestamp,
        maxAttempts: maxRunAttempts(),
        idempotencyKey: `run:${runId}`,
      });
    appendExecutionLog(
      runId,
      "run_queued",
      {
        trigger: "manual",
        transferTemplateId: transferId,
        transferName: transfer.name,
        sourceCount: transfer.sourceCount,
        destinationCount: transfer.destinationCount,
      },
      database,
    );

    database.exec("COMMIT");
    return runId;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function cancelRun(runId: string, organizationId?: string | null) {
  requireLegacyProductState(retiredRuns);
  const timestamp = now();
  const database = db();
  const row = database
    .prepare(
      `
    SELECT r.status
    FROM runs r
    LEFT JOIN transfer_templates t ON t.id = r.transfer_template_id
    WHERE r.id = :id
      AND (:organizationId = '' OR t.organization_id = :organizationId)
  `,
    )
    .get({
      id: runId,
      organizationId: organizationFilterValue(organizationId),
    }) as Row | undefined;
  if (!row) {
    throw new Error("Run not found.");
  }

  if (["queued", "running"].includes(String(row.status))) {
    database
      .prepare(
        `
      UPDATE runs
      SET status = 'cancelled',
          completed_at = COALESCE(completed_at, :completedAt),
          updated_at = :updatedAt,
          error = COALESCE(error, 'cancellation requested')
      WHERE id = :id AND status IN ('queued', 'running')
    `,
      )
      .run({ id: runId, completedAt: timestamp, updatedAt: timestamp });
    appendExecutionLog(runId, "run_cancelled", {
      runId,
      reason: "cancelled_by_user",
    });
  }

  appendExecutionLog(runId, "run_cancelled", { runId });
  return getRun(runId, organizationId);
}
