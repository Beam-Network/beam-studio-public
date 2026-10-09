import type { PgPool } from "@beam-studio/db";
import {
  roomTransferActionVersion,
  roomWorkflowConfigSchema,
} from "@beam-studio/shared";
import {
  installPublicRegistryPackage,
  resolveBeamEnvironmentTemplate,
} from "../studio/store.js";
import { roomServiceForOrganization } from "./room-service.js";

type Row = Record<string, any>;

type Migration = {
  stepId: string;
  workflowId: string;
  previousConfig: Row;
  config: Row;
  configChanged: boolean;
};

export type RoomTransferActionState = {
  /** True when this call installed the action rather than finding it present. */
  installed: boolean;
  /** Whether the action is usable now, whatever happened above. */
  available: boolean;
  /** Why it is unavailable, for logs and for the operator reading the UI. */
  reason?: string;
};

/**
 * Makes the room-transfer action available, reporting failure rather than
 * raising it.
 *
 * This runs before the HTTP server starts. Raising here used to end the
 * process, so an action release missing from the Registry took the whole of
 * Studio down — not just room transfers — with no error surface. The Registry
 * is an external service and its contents are not a precondition for serving
 * credentials, workflows, runs or anything else.
 */
export async function ensureRoomTransferActionV2Installed(
  pool: PgPool,
  install: () => Promise<unknown> = () =>
    installPublicRegistryPackage({
      packageName: "@beam/room-transfer",
      range: roomTransferActionVersion,
    }),
): Promise<RoomTransferActionState> {
  if (await hasRoomTransferActionV2(pool)) {
    return { installed: false, available: true };
  }

  try {
    await install();
  } catch (error) {
    return {
      installed: false,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!(await hasRoomTransferActionV2(pool))) {
    return {
      installed: false,
      available: false,
      reason: "room_transfer_v2_action_install_failed",
    };
  }
  return { installed: true, available: true };
}

/**
 * Whether the installed manifest still speaks the template-only contract.
 *
 * A release carrying the retired `environment` / `coordinatorUrl` fields
 * installs perfectly well and then fails per step in `assertActionConfig`,
 * after a run has been created and billed. Checking the stored manifest turns
 * that into the same reported-unavailable state as a missing release.
 */
export async function roomTransferActionContractMismatch(pool: PgPool) {
  const result = await pool.query<Row>(
    `SELECT version.manifest_json
     FROM actions.package_versions version
     JOIN actions.packages package ON package.id=version.package_id
     WHERE package.package_name='@beam/room-transfer'
       AND version.version=$1
     LIMIT 1`,
    [roomTransferActionVersion],
  );
  const manifest = result.rows[0]?.manifest_json;
  const schema = manifest?.configSchema;
  if (!schema) return "room_transfer_action_manifest_missing_config_schema";

  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!required.includes("environmentTemplateKey")) {
    return "room_transfer_action_manifest_missing_environment_template_key";
  }
  const properties = schema.properties ?? {};
  for (const retired of ["environment", "coordinatorUrl"]) {
    if (Object.hasOwn(properties, retired)) {
      return `room_transfer_action_manifest_has_retired_${retired}`;
    }
  }
  return null;
}

