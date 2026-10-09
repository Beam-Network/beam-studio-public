import {
  beamConnectionDefaults,
  type FrozenExecutionConfiguration,
} from "@beam-studio/core";
import { builtinBeamEnvironmentTemplates } from "@beam-studio/shared";
import type { PgClient } from "./postgres.js";

/** Called only for a new root. Children and retries keep the parent's snapshot. */
export async function captureWorkflowExecutionConfigurationPg(
  client: PgClient,
  input: {
    organizationId: string;
    projectIds: string[];
    billingCredentialId: string | null;
  },
): Promise<FrozenExecutionConfiguration> {
  const environment = process.env.BEAM_ENV?.trim() || "prod";
  const builtin =
    builtinBeamEnvironmentTemplates[environment === "dev" ? "dev" : "prod"];
  const defaults = beamConnectionDefaults({
    baseUrl: process.env.BEAM_DEFAULT_BASE_URL ?? builtin.baseUrl,
    natsUrl: process.env.BEAM_DEFAULT_NATS_URL ?? builtin.natsUrl,
    environment,
  });
  const rows = await client.query<{ id: string; metadata: unknown }>(
    `SELECT c.id,CASE WHEN ct.slug='beam_api_key' OR c.id=$3 THEN jsonb_build_object('baseUrl',COALESCE(c.metadata_json->>'baseUrl',c.metadata_json->>'base_url'),
      'natsUrl',COALESCE(c.metadata_json->>'natsUrl',c.metadata_json->>'nats_url'),'environment',c.metadata_json->>'environment') END AS metadata
    FROM secrets.credentials c JOIN secrets.credential_types ct ON ct.id=c.credential_type_id
    WHERE c.organization_id=$1 AND (c.project_id IS NULL OR c.project_id=ANY($2::text[]))
    AND c.status='active' AND (c.expires_at IS NULL OR c.expires_at>now()) ORDER BY c.id`,
    [input.organizationId, input.projectIds, input.billingCredentialId],
  );
  const credentials = Object.fromEntries(
    rows.rows
      .filter((row) => row.metadata)
      .map((row) => [row.id, beamConnectionDefaults(row.metadata)]),
  );
  return {
    environment:
      credentials[input.billingCredentialId ?? ""]?.environment ?? environment,
    beam: {
      defaults,
      credentials,
      knownCredentialIds: rows.rows.map((row) => row.id),
    },
  };
}
