import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { ActionExecutionError, ActionInputError } from "../../actions.js";
import { runActionHarness } from "../../harness.js";
import {
  zapierAction,
  zapierActionManifest,
  zapierToolsAction,
  zapierToolsActionManifest,
} from "./zapier.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Frame = { method: string; params: Record<string, unknown> };

function stubServer(results: Record<string, unknown>) {
  const frames: Frame[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body ?? "{}")) as {
      method: string;
      id?: number;
      params?: Record<string, unknown>;
    };
    frames.push({ method: payload.method, params: payload.params ?? {} });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: results[payload.method] ?? {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return frames;
}

const credentialId = "cred_zapier";
const secrets = {
  [credentialId]: JSON.stringify({
    base_url: "https://mcp.zapier.com/api/mcp/s/secret/mcp",
    api_key: "zap_key",
  }),
};

test("runs the configured tool and returns what it said", async () => {
  const frames = stubServer({
    "tools/call": {
      content: [{ type: "text", text: "Message sent to #ops" }],
      structuredContent: { ts: "1700000000.1" },
    },
  });

  const result = await runActionHarness(
    zapierAction.execute,
    {
      config: { credentialId, tool: "slack_send_channel_message" },
      inputs: { instructions: "Tell #ops the nightly transfer finished" },
    },
    { secrets },
  );

  assert.equal(result.outputs?.ok, true);
  assert.equal(result.outputs?.toolName, "slack_send_channel_message");
  assert.equal(result.outputs?.content, "Message sent to #ops");
  assert.deepEqual(result.outputs?.result, { ts: "1700000000.1" });

  const call = frames.at(-1)!;
  assert.equal(call.params.name, "slack_send_channel_message");
  assert.deepEqual(call.params.arguments, {
    instructions: "Tell #ops the nightly transfer finished",
  });
});

test("explicit fields are merged over the instructions", async () => {
  const frames = stubServer({ "tools/call": { content: [] } });

  await runActionHarness(
    zapierAction.execute,
    {
      config: { credentialId, tool: "jira_create_issue" },
      inputs: {
        instructions: "open a bug",
        params: { project: "OPS", priority: "High" },
      },
    },
    { secrets },
  );

  assert.deepEqual(frames.at(-1)!.params.arguments, {
    instructions: "open a bug",
    project: "OPS",
    priority: "High",
  });
});

test("explicit fields accept a JSON string, because a binding is text", async () => {
  const frames = stubServer({ "tools/call": { content: [] } });

  await runActionHarness(
    zapierAction.execute,
    {
      config: { credentialId, tool: "jira_create_issue" },
      inputs: { params: '{"project":"OPS"}' },
    },
    { secrets },
  );

  assert.deepEqual(frames.at(-1)!.params.arguments, { project: "OPS" });
});

test("explicit fields that are not JSON raise rather than being sent as text", async () => {
  stubServer({});
  await assert.rejects(
    () =>
      runActionHarness(
        zapierAction.execute,
        {
          config: { credentialId, tool: "jira_create_issue" },
          inputs: { params: "project=OPS" },
        },
        { secrets },
      ),
    ActionInputError,
  );
});

test("a tool that reports failure raises and is not retried", async () => {
  stubServer({
    "tools/call": {
      isError: true,
      content: [{ type: "text", text: "channel not found" }],
    },
  });

  await assert.rejects(
    () =>
      runActionHarness(
        zapierAction.execute,
        {
          config: { credentialId, tool: "slack_send_channel_message" },
          inputs: { instructions: "post" },
        },
        { secrets },
      ),
    (error: unknown) =>
      error instanceof ActionExecutionError &&
      error.retryable === false &&
      error.message.includes("channel not found"),
  );
});

test("a recorded success is not run a second time", async () => {
  const frames = stubServer({ "tools/call": { content: [] } });

  const result = await runActionHarness(
    zapierAction.execute,
    {
      config: { credentialId, tool: "slack_send_channel_message" },
      inputs: { instructions: "post" },
    },
    {
      secrets,
      initialState: {
        zapier: {
          tool: "slack_send_channel_message",
          ok: true,
          content: "already sent",
          result: {},
        },
      },
    },
  );

  assert.equal(frames.length, 0);
  assert.equal(result.outputs?.content, "already sent");
});

test("a success recorded for a different tool does not suppress this one", async () => {
  const frames = stubServer({ "tools/call": { content: [] } });

  await runActionHarness(
    zapierAction.execute,
    {
      config: { credentialId, tool: "jira_create_issue" },
      inputs: { instructions: "open a bug" },
    },
    {
      secrets,
      initialState: {
        zapier: {
          tool: "slack_send_channel_message",
          ok: true,
          content: "",
          result: {},
        },
      },
    },
  );

  assert.ok(frames.length > 0);
});

test("a missing tool name, credential, or instruction raises", async () => {
  stubServer({});
  await assert.rejects(
    () =>
      runActionHarness(
        zapierAction.execute,
        { config: { credentialId }, inputs: { instructions: "post" } },
        { secrets },
      ),
    ActionInputError,
  );
  await assert.rejects(
    () =>
      runActionHarness(zapierAction.execute, {
        config: { tool: "slack_send_channel_message" },
        inputs: { instructions: "post" },
      }),
    ActionInputError,
  );
  await assert.rejects(
    () =>
      runActionHarness(
        zapierAction.execute,
        {
          config: { credentialId, tool: "slack_send_channel_message" },
          inputs: {},
        },
        { secrets },
      ),
    ActionInputError,
  );
});

test("a credential without an MCP URL raises", async () => {
  stubServer({});
  await assert.rejects(
    () =>
      runActionHarness(
        zapierAction.execute,
        { config: { credentialId, tool: "x" }, inputs: { instructions: "y" } },
        { secrets: { [credentialId]: JSON.stringify({ api_key: "zap_key" }) } },
      ),
    ActionInputError,
  );
});

test("the tools action lists what the server exposes", async () => {
  stubServer({
    "tools/list": {
      tools: [
        { name: "slack_send_channel_message", description: "Post to Slack" },
        { name: "jira_create_issue", description: "Open a Jira issue" },
      ],
    },
  });

  const result = await runActionHarness(
    zapierToolsAction.execute,
    { config: { credentialId } },
    { secrets },
  );

  assert.equal(result.outputs?.count, 2);
  assert.deepEqual(result.outputs?.tools, [
    { name: "slack_send_channel_message", description: "Post to Slack" },
    { name: "jira_create_issue", description: "Open a Jira issue" },
  ]);
});

test("both manifests declare only permissions a default worker allows", () => {
  for (const manifest of [zapierActionManifest, zapierToolsActionManifest]) {
    assert.deepEqual(manifest.permissions, ["network:http", "secrets:read"]);
    const requirement = manifest.catalog.credentialRequirements?.[0];
    assert.deepEqual(requirement?.acceptedCredentialTypes, ["zapier_mcp"]);
    assert.deepEqual(requirement?.configPaths, [
      "config.credentialId",
      "inputs.credentialId",
    ]);
  }
});
