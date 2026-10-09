import { pgOne, type PgClient, type PgPool } from "./postgres.js";

export class WorkflowAuthorizationError extends Error {
  readonly retryable = false;
  readonly statusCode = 403;
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "WorkflowAuthorizationError";
  }
}
/** Unavailability cannot grant access, revoke a grant, or extend a lease. */
export class WorkflowAuthorityUnavailableError extends Error {
  readonly retryable = true;
  readonly statusCode = 503;
  constructor(
    readonly code = "execution_authority_unavailable",
    message = "Execution authorization is temporarily unavailable.",
    readonly transportCode?: string,
  ) {
    super(message);
    this.name = "WorkflowAuthorityUnavailableError";
  }
}

export function workflowAuthorityTransportCode(error: unknown): string {
  const value = error as { name?: unknown; cause?: { code?: unknown } } | null;
  const code = value?.cause?.code ?? value?.name;
  return typeof code === "string" &&
    (/^UND_ERR_[A-Z_]+$/.test(code) ||
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "TimeoutError",
        "AbortError",
        "TypeError",
      ].includes(code))
    ? code
    : "transport_error";
}

export function workflowAuthorityUrl(path: string, configured: string): URL {
  try {
    const target = new URL(path, configured);
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password
    )
      throw new Error();
    return target;
  } catch {
    throw new WorkflowAuthorizationError(
      "execution_authority_configuration_invalid",
      "Execution authority must use an absolute HTTP(S) URL without embedded credentials.",
    );
  }
}
export type WorkflowAuthorizationRequest = {
  workflowRunId: string;
  stepId?: string;
  taskId?: string;
  claimToken?: string;
  inputs?: Record<string, unknown>;
  phase: "dispatch" | "child_launch" | "retry" | "lease_renewal" | "resource";
  /**
   * At dispatch, ask Studio for a signed Registry URL for the step's frozen
   * artifact. Studio issues it with the organization's key, which executors
   * never hold; the executor downloads it as given and verifies the sha256.
   */
  artifactUrl?: boolean;
};
/** What an authorized dispatch may carry back to the executor. */
export type WorkflowExecutionGrant = {
  /** Short-lived; use for this dispatch only, never persist in a run. */
  artifactUrl: string | null;
};
export type WorkflowExecutionAuthorizer = (
  client: PgClient | PgPool,
  input: WorkflowAuthorizationRequest,
) => Promise<WorkflowExecutionGrant | void>;

/** An absolute http(s) URL without embedded credentials, or null. */
export function grantedArtifactUrl(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Dispatchers use a per-run capability; executors use their current task claim. */
export const authorizeWorkflowExecutionPg: WorkflowExecutionAuthorizer = async (
  client,
  input,
) => {
  const configured = process.env.BEAM_STUDIO_API_URL?.trim();
  if (!configured)
    throw new WorkflowAuthorizationError(
      "execution_authority_unavailable",
      "Studio API URL is required for execution authorization.",
    );
  let token = input.claimToken;
  if (!input.taskId) {
    const capability = await pgOne<{ authorization_token: string }>(
      client,
      "SELECT authorization_token FROM execution.workflow_run_capabilities WHERE workflow_run_id=$1",
      [input.workflowRunId],
    );
    token = capability?.authorization_token;
  }
  if (!token)
    throw new WorkflowAuthorizationError("execution_capability_missing");
  const path = input.taskId
    ? `/internal/workflow-tasks/${encodeURIComponent(input.taskId)}/authorize`
    : `/internal/workflow-runs/${encodeURIComponent(input.workflowRunId)}/authorize`;
  const target = workflowAuthorityUrl(path, configured);
  let response: Response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stepId: input.stepId,
        phase: input.phase,
        inputs: input.inputs,
        ...(input.artifactUrl ? { artifactUrl: true } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch (error) {
    throw new WorkflowAuthorityUnavailableError(
      "execution_authority_unavailable",
      "Execution authorization is temporarily unavailable.",
      workflowAuthorityTransportCode(error),
    );
  }
  const result = (await response.json().catch(() => null)) as {
    authorized?: boolean;
    code?: string;
    error?: string;
    artifactUrl?: unknown;
  } | null;
  if (
    response.status === 429 ||
    response.status >= 500 ||
    (response.ok && typeof result?.authorized !== "boolean")
  )
    throw new WorkflowAuthorityUnavailableError();
  if (!response.ok || result?.authorized !== true)
    throw new WorkflowAuthorizationError(
      result?.code ?? "execution_authorization_denied",
      result?.error ?? "Current execution permissions do not allow this work.",
    );
  return {
    artifactUrl: input.artifactUrl
      ? grantedArtifactUrl(result?.artifactUrl)
      : null,
  };
};
