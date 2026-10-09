import { ActionExecutionError } from "../../../actions.js";
import { dataPath, type SalesforceSession } from "./auth.js";
import { salesforceFetch, salesforceJson, str, type RetryOptions } from "./http.js";

/**
 * Bulk API 2.0 job lifecycle, shared by the query and upsert actions.
 *
 * Both directions are asynchronous jobs identified by an id. That id is the
 * unit of resumability: a step that crashes after creating a job must reattach
 * to it rather than create a second one, which for an ingest job would mean
 * writing the same records into a customer's CRM twice.
 */

export type BulkJobState =
  | "Open"
  | "UploadComplete"
  | "InProgress"
  | "Aborted"
  | "JobComplete"
  | "Failed";

export type BulkJob = {
  id: string;
  state: BulkJobState;
  object?: string;
  operation?: string;
  numberRecordsProcessed?: number;
  numberRecordsFailed?: number;
  errorMessage?: string;
};

const TERMINAL: BulkJobState[] = ["JobComplete", "Aborted", "Failed"];

export function isTerminal(state: BulkJobState) {
  return TERMINAL.includes(state);
}

/**
 * Raises unless a finished job actually succeeded.
 *
 * Both the wait path and the reattach path observe finished jobs, and a job
 * that ended as Failed or Aborted must not be reported as a successful load
 * just because it is no longer running.
 */
export function assertJobSucceeded(job: BulkJob, jobId: string) {
  if (job.state === "JobComplete") {
    return job;
  }
  throw new ActionExecutionError(
    `Salesforce bulk job ${jobId} ended as ${job.state}` +
      `${job.errorMessage ? `: ${job.errorMessage}` : "."}`,
    // Aborted and Failed are decisions about this job, not transient faults.
    { retryable: false },
  );
}

/** Creates a query job. Returns the job id to persist before anything else. */
export async function createQueryJob(
  session: SalesforceSession,
  soql: string,
  options: RetryOptions = {},
): Promise<BulkJob> {
  return salesforceJson<BulkJob>(
    {
      url: dataPath(session, "/jobs/query"),
      method: "POST",
      accessToken: session.accessToken,
      body: JSON.stringify({
        operation: "query",
        query: soql,
        contentType: "CSV",
      }),
    },
    options,
  );
}

export async function createIngestJob(
  session: SalesforceSession,
  input: { object: string; operation: string; externalIdFieldName?: string },
  options: RetryOptions = {},
): Promise<BulkJob> {
  return salesforceJson<BulkJob>(
    {
      url: dataPath(session, "/jobs/ingest"),
      method: "POST",
      accessToken: session.accessToken,
      body: JSON.stringify({
        object: input.object,
        operation: input.operation,
        contentType: "CSV",
        lineEnding: "LF",
        ...(input.externalIdFieldName
          ? { externalIdFieldName: input.externalIdFieldName }
          : {}),
      }),
    },
    options,
  );
}

/** Uploads the CSV batch, then closes the job so Salesforce begins processing. */
export async function uploadIngestData(
  session: SalesforceSession,
  jobId: string,
  csv: string,
  options: RetryOptions = {},
) {
  await salesforceFetch(
    {
      url: dataPath(session, `/jobs/ingest/${jobId}/batches`),
      method: "PUT",
      accessToken: session.accessToken,
      body: csv,
      contentType: "text/csv",
    },
    options,
  );
  await salesforceJson(
    {
      url: dataPath(session, `/jobs/ingest/${jobId}`),
      method: "PATCH",
      accessToken: session.accessToken,
      body: JSON.stringify({ state: "UploadComplete" }),
    },
    options,
  );
}

export async function getJob(
  session: SalesforceSession,
  kind: "query" | "ingest",
  jobId: string,
  options: RetryOptions = {},
): Promise<BulkJob> {
  return salesforceJson<BulkJob>(
    {
      url: dataPath(session, `/jobs/${kind}/${jobId}`),
      accessToken: session.accessToken,
    },
    options,
  );
}

/**
 * Waits for a job to reach a terminal state.
 *
 * Bounded by wall clock rather than attempts: a large job legitimately takes
 * minutes, and the step's own timeout is the real ceiling. A job still running
 * when the budget expires is left alone — the id is persisted, so a retry
 * reattaches instead of starting over.
 */
export async function awaitJob(
  session: SalesforceSession,
  kind: "query" | "ingest",
  jobId: string,
  budget: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
  options: RetryOptions = {},
): Promise<BulkJob> {
  const timeoutMs = budget.timeoutMs ?? 10 * 60_000;
  const pollIntervalMs = budget.pollIntervalMs ?? 3000;
  const sleep = budget.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = budget.now ?? Date.now;
  const deadline = now() + timeoutMs;

  for (;;) {
    const job = await getJob(session, kind, jobId, options);
    if (isTerminal(job.state)) {
      return assertJobSucceeded(job, jobId);
    }
    if (now() >= deadline) {
      throw new ActionExecutionError(
        `Salesforce bulk job ${jobId} was still ${job.state} after ` +
          `${Math.round(timeoutMs / 1000)}s. The job id is saved, so a retry ` +
          `resumes polling rather than starting a second job.`,
        { retryable: true },
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Drains query results.
 *
 * Results are cursor-paged by the Sforce-Locator header, not by byte range, so
 * every page must be fetched in order. Only the first page carries the header
 * row.
 */
export async function fetchQueryResults(
  session: SalesforceSession,
  jobId: string,
  input: { maxRecordsPerPage?: number; startLocator?: string } = {},
  options: RetryOptions = {},
): Promise<{ csv: string; pages: number }> {
  const maxRecords = input.maxRecordsPerPage ?? 50_000;
  let locator = input.startLocator ?? "";
  let pages = 0;
  const chunks: string[] = [];

  for (;;) {
    const query = new URLSearchParams({ maxRecords: String(maxRecords) });
    if (locator) {
      query.set("locator", locator);
    }
    const response = await salesforceFetch(
      {
        url: dataPath(session, `/jobs/query/${jobId}/results?${query}`),
        accessToken: session.accessToken,
        accept: "text/csv",
      },
      options,
    );

    const body = response.text;
    chunks.push(pages === 0 ? body : stripHeaderRow(body));
    pages += 1;

    const next = str(response.headers.get("sforce-locator"));
    // Salesforce signals the end with an absent header or the literal "null".
    if (!next || next === "null") {
      break;
    }
    locator = next;
  }

  return { csv: chunks.filter(Boolean).join(""), pages };
}

/** Failed rows come back as CSV with the original columns plus error columns. */
export async function fetchFailedResults(
  session: SalesforceSession,
  jobId: string,
  options: RetryOptions = {},
) {
  const response = await salesforceFetch(
    {
      url: dataPath(session, `/jobs/ingest/${jobId}/failedResults/`),
      accessToken: session.accessToken,
      accept: "text/csv",
    },
    options,
  );
  return response.text;
}

function stripHeaderRow(csv: string) {
  const newline = csv.indexOf("\n");
  return newline === -1 ? "" : csv.slice(newline + 1);
}
