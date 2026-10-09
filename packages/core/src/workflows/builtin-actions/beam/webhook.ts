import { createHmac } from "node:crypto";
import {
  ActionInputError,
  type ActionExecute,
  type ActionJson,
} from "../../actions.js";
import { type RetryOptions } from "./http/retry.js";
import {
  httpMethod,
  httpTimeoutMs,
  httpUrl,
  requestWithRetry,
  resolveHttpCredential,
} from "./http/request.js";
import { beamActionManifest } from "./manifest.js";

/**
 * The generic completion callback.
 *
 * Everything a receiver needs in order to trust and de-duplicate the call is
 * decided here rather than left to whoever builds the workflow:
 *
 *   - the body is a stable envelope, so a receiver parses one shape no matter
 *     which step it was wired behind;
 *   - `Idempotency-Key` is the step run, so a worker crash between the POST and
 *     the acknowledgement does not produce a second distinct event;
 *   - a bound credential signs the body, so the receiver can tell a real Beam
 *     callback from anyone who learned the URL.
 *
 * Signing has no on/off switch. A toggle only invites shipping an unsigned
 * callback while believing it is signed; instead the signature is present
 * exactly when a credential carrying a key is bound.
 */

const METHODS = ["POST", "PUT"];

const DEFAULT_EVENT = "step.completed";
const DEFAULT_TIMEOUT_SECONDS = 30;

export const webhookActionManifest = beamActionManifest({
  name: "@beam/webhook",
  displayName: "Webhook",
  description:
    "Posts a signed completion callback to an HTTP endpoint, with retries and an idempotency key.",
  // The endpoint and the credential are static configuration. What is reported
  // about the run is per-run, so it lives in inputs alone: config is passed to
  // an action verbatim, and offering the same field in both places invites
  // writing a ${…} expression into the one that cannot resolve it.
  configSchema: {
    type: "object",
    required: ["url"],
    additionalProperties: true,
    properties: {
      url: {
        type: "string",
        title: "Endpoint URL",
        description: "The https:// endpoint that receives the callback.",
      },
      credentialId: {
        type: "string",
        title: "HTTP credential",
        description:
          "Optional. Authenticates the call and signs the body. Without one the callback is unauthenticated and unsigned.",
      },
      method: {
        type: "string",
        title: "Method",
        enum: METHODS,
        default: "POST",
      },
      timeoutSeconds: {
        type: "number",
        title: "Timeout (seconds)",
        default: DEFAULT_TIMEOUT_SECONDS,
      },
    },
  },
  inputs: {
    event: {
      type: "string",
      title: "Event name",
      description: `Defaults to ${DEFAULT_EVENT}. Use step.failed on a failure branch.`,
    },
    payload: {
      type: "object",
      title: "Payload",
      description:
        "Carried through as the envelope's data field. Bind a single ${…} expression to pass an object intact.",
    },
    credentialId: { type: "string" },
  },
  outputs: {
    delivered: { type: "boolean" },
    status: { type: "number" },
    requestId: { type: "string" },
    respondedAt: { type: "string" },
  },
  permissions: ["network:http", "secrets:read"],
  catalog: {
    category: "notification",
    maturity: "stable",
    tags: ["webhook", "http", "notification", "callback"],
    credentialRequirements: [
      {
        key: "webhook",
        displayName: "HTTP credential",
        description:
          "Bearer token used to authenticate the callback, and the key its signature is derived from.",
        required: false,
        cardinality: "one",
        purpose: "notification",
        acceptedCredentialTypes: ["http_bearer_token"],
        configPaths: ["config.credentialId", "inputs.credentialId"],
        permissions: ["secrets:read"],
      },
    ],
  },
});

