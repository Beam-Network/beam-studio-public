import type { WorkflowReferences } from "@beam-studio/shared";
import type { PgClient, PgPool } from "./postgres.js";
import { WorkflowAuthorizationError } from "./workflow-authorization.js";

/** References record intent, never a grant or a copy of a credential payload. */
export async function assertWorkflowReferencesAvailablePg(
  client: PgClient | PgPool,
  references: WorkflowReferences,
  organizationId: string,
  projectId: string | null,
) {
  const agents = Object.values(references.agentBindings).map(
    (value) => value.agentId,
  );
  const credentials = Object.values(references.resourceBindings).flatMap(
    (value) =>
      value.kind === "credential"
        ? [value.credentialId]
        : value.kind === "storage"
          ? [value.endpoint.credentialId]
          : [],
  );
  if (!agents.length && !credentials.length) return;
  const result = await client.query<{ kind: string; id: string }>(
    `SELECT 'agent' AS kind,id FROM agent_control.agents WHERE id=ANY($1::text[]) AND organization_id=$3
      AND revoked_at IS NULL AND status<>'revoked' AND (project_id IS NULL OR project_id=$4)
    UNION ALL
    SELECT 'credential',id FROM secrets.credentials c WHERE id=ANY($2::text[]) AND organization_id=$3
      AND status='active' AND (expires_at IS NULL OR expires_at>now()) AND (project_id IS NULL OR project_id=$4)
      AND EXISTS(SELECT 1 FROM secrets.credential_versions v WHERE v.credential_id=c.id AND v.status='active' AND v.revoked_at IS NULL)`,
    [agents, credentials, organizationId, projectId],
  );
  const valid = new Set(result.rows.map((row) => `${row.kind}:${row.id}`));
  for (const [name, value] of Object.entries(references.agentBindings))
    if (!valid.has(`agent:${value.agentId}`))
      throw new WorkflowAuthorizationError(
        "execution_agent_reference_unavailable",
        `Managed agent binding ${name} is missing, revoked, or outside this organization/project.`,
      );
  for (const [name, value] of Object.entries(references.resourceBindings)) {
    const id =
      value.kind === "credential"
        ? value.credentialId
        : value.kind === "storage"
          ? value.endpoint.credentialId
          : null;
    if (id && !valid.has(`credential:${id}`))
      throw new WorkflowAuthorizationError(
        "execution_resource_reference_unavailable",
        `Resource binding ${name} references a missing, expired, revoked, or out-of-scope credential.`,
      );
  }
}
