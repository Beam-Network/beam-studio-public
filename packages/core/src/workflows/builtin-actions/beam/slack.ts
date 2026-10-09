import {
  ActionExecutionError,
  ActionInputError,
  type ActionExecute,
  type ActionJson,
} from "../../actions.js";
import { beamActionManifest } from "./manifest.js";

const SLACK_API = "https://slack.com/api";

/**
 * Slack errors that will never succeed on a retry. Everything else (rate
 * limits, transient upstream failures) is retried by the task runner.
 */
const permanentSlackErrors = new Set([
  "channel_not_found",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "not_authed",
  "no_permission",
  "is_archived",
  "msg_too_long",
  "no_text",
  "restricted_action",
  "users_not_found",
  "not_in_channel",
]);

export const slackActionManifest = beamActionManifest({
  name: "@beam/slack",
  displayName: "Slack message",
  description:
    "Posts a message to a Slack channel or sends a direct message to a person.",
  // Only the credential is static configuration. Target, message and thread
  // are per-run values, so they are inputs alone: config is passed to an action
  // verbatim, and offering the same field in both places invites writing a
  // ${…} expression into the one that cannot resolve it.
  configSchema: {
    type: "object",
    properties: {
      credentialId: { type: "string", title: "Slack credential" },
    },
    required: ["credentialId"],
    additionalProperties: true,
  },
  inputs: {
    target: {
      type: "string",
      title: "Channel or person",
      description:
        "#channel, a channel ID, @handle, a user ID, or a person's email address.",
    },
    message: { type: "string", title: "Message" },
    threadTs: { type: "string", title: "Reply in thread (timestamp)" },
  },
  outputs: {
    delivered: { type: "boolean" },
    channel: { type: "string" },
    ts: { type: "string" },
  },
  permissions: ["network:http", "secrets:read"],
  catalog: {
    category: "notification",
    maturity: "stable",
    tags: ["slack", "notification", "alert", "message"],
    credentialRequirements: [
      {
        key: "slack-bot-token",
        displayName: "Slack bot token",
        required: true,
        cardinality: "one",
        purpose: "notification",
        acceptedCredentialTypes: ["slack_bot_token"],
        configPaths: ["config.credentialId", "inputs.credentialId"],
        permissions: ["secrets:read"],
      },
    ],
  },
});

const slackExecute: ActionExecute = async ({ config, inputs }, context) => {
  const credentialId = text(config.credentialId) || text(inputs.credentialId);
  const target = text(inputs.target);
  const message = text(inputs.message);
  const threadTs = text(inputs.threadTs);

  if (!credentialId) {
    throw new ActionInputError("Slack message requires a credential.");
  }
  if (!target) {
    throw new ActionInputError(
      "Slack message requires a channel or person to send to.",
    );
  }
  if (!message) {
    throw new ActionInputError("Slack message requires message text.");
  }

  const token = await slackToken(context, credentialId);
  const channel = await resolveTarget(token, target, context.signal);

  const response = await slackCall(
    token,
    "chat.postMessage",
    {
      channel,
      text: message,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
    context.signal,
  );

  return {
    outputs: {
      delivered: true,
      channel: String(response.channel ?? channel),
      ts: String(response.ts ?? ""),
    },
  };
};

async function slackToken(
  context: Parameters<ActionExecute>[1],
  credentialId: string,
) {
  const raw = await context.secrets.get(credentialId);
  if (!raw) {
    throw new ActionInputError(
      `Slack credential "${credentialId}" could not be resolved.`,
    );
  }
  let token = "";
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    token = text(payload.token) || text(payload.bot_token);
  } catch {
    // A credential stored as a bare string is still usable.
    token = raw.trim();
  }
  if (!token) {
    throw new ActionInputError(
      "The Slack credential does not contain a bot token.",
    );
  }
  return token;
}

/**
 * Slack accepts a channel name or ID directly, and a user ID addresses a DM.
 * An email has to be exchanged for a user ID first, which is the one case that
 * needs a second API call.
 */
async function resolveTarget(
  token: string,
  target: string,
  signal: AbortSignal,
) {
  const trimmed = target.trim();
  if (
    trimmed.includes("@") &&
    trimmed.includes(".") &&
    !trimmed.startsWith("@")
  ) {
    const user = await slackCall(
      token,
      "users.lookupByEmail",
      { email: trimmed },
      signal,
    );
    const id = text((user.user as Record<string, unknown> | undefined)?.id);
    if (!id) {
      throw new ActionExecutionError(`No Slack user found for "${trimmed}".`, {
        retryable: false,
      });
    }
    return id;
  }
  // "#channel" and "@handle" are display forms; Slack wants the bare name.
  return trimmed.replace(/^[#@]/, "");
}

async function slackCall(
  token: string,
  method: string,
  body: Record<string, ActionJson>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new ActionExecutionError(
      `Slack ${method} returned HTTP ${response.status}.`,
      // 4xx other than 429 will not fix itself; 429 and 5xx will.
      { retryable: response.status === 429 || response.status >= 500 },
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  // Slack answers 200 even when it refuses the call, so the ok flag is the
  // only reliable success signal.
  if (payload.ok !== true) {
    const error = text(payload.error) || "unknown_error";
    throw new ActionExecutionError(`Slack ${method} failed: ${error}.`, {
      retryable: !permanentSlackErrors.has(error),
    });
  }
  return payload;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export const slackAction = {
  manifest: slackActionManifest,
  execute: slackExecute,
};
