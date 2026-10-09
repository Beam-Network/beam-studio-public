import type { PgClient } from "./postgres.js";

export async function prepareFixtureAdmissionPg(
  _client: Pick<PgClient, "query">,
  _organizationId: string,
  _workflowTemplateId: string,
): Promise<void> {}

export async function referenceFixtureGenerationsPg(
  _client: Pick<PgClient, "query">,
  _workflowRunId: string,
  _run: Record<string, unknown>,
): Promise<void> {}

export async function countFixtureAdmissionPg(
  _client: Pick<PgClient, "query">,
  _workflowRunId: string,
  _workflowTemplateId: string,
): Promise<void> {}

export async function fixtureCampaignsUsingWorkflowPg(
  _client: Pick<PgClient, "query">,
  _workflowId: string,
): Promise<string[]> {
  return [];
}