export async function migrateRoomTransferWorkflowsV2(pool: PgPool) {
  const result = await pool.query<Row>(
    `SELECT step.id, step.workflow_template_id, step.action_version_range,
            step.config_json, template.organization_id
     FROM workflow.steps step
     JOIN workflow.templates template ON template.id=step.workflow_template_id
     WHERE step.action_package_name='@beam/room-transfer'
       AND step.retired_at IS NULL
     ORDER BY step.workflow_template_id, step.id`,
  );
  const pending = result.rows.filter((row) => {
    const parsed = roomWorkflowConfigSchema.safeParse(object(row.config_json));
    return (
      !parsed.success ||
      String(row.action_version_range) !== roomTransferActionVersion
    );
  });
  if (!pending.length)
    return {
      migrated: 0,
      workflowIds: [] as string[],
      deferredWorkflowIds: [] as string[],
    };

  const pendingWorkflowIds = [
    ...new Set(pending.map((row) => String(row.workflow_template_id))),
  ];
  const active = await pool.query<Row>(
    `SELECT id, workflow_template_id FROM execution.workflow_runs
     WHERE workflow_template_id=ANY($1::text[])
       AND status IN ('queued','running','cancel_requested')`,
    [pendingWorkflowIds],
  );
  const activeWorkflowIds = new Set(
    active.rows.map((row) => String(row.workflow_template_id)),
  );
  // Frozen active executions keep their installed action and config. Blocking
  // API startup here would also block the cancellation reconciler that can
  // make those executions terminal, so defer only their templates.
  const deferredWorkflowIds = pendingWorkflowIds.filter((workflowId) =>
    activeWorkflowIds.has(workflowId),
  );
  const migratable = pending.filter(
    (row) => !activeWorkflowIds.has(String(row.workflow_template_id)),
  );
  if (!migratable.length)
    return { migrated: 0, workflowIds: [] as string[], deferredWorkflowIds };
  const workflowIds = [
    ...new Set(migratable.map((row) => String(row.workflow_template_id))),
  ];

  const migrations: Migration[] = [];
  const failures: string[] = [];
  for (const row of migratable) {
    const previous = object(row.config_json);
    const current = roomWorkflowConfigSchema.safeParse(previous);
    if (current.success) {
      migrations.push({
        stepId: String(row.id),
        workflowId: String(row.workflow_template_id),
        previousConfig: previous,
        config: previous,
        configChanged: false,
      });
      continue;
    }
    try {
      const templateKey = required(previous.environmentTemplateKey);
      const roomId = required(previous.roomId);
      const sourceAgentId = required(previous.sourceAgentId);
      const sourcePath = required(previous.sourcePath);
      const template = await resolveBeamEnvironmentTemplate({
        organizationId: String(row.organization_id),
        templateKey,
      });
      const service = await roomServiceForOrganization(String(row.organization_id), template);
      const snapshot = await service.client.organizationRoomSnapshot(
        String(row.organization_id),
        roomId,
        service.token,
      );
      const source = array(snapshot.memberships).find(
        (member) =>
          String(member.agent_id ?? "") === sourceAgentId &&
          String(member.state ?? "") === "active" &&
          ["", "agent"].includes(String(member.kind ?? "")),
      );
      if (!source?.member_id) throw new Error("source_member_unresolved");
      const config = roomWorkflowConfigSchema.parse({
        environmentTemplateKey: templateKey,
        roomId,
        channelId: required(previous.channelId),
        source: {
          memberId: String(source.member_id),
          locator: { type: "agent_path", path: sourcePath },
        },
        targetMemberIds: stringArray(previous.targetMemberIds),
        ttlSeconds: Number(previous.ttlSeconds ?? 300),
        allowPartial: previous.allowPartial === true,
      });
      migrations.push({
        stepId: String(row.id),
        workflowId: String(row.workflow_template_id),
        previousConfig: previous,
        config,
        configChanged: true,
      });
    } catch {
      failures.push(String(row.workflow_template_id));
    }
  }
  if (failures.length) {
    throw new Error(
      `room_transfer_v2_source_unresolved:${[...new Set(failures)].join(",")}`,
    );
  }

  const version = await pool.query<Row>(
    `SELECT version.*, package.metadata_json, package.trust_level AS package_trust_level
     FROM actions.package_versions version
     JOIN actions.packages package ON package.id=version.package_id
     WHERE package.package_name='@beam/room-transfer'
       AND version.version=$1
       AND version.status IN ('active','deprecated')
     LIMIT 1`,
    [roomTransferActionVersion],
  );
  const action = version.rows[0];
  if (!action) throw new Error("room_transfer_v2_action_not_installed");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM workflow.steps WHERE id=ANY($1::text[]) FOR UPDATE",
      [migrations.map((migration) => migration.stepId)],
    );
    for (const migration of migrations) {
      const updated = migration.configChanged
        ? await client.query(
            `UPDATE workflow.steps
             SET config_json=$2::jsonb, action_version_range=$4, updated_at=now()
             WHERE id=$1 AND config_json=$3::jsonb`,
            [
              migration.stepId,
              JSON.stringify(migration.config),
              JSON.stringify(migration.previousConfig),
              roomTransferActionVersion,
            ],
          )
        : await client.query(
            `UPDATE workflow.steps
             SET action_version_range=$2, updated_at=now()
             WHERE id=$1 AND config_json=$3::jsonb`,
            [
              migration.stepId,
              roomTransferActionVersion,
              JSON.stringify(migration.previousConfig),
            ],
          );
      if (updated.rowCount !== 1) {
        throw new Error(
          `room_transfer_v2_concurrent_edit:${migration.workflowId}`,
        );
      }
    }
    const provenance = object(action.provenance_json);
    const metadata = object(action.metadata_json);
    for (const workflowId of workflowIds) {
      const updated = await client.query(
        `UPDATE workflow.action_locks
         SET version_range=$8, resolved_version=$8, package_version_id=$2,
             checksum=$3, artifact_checksum=$4, artifact_reference=$5,
             source_registry=$6, trust_level=$7, created_at=now()
         WHERE workflow_template_id=$1
           AND action_package_name='@beam/room-transfer'`,
        [
          workflowId,
          action.id,
          action.manifest_checksum,
          action.artifact_checksum,
          text(provenance.artifactReference) ||
            text(provenance.registryArtifactUrl) ||
            (action.hippius_bucket && action.hippius_key
              ? `s3://${action.hippius_bucket}/${String(action.hippius_key).replace(/^\/+/, "")}`
              : null),
          text(provenance.source) || text(metadata.source) || "local-registry",
          text(provenance.registryTrustLevel) ||
            text(action.package_trust_level) ||
            null,
          roomTransferActionVersion,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`room_transfer_v2_lock_unresolved:${workflowId}`);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { migrated: migrations.length, workflowIds, deferredWorkflowIds };
}

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function array(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function required(value: unknown) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error("required_value_missing");
  return result;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function hasRoomTransferActionV2(pool: PgPool) {
  const result = await pool.query(
    `SELECT 1
     FROM actions.package_versions version
     JOIN actions.packages package ON package.id=version.package_id
     WHERE package.package_name='@beam/room-transfer'
       AND version.version=$1
       AND version.status IN ('active','deprecated')
     LIMIT 1`,
    [roomTransferActionVersion],
  );
  return result.rows.length === 1;
}
