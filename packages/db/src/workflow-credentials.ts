import { randomUUID } from "node:crypto";
import type { ActionManifest, ActionJson } from "@beam-studio/core";
import { normalizeCredentialPayloadAliases } from "@beam-studio/shared";
import { decryptString, vaultSecretFromEnv } from "@beam-studio/vault";
import { pgOne, withPostgresTransaction, type PgPool } from "./postgres.js";
type Row = Record<string, unknown>;
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const objectValue = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};

type CredentialSecretAuditContext = {
  organizationId: string;
  workflowRunId: string;
  workflowStepRunId: string;
  packageName: string;
  packageVersion: string;
  manifest: ActionManifest;
  config: Record<string, ActionJson>;
  inputs: Record<string, ActionJson>;
};

export function credentialSecretReaderPg(
  pool: PgPool,
  context: CredentialSecretAuditContext,
) {
  return (credentialId: string) =>
    credentialSecretPg(pool, context, credentialId);
}

async function credentialSecretPg(
  pool: PgPool,
  context: CredentialSecretAuditContext,
  credentialId: string,
) {
  const requirements = credentialRequirementsForId(context, credentialId);
  if (!requirements.length) {
    throw new Error(
      `Credential "${credentialId}" is not declared by the action manifest for this step.`,
    );
  }
  const snapshot = await withPostgresTransaction(pool, async (client) => {
    const requirementRows: Array<{ id: string; key: string }> = [];
    for (const requirement of requirements) {
      const row = await pgOne<Row>(
        client,
        `
        INSERT INTO actions.credential_requirements (
          id, package_version_id, requirement_key, display_name, description,
          required, cardinality, purpose, config_path, permissions_json,
          metadata_json
        )
        SELECT
          $1, apv.id, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '{}'::jsonb
        FROM actions.package_versions apv
        JOIN actions.packages ap ON ap.id = apv.package_id
        WHERE ap.package_name = $10 AND apv.version = $11
        ON CONFLICT (package_version_id, requirement_key) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            description = EXCLUDED.description,
            required = EXCLUDED.required,
            cardinality = EXCLUDED.cardinality,
            purpose = EXCLUDED.purpose,
            config_path = EXCLUDED.config_path,
            permissions_json = EXCLUDED.permissions_json,
            updated_at = now()
        RETURNING id
        `,
        [
          id("acr"),
          requirement.key,
          requirement.displayName,
          requirement.description ?? null,
          requirement.required,
          requirement.cardinality,
          requirement.purpose ?? null,
          requirement.configPaths.join(","),
          JSON.stringify(requirement.permissions ?? []),
          context.packageName,
          context.packageVersion,
        ],
      );
      if (!row) {
        throw new Error(
          `Action package ${context.packageName}@${context.packageVersion} is missing from the Studio registry.`,
        );
      }
      requirementRows.push({ id: String(row.id), key: requirement.key });
    }

    const priorUse = await pgOne<Row>(
      client,
      `
      SELECT credential_version_id
      FROM execution.workflow_step_credential_uses
      WHERE workflow_step_run_id = $1 AND credential_id = $2
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [context.workflowStepRunId, credentialId],
    );
    const credential = await pgOne<Row>(
      client,
      `
      SELECT
        cv.id AS credential_version_id,
        cv.version AS credential_version,
        cv.encrypted_payload,
        ct.slug AS credential_type,
        pp.driver AS credential_provider
      FROM secrets.credentials c
      JOIN secrets.credential_versions cv ON cv.credential_id = c.id
      JOIN secrets.credential_types ct ON ct.id = c.credential_type_id
      LEFT JOIN secrets.provider_profiles pp ON pp.id = c.provider_profile_id
      WHERE c.id = $1
        AND c.organization_id = $2
        AND c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at>now())
        AND cv.status IN ('active','superseded') AND cv.revoked_at IS NULL
        AND (
          ($3::text IS NOT NULL AND cv.id = $3)
          OR ($3::text IS NULL AND c.status = 'active' AND cv.status = 'active')
        )
      ORDER BY cv.version DESC
      LIMIT 1
      FOR SHARE OF cv
      `,
      [
        credentialId,
        context.organizationId,
        priorUse?.credential_version_id ?? null,
      ],
    );
    if (!credential) {
      return null;
    }
    const metadata = {
      credentialType: String(credential.credential_type),
      provider: credential.credential_provider
        ? String(credential.credential_provider)
        : null,
      version: Number(credential.credential_version),
    };
    for (const requirement of requirementRows) {
      await client.query(
        `
        INSERT INTO execution.workflow_step_credential_uses (
          id, workflow_run_id, workflow_step_run_id, credential_id,
          credential_version_id, credential_requirement_id, requirement_key,
          credential_snapshot_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (
          workflow_step_run_id, credential_requirement_id, credential_id
        ) DO NOTHING
        `,
        [
          id("wscu"),
          context.workflowRunId,
          context.workflowStepRunId,
          credentialId,
          String(credential.credential_version_id),
          requirement.id,
          requirement.key,
          JSON.stringify(metadata),
        ],
      );
    }
    return {
      encryptedPayload: String(credential.encrypted_payload),
    };
  });
  if (!snapshot) {
    return null;
  }
  const payload = normalizeCredentialPayloadAliases(
    JSON.parse(
      decryptString(snapshot.encryptedPayload, vaultSecretFromEnv()),
    ) as Row,
  );
  return JSON.stringify(payload);
}

function credentialRequirementsForId(
  context: CredentialSecretAuditContext,
  credentialId: string,
) {
  const root = { config: context.config, inputs: context.inputs };
  return (context.manifest.catalog?.credentialRequirements ?? []).filter(
    (requirement) =>
      requirement.configPaths.some((configPath) =>
        valuesAtConfigPath(root, configPath).some(
          (value) => String(value ?? "") === credentialId,
        ),
      ),
  );
}

function valuesAtConfigPath(root: Row, configPath: string): unknown[] {
  let values: unknown[] = [root];
  for (const rawSegment of configPath.split(".")) {
    const wildcard = rawSegment.endsWith("[*]");
    const segment = wildcard ? rawSegment.slice(0, -3) : rawSegment;
    values = values.flatMap((value) => {
      const nested = objectValue(value)[segment];
      if (wildcard) {
        return Array.isArray(nested) ? nested : [];
      }
      return nested === undefined ? [] : [nested];
    });
  }
  return values;
}
