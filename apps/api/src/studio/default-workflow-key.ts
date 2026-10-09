import { pgMany, type PgClient, type PgPool } from "@beam-studio/db";
import type { BeamEnvironmentTemplate } from "@beam-studio/shared";

type Candidate = { id: string; metadata: Record<string, unknown> };

export function keyMatchesEnvironment(
  metadata: Record<string, unknown>,
  template: BeamEnvironmentTemplate,
  defaultBaseUrl: string,
): boolean {
  const environment = metadata.environment;
  if (
    ["prod", "dev"].includes(template.key) &&
    environment &&
    environment !== template.key
  )
    return false;
  const baseUrl = metadata.baseUrl ?? metadata.base_url ?? defaultBaseUrl;
  const natsUrl = metadata.natsUrl ?? metadata.nats_url;
  try {
    return (
      typeof baseUrl === "string" &&
      new URL(baseUrl).origin === new URL(template.baseUrl).origin &&
      (!natsUrl || natsUrl === template.natsUrl)
    );
  } catch {
    return false;
  }
}

/**
 * The instance key comes first: Studio holds it for the owner organization, so
 * it is the key new workflows, room control, organization-level checks and the
 * settlement fallback use. Then organization-wide keys precede project keys;
 * age and id make the default stable.
 */
export async function defaultWorkflowKeyPg(
  client: PgClient | PgPool,
  input: {
    organizationId: string;
    projectId?: string | null;
    template: BeamEnvironmentTemplate;
    defaultBaseUrl: string;
  },
): Promise<string | null> {
  const candidates = await pgMany<Candidate>(
    client,
    `
    SELECT c.id, c.metadata_json AS metadata
    FROM secrets.credentials c
    JOIN secrets.credential_types ct ON ct.id=c.credential_type_id
    WHERE c.organization_id=$1 AND ct.slug='beam_api_key'
      AND (c.project_id IS NULL OR c.project_id=$2)
      AND c.status='active' AND (c.expires_at IS NULL OR c.expires_at>now())
      AND EXISTS (SELECT 1 FROM secrets.credential_versions v
        WHERE v.credential_id=c.id AND v.status='active' AND v.revoked_at IS NULL)
    ORDER BY COALESCE(c.external_source = 'beam_studio_instance', false) DESC,
      (c.project_id IS NOT NULL), c.created_at, c.id
  `,
    [input.organizationId, input.projectId ?? null],
  );
  return (
    candidates.find((key) =>
      keyMatchesEnvironment(key.metadata, input.template, input.defaultBaseUrl),
    )?.id ?? null
  );
}
