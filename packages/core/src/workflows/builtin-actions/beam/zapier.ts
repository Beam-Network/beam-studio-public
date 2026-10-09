import {
  ActionExecutionError,
  ActionInputError,
  type ActionExecute,
  type ActionJson,
} from "../../actions.js";
import { beamActionManifest } from "./manifest.js";
import { zapierConnection, text } from "./zapier/credential.js";
import { McpError, callMcpTool, listMcpTools } from "./zapier/mcp.js";

/**
 * Zapier as one action.
 *
 * Every other integration here costs a credential type, a probe, an action and
 * a README per destination. Zapier collapses that: one credential reaches
 * whatever the user has configured on their MCP server, which is how a Beam
 * workflow gets to Jira or Salesforce without Beam writing a Jira connector.
 *
 * The trade is that the tool set is not knowable at build time. `tool` is
 * therefore a plain string in config, and @beam/zapier-tools exists so the
 * editor can offer the real list instead of asking the user to remember slugs.
 */

const credentialRequirement = {
  key: "zapier",
  displayName: "Zapier credentials",
  description: "The MCP server whose tools this step may invoke.",
  required: true,
  cardinality: "one" as const,
  purpose: "integration",
  acceptedCredentialTypes: ["zapier_mcp"],
  configPaths: ["config.credentialId", "inputs.credentialId"],
  permissions: ["secrets:read"],
};

export const zapierActionManifest = beamActionManifest({
  name: "@beam/zapier",
  displayName: "Zapier action",
  description:
    "Runs one action on your Zapier MCP server, reaching any app Zapier connects to.",
  // Only the credential and the tool are static configuration. What the tool is
  // told is per-run, so it is an input alone: config is passed to an action
  // verbatim, and offering the same field in both places invites writing a
  // ${…} expression into the one that cannot resolve it.
  configSchema: {
    type: "object",
    required: ["credentialId", "tool"],
    additionalProperties: true,
    properties: {
      credentialId: { type: "string", title: "Zapier credential" },
      tool: {
        type: "string",
        title: "Zapier action",
        description:
          "The action's name on your MCP server, for example slack_send_channel_message.",
      },
    },
  },
  inputs: {
    instructions: {
      type: "string",
      title: "Instructions",
      description:
        "What the action should do, in plain language. Zapier fills in any field this names.",
    },
    params: {
      type: "object",
      title: "Explicit fields",
      description:
        "Optional. Overrides what Zapier infers from the instructions. Bind a single ${…} expression to pass an object intact.",
    },
    credentialId: { type: "string" },
  },
  outputs: {
    ok: { type: "boolean" },
    toolName: { type: "string" },
    content: { type: "string" },
    result: { type: "object" },
  },
  permissions: ["network:http", "secrets:read"],
  catalog: {
    category: "integration",
    maturity: "experimental",
    tags: ["zapier", "integration", "automation", "notification"],
    credentialRequirements: [credentialRequirement],
  },
});

const zapierExecute: ActionExecute = async ({ config, inputs }, context) => {
  const credentialId = text(config.credentialId) || text(inputs.credentialId);
  if (!credentialId) {
    throw new ActionInputError("The Zapier action requires a credential.");
  }
  const tool = text(config.tool);
  if (!tool) {
    throw new ActionInputError(
      "The Zapier action requires the name of a Zapier action to run.",
    );
  }

  const instructions = text(inputs.instructions);
  const params = objectValue(inputs.params);
  if (!instructions && !Object.keys(params).length) {
    throw new ActionInputError(
      "The Zapier action requires instructions or explicit fields.",
    );
  }

  const prior = priorCall(context.state.get(), tool);
  if (prior) {
    // Re-running a Zap is a side effect in someone else's system, and Zapier
    // offers no idempotency key to make a repeat harmless, so a recorded
    // success is not repeated.
    context.logger.info("Zapier action already ran on an earlier attempt.", {
      tool,
    });
    return { outputs: prior };
  }

  const connection = await zapierConnection(context, credentialId);

  await context.state.patch({
    zapier: { tool, attemptedAt: new Date().toISOString() },
  });

  const result = await run(() =>
    callMcpTool(connection, {
      name: tool,
      arguments: {
        ...(instructions ? { instructions } : {}),
        ...params,
      },
    }),
  );

  if (result.isError) {
    // Reported in the result rather than as a protocol error, and repeating the
    // same arguments produces the same refusal.
    throw new ActionExecutionError(
      `Zapier action "${tool}" failed: ${result.content || "no detail given"}.`,
      { retryable: false },
    );
  }

  const outputs = {
    ok: true,
    toolName: tool,
    content: result.content,
    result: (result.structured ?? {}) as ActionJson,
  };
  await context.state.patch({ zapier: { tool, ...outputs } });
  return { outputs };
};

export const zapierToolsActionManifest = beamActionManifest({
  name: "@beam/zapier-tools",
  displayName: "Zapier actions",
  description:
    "Lists the actions available on your Zapier MCP server. Useful for discovering a name to give the Zapier action.",
  configSchema: {
    type: "object",
    required: ["credentialId"],
    additionalProperties: true,
    properties: {
      credentialId: { type: "string", title: "Zapier credential" },
    },
  },
  inputs: {
    credentialId: { type: "string" },
  },
  outputs: {
    tools: { type: "array" },
    count: { type: "number" },
  },
  permissions: ["network:http", "secrets:read"],
  catalog: {
    category: "integration",
    maturity: "experimental",
    tags: ["zapier", "integration", "discovery"],
    credentialRequirements: [
      { ...credentialRequirement, purpose: "integration-discovery" },
    ],
  },
});

const zapierToolsExecute: ActionExecute = async (
  { config, inputs },
  context,
) => {
  const credentialId = text(config.credentialId) || text(inputs.credentialId);
  if (!credentialId) {
    throw new ActionInputError("Listing Zapier actions requires a credential.");
  }

  const connection = await zapierConnection(context, credentialId);
  const tools = await run(() => listMcpTools(connection));

  return {
    outputs: {
      count: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    },
  };
};

/**
 * Translates an MCP failure into the engine's retry vocabulary. `McpError`
 * already decided what is worth retrying; this only carries that across.
 */
async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof McpError) {
      throw new ActionExecutionError(error.message, {
        retryable: error.retryable,
      });
    }
    throw error;
  }
}

function priorCall(state: Record<string, ActionJson>, tool: string) {
  const record = state.zapier;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  if (record.tool !== tool || record.ok !== true) {
    return null;
  }
  return {
    ok: true,
    toolName: tool,
    content: typeof record.content === "string" ? record.content : "",
    result: (record.result ?? {}) as ActionJson,
  };
}

function objectValue(value: unknown): Record<string, ActionJson> {
  if (typeof value === "string") {
    if (!value.trim()) {
      return {};
    }
    try {
      return objectValue(JSON.parse(value));
    } catch {
      throw new ActionInputError(
        "Explicit fields must be a JSON object or an expression resolving to one.",
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, ActionJson>;
}

export const zapierAction = {
  manifest: zapierActionManifest,
  execute: zapierExecute,
};

export const zapierToolsAction = {
  manifest: zapierToolsActionManifest,
  execute: zapierToolsExecute,
};