const webhookExecute: ActionExecute = async ({ config, inputs }, context) => {
  const url = httpUrl(config.url, "Webhook action");
  const method = httpMethod(config.method || "POST", METHODS);

  const credentialId = text(config.credentialId) || text(inputs.credentialId);
  const credential = credentialId
    ? await httpCredential(context, credentialId)
    : null;

  // The step run is the identity of this callback. It survives every retry of
  // the step, which is precisely the property a receiver needs to collapse
  // duplicates caused by a worker crash after delivery.
  const requestId = context.stepRunId;

  const prior = priorDelivery(context.state.get(), requestId);
  if (prior?.delivered) {
    context.logger.info("Callback already delivered on an earlier attempt.", {
      requestId,
      status: prior.status,
    });
    return { outputs: { ...prior } };
  }
  if (prior) {
    // The previous attempt reached the point of sending but never recorded an
    // outcome, so we cannot know whether the receiver saw it. Delivery is
    // at-least-once; the Idempotency-Key is what makes that safe.
    context.logger.warn(
      "A previous attempt may already have delivered this callback; resending with the same Idempotency-Key.",
      { requestId },
    );
  }

  const body = JSON.stringify(
    callbackEnvelope({
      event: text(inputs.event) || DEFAULT_EVENT,
      payload: inputs.payload,
      context,
    }),
  );

  await context.state.patch({
    webhook: { requestId, attemptedAt: new Date().toISOString() },
  });

  const response = await deliver({
    url,
    method,
    body,
    requestId,
    credential,
    timeoutMs: httpTimeoutMs(config.timeoutSeconds),
    signal: context.signal,
  });

  const outputs = {
    delivered: true,
    status: response.status,
    requestId,
    respondedAt: new Date().toISOString(),
  };
  await context.state.patch({ webhook: { ...outputs } });
  return { outputs };
};

/**
 * The callback envelope.
 *
 * A receiver should not have to know which step it was wired behind, so the run
 * identity travels alongside the payload rather than being something the
 * workflow author remembers to include.
 */
export function callbackEnvelope(input: {
  event: string;
  payload: unknown;
  context: Pick<
    Parameters<ActionExecute>[1],
    "workflowRunId" | "stepRunId" | "stepId" | "attempt"
  >;
  now?: () => Date;
}): Record<string, ActionJson> {
  const now = input.now ?? (() => new Date());
  return {
    event: input.event,
    occurredAt: now().toISOString(),
    workflowRunId: input.context.workflowRunId,
    stepRunId: input.context.stepRunId,
    stepId: input.context.stepId,
    attempt: input.context.attempt,
    data: (input.payload ?? {}) as ActionJson,
  };
}

export type WebhookCredential = {
  /** Sent as a bearer token when present. */
  token: string;
  /** HMAC key for the signature. Falls back to the token. */
  signingSecret: string;
};

async function httpCredential(
  context: Parameters<ActionExecute>[1],
  credentialId: string,
): Promise<WebhookCredential> {
  const { token, signingSecret } = await resolveHttpCredential(
    context,
    credentialId,
  );
  if (!token && !signingSecret) {
    throw new ActionInputError(
      "The webhook credential contains neither a token nor a signing secret.",
    );
  }
  return { token, signingSecret: signingSecret || token };
}

/**
 * `X-Beam-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "t.body">`
 *
 * The timestamp is inside the signed material so a captured callback cannot be
 * replayed later with a fresh timestamp; a receiver should reject a `t` that is
 * far from its own clock.
 */
export function signCallback(
  body: string,
  secret: string,
  timestampSeconds: number,
) {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`)
    .digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

/** Exported so the retry policy can be tested without waiting out a backoff. */
export async function deliver(
  request: {
    url: string;
    method: string;
    body: string;
    requestId: string;
    credential: WebhookCredential | null;
    timeoutMs: number;
    signal: AbortSignal;
  },
  options: RetryOptions = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Idempotency-Key": request.requestId,
  };
  if (request.credential?.token) {
    headers.Authorization = `Bearer ${request.credential.token}`;
  }
  if (request.credential?.signingSecret) {
    headers["X-Beam-Signature"] = signCallback(
      request.body,
      request.credential.signingSecret,
      Math.floor(Date.now() / 1000),
    );
  }

  const response = await requestWithRetry(
    {
      url: request.url,
      init: {
        method: request.method,
        headers,
        body: request.body,
      },
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      subject: "callback endpoint",
    },
    options,
  );
  return { status: response.status };
}

function priorDelivery(state: Record<string, ActionJson>, requestId: string) {
  const record = state.webhook;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  if (record.requestId !== requestId) {
    return null;
  }
  return {
    delivered: record.delivered === true,
    status: typeof record.status === "number" ? record.status : 0,
    requestId,
    respondedAt:
      typeof record.respondedAt === "string" ? record.respondedAt : "",
  };
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export const webhookAction = {
  manifest: webhookActionManifest,
  execute: webhookExecute,
};
