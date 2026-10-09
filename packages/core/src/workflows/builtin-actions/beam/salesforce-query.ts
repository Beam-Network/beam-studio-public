import type { ActionExecute, ActionJson } from "../../actions.js";
import { salesforceSession } from "./salesforce/auth.js";
import {
  awaitJob,
  createQueryJob,
  fetchQueryResults,
} from "./salesforce/bulk.js";
import { requireText, str } from "./salesforce/http.js";
import { beamActionManifest } from "./manifest.js";

export const salesforceQueryActionManifest = beamActionManifest({
  name: "@beam/salesforce-query",
  displayName: "Salesforce query",
  description:
    "Runs a SOQL query as a Bulk API 2.0 job and publishes the rows as a CSV artifact.",
  configSchema: {
    type: "object",
    required: ["credentialId", "soql"],
    additionalProperties: false,
    properties: {
      credentialId: { type: "string", title: "Salesforce credential" },
      soql: {
        type: "string",
        title: "SOQL query",
        description: "For example: SELECT Id, Name FROM Account",
      },
      name: {
        type: "string",
        title: "Artifact name",
        description: "Defaults to salesforce-query.csv.",
      },
      maxRecordsPerPage: { type: "number", title: "Records per result page" },
      timeoutSeconds: { type: "number", title: "Job wait budget" },
    },
  },
  inputs: {
    credentialId: { type: "string" },
    soql: { type: "string" },
  },
  outputs: {
    artifact: { type: "object" },
    content: { type: "string" },
    recordCount: { type: "number" },
    jobId: { type: "string" },
  },
  permissions: ["network:https", "secrets:read", "storage:write"],
  catalog: {
    category: "crm",
    maturity: "experimental",
    tags: ["salesforce", "crm", "query", "soql", "bulk"],
    credentialRequirements: [
      {
        key: "salesforce",
        displayName: "Salesforce credentials",
        required: true,
        cardinality: "one",
        purpose: "crm-read",
        acceptedCredentialTypes: ["salesforce_client_credentials", "salesforce_jwt"],
        configPaths: ["config.credentialId", "inputs.credentialId"],
        permissions: ["secrets:read"],
      },
    ],
  },
});

const salesforceQueryExecute: ActionExecute = async (
  { config, inputs },
  context,
) => {
  const credentialId = requireText(
    inputs.credentialId ?? config.credentialId,
    "A Salesforce credential",
  );
  const soql = requireText(inputs.soql ?? config.soql, "A SOQL query");
  const session = await salesforceSession(context, credentialId);

  // Reattach to a job this step already created. A query job is read-only, so
  // re-running one is harmless, but reattaching avoids paying for it twice.
  const previous = str(context.state.get().jobId);
  const jobId =
    previous || (await createQueryJob(session, soql)).id;
  if (!previous) {
    await context.state.patch({ jobId });
    context.logger.info("Salesforce query job created", { jobId });
  } else {
    context.logger.info("Resuming Salesforce query job", { jobId });
  }

  await awaitJob(session, "query", jobId, {
    timeoutMs: numberValue(config.timeoutSeconds) * 1000 || undefined,
  });

  const { csv, pages } = await fetchQueryResults(session, jobId, {
    maxRecordsPerPage: numberValue(config.maxRecordsPerPage) || undefined,
  });

  const name = str(config.name) || "salesforce-query.csv";
  const recordCount = countDataRows(csv);
  const artifact = await context.artifacts.publish({
    name,
    type: "dataset",
    // The worker rewrites a memory:// artifact to a served URL using the
    // matching string output; see workerFileArtifacts.inferArtifactContent.
    uri: `memory://salesforce/${encodeURIComponent(name)}`,
    mediaType: "text/csv",
    metadata: { jobId, recordCount, pages },
  });

  return {
    outputs: {
      artifact: artifact as unknown as ActionJson,
      content: csv,
      recordCount,
      jobId,
    },
    externalRef: jobId,
    artifacts: [artifact],
  };
};

export const salesforceQueryAction = {
  manifest: salesforceQueryActionManifest,
  execute: salesforceQueryExecute,
};

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Row count excluding the header, tolerating a trailing newline. */
export function countDataRows(csv: string) {
  const trimmed = csv.replace(/\r?\n$/, "");
  if (!trimmed) {
    return 0;
  }
  const lines = trimmed.split("\n").length;
  return Math.max(0, lines - 1);
}
