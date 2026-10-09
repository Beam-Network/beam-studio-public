import {
  ActionInputError,
  type ActionExecute,
  type ActionJson,
} from "../../actions.js";
import { salesforceSession } from "./salesforce/auth.js";
import {
  assertJobSucceeded,
  awaitJob,
  createIngestJob,
  fetchFailedResults,
  getJob,
  isTerminal,
  uploadIngestData,
} from "./salesforce/bulk.js";
import { requireText, str } from "./salesforce/http.js";
import { beamActionManifest } from "./manifest.js";

const OPERATIONS = ["insert", "update", "upsert", "delete", "hardDelete"];

export const salesforceUpsertActionManifest = beamActionManifest({
  name: "@beam/salesforce-upsert",
  displayName: "Salesforce upsert",
  description:
    "Inserts, updates, upserts, or deletes Salesforce records from a CSV artifact using Bulk API 2.0.",
  configSchema: {
    type: "object",
    required: ["credentialId", "object", "operation"],
    additionalProperties: false,
    properties: {
      credentialId: { type: "string", title: "Salesforce credential" },
      object: { type: "string", title: "sObject", description: "For example: Account" },
      operation: {
        type: "string",
        title: "Operation",
        enum: OPERATIONS,
        default: "upsert",
      },
      externalIdField: {
        type: "string",
        title: "External ID field",
        description: "Required for upsert. The CSV must contain this column.",
      },
      timeoutSeconds: { type: "number", title: "Job wait budget" },
    },
  },
  inputs: {
    credentialId: { type: "string" },
    artifact: { type: "object" },
    content: { type: "string" },
  },
  outputs: {
    jobId: { type: "string" },
    processed: { type: "number" },
    failed: { type: "number" },
    failedArtifact: { type: "object" },
  },
  permissions: ["network:https", "secrets:read", "storage:read", "storage:write"],
  catalog: {
    category: "crm",
    maturity: "experimental",
    tags: ["salesforce", "crm", "upsert", "bulk", "write"],
    credentialRequirements: [
      {
        key: "salesforce",
        displayName: "Salesforce credentials",
        required: true,
        cardinality: "one",
        purpose: "crm-write",
        acceptedCredentialTypes: ["salesforce_client_credentials", "salesforce_jwt"],
        configPaths: ["config.credentialId", "inputs.credentialId"],
        permissions: ["secrets:read"],
      },
    ],
  },
});

const salesforceUpsertExecute: ActionExecute = async (
  { config, inputs },
  context,
) => {
  const credentialId = requireText(
    inputs.credentialId ?? config.credentialId,
    "A Salesforce credential",
  );
  const object = requireText(config.object, "An sObject name");
  const operation = str(config.operation) || "upsert";
  if (!OPERATIONS.includes(operation)) {
    throw new ActionInputError(
      `Operation "${operation}" must be one of ${OPERATIONS.join(", ")}.`,
    );
  }
  const externalIdField = str(config.externalIdField);
  if (operation === "upsert" && !externalIdField) {
    throw new ActionInputError(
      "An upsert requires an external ID field naming the column to match on.",
    );
  }

  const session = await salesforceSession(context, credentialId);
  const timeoutMs = numberValue(config.timeoutSeconds) * 1000 || undefined;

  /*
   * Resumability is the whole point of this block.
   *
   * A job that already exists has already had its rows accepted by Salesforce.
   * Creating a second one would write every record twice, so a retry reattaches
   * and waits rather than re-uploading. The id is persisted immediately after
   * creation and before the upload, which is the only ordering where a crash
   * cannot orphan a job we do not know about.
   */
  const existingJobId = str(context.state.get().jobId);
  let jobId = existingJobId;

  if (existingJobId) {
    context.logger.info("Reattaching to an existing Salesforce ingest job", {
      jobId: existingJobId,
    });
    const job = await getJob(session, "ingest", existingJobId);
    if (isTerminal(job.state)) {
      // A resumed job that failed must surface as a failure, not as a
      // successful load with zero records.
      return summarize(
        context,
        session,
        assertJobSucceeded(job, existingJobId),
        existingJobId,
      );
    }
  } else {
    const csv = resolveCsv(inputs, context);
    const created = await createIngestJob(session, {
      object,
      operation,
      ...(externalIdField ? { externalIdFieldName: externalIdField } : {}),
    });
    jobId = created.id;
    await context.state.patch({ jobId });
    context.logger.info("Salesforce ingest job created", {
      jobId,
      object,
      operation,
    });
    await uploadIngestData(session, jobId, csv);
  }

  const job = await awaitJob(session, "ingest", jobId, { timeoutMs });
  return summarize(context, session, job, jobId);
};

async function summarize(
  context: Parameters<ActionExecute>[1],
  session: Awaited<ReturnType<typeof salesforceSession>>,
  job: { numberRecordsProcessed?: number; numberRecordsFailed?: number },
  jobId: string,
) {
  const processed = job.numberRecordsProcessed ?? 0;
  const failed = job.numberRecordsFailed ?? 0;
  const outputs: Record<string, ActionJson> = { jobId, processed, failed };
  const artifacts = [];

  // Failed rows are the actionable output of a partially successful load, so
  // they are published rather than merely counted.
  if (failed > 0) {
    const csv = await fetchFailedResults(session, jobId);
    const name = `salesforce-failed-${jobId}.csv`;
    const artifact = await context.artifacts.publish({
      name,
      type: "dataset",
      uri: `memory://salesforce/${encodeURIComponent(name)}`,
      mediaType: "text/csv",
      metadata: { jobId, failed },
    });
    outputs.failedArtifact = artifact as unknown as ActionJson;
    outputs.content = csv;
    artifacts.push(artifact);
    context.logger.warn("Salesforce ingest job reported failed records", {
      jobId,
      failed,
    });
  }

  return { outputs, externalRef: jobId, artifacts };
}

/** The CSV comes from an upstream artifact's content output, or inline config. */
function resolveCsv(
  inputs: Record<string, ActionJson>,
  context: Parameters<ActionExecute>[1],
) {
  const direct = str(inputs.content);
  if (direct) {
    return direct;
  }
  const artifact = inputs.artifact;
  if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
    const record = artifact as Record<string, ActionJson>;
    const content = str(record.content);
    if (content) {
      return content;
    }
  }
  context.logger.error("Salesforce upsert received no CSV content");
  throw new ActionInputError(
    "No CSV content was provided. Bind an upstream artifact's content output " +
      "to this step's `content` input.",
  );
}

export const salesforceUpsertAction = {
  manifest: salesforceUpsertActionManifest,
  execute: salesforceUpsertExecute,
};

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
