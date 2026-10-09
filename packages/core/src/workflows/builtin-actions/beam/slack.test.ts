import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  ActionExecutionError,
  ActionInputError,
  type ActionJson,
} from "../../actions.js";
import { slackAction, slackActionManifest } from "./slack.js";

type Call = { url: string; body: Record<string, unknown>; auth: string };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubSlack(
  responses: Array<{ status?: number; body: Record<string, unknown> }>,
) {
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const next = responses[index] ?? responses.at(-1)!;
    index += 1;
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
      auth: String((init.headers as Record<string, string>).Authorization ?? ""),
    });
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  }) as unknown as typeof fetch;
  return calls;
}

function context(secret: string | null = JSON.stringify({ token: "xoxb-tok" })) {
  return {
    secrets: { get: async () => secret },
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof slackAction.execute>[1];
}

const baseConfig = { credentialId: "cred_1" };
const baseInputs = { target: "#alerts", message: "hi" };

/** ActionExecute is typed sync-or-async, so wrap it for assert.rejects. */
async function attempt(
  config: Record<string, ActionJson>,
  inputs: Record<string, ActionJson>,
  ctx = context(),
) {
  await slackAction.execute({ config, inputs }, ctx);
}

test("the manifest declares the network and secret permissions it uses", () => {
  assert.deepEqual(slackActionManifest.permissions, [
    "network:http",
    "secrets:read",
  ]);
  const requirement = slackActionManifest.catalog.credentialRequirements?.[0];
  assert.equal(requirement?.key, "slack-bot-token");
  assert.deepEqual(requirement?.configPaths, [
    "config.credentialId",
    "inputs.credentialId",
  ]);
});

test("posts to a channel and strips the leading hash", async () => {
  const calls = stubSlack([{ body: { ok: true, channel: "C123", ts: "1.2" } }]);
  const result = await slackAction.execute(
    { config: baseConfig, inputs: { ...baseInputs, message: "done" } },
    context(),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /chat\.postMessage$/);
  assert.equal(calls[0]!.body.channel, "alerts");
  assert.equal(calls[0]!.body.text, "done");
  assert.equal(calls[0]!.auth, "Bearer xoxb-tok");
  assert.deepEqual(result.outputs, {
    delivered: true,
    channel: "C123",
    ts: "1.2",
  });
});

test("an email target is exchanged for a user id first", async () => {
  const calls = stubSlack([
    { body: { ok: true, user: { id: "U777" } } },
    { body: { ok: true, channel: "D777", ts: "9.9" } },
  ]);
  await slackAction.execute(
    {
      config: baseConfig,
      inputs: { ...baseInputs, target: "someone@company.com" },
    },
    context(),
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /users\.lookupByEmail$/);
  assert.equal(calls[0]!.body.email, "someone@company.com");
  assert.equal(calls[1]!.body.channel, "U777", "the DM goes to the user id");
});

test("a user id target is used directly, with no lookup", async () => {
  const calls = stubSlack([{ body: { ok: true, channel: "U9", ts: "1" } }]);
  await slackAction.execute(
    { config: baseConfig, inputs: { ...baseInputs, target: "U9" } },
    context(),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /chat\.postMessage$/);
});

test("an @handle keeps its bare name", async () => {
  const calls = stubSlack([{ body: { ok: true } }]);
  await slackAction.execute(
    { config: baseConfig, inputs: { ...baseInputs, target: "@someone" } },
    context(),
  );
  assert.equal(calls[0]!.body.channel, "someone");
});

test("a 200 response carrying ok:false is still a failure", async () => {
  stubSlack([{ body: { ok: false, error: "channel_not_found" } }]);
  await assert.rejects(
    attempt(baseConfig, baseInputs),
    (error: unknown) => {
      assert.ok(error instanceof ActionExecutionError);
      assert.match(String(error), /channel_not_found/);
      assert.equal(error.retryable, false, "a bad channel will not fix itself");
      return true;
    },
  );
});

test("rate limiting is retryable, bad auth is not", async () => {
  stubSlack([{ body: { ok: false, error: "ratelimited" } }]);
  await assert.rejects(
    attempt(baseConfig, baseInputs),
    (error: unknown) => error instanceof ActionExecutionError && error.retryable,
  );

  stubSlack([{ body: { ok: false, error: "invalid_auth" } }]);
  await assert.rejects(
    attempt(baseConfig, baseInputs),
    (error: unknown) =>
      error instanceof ActionExecutionError && !error.retryable,
  );
});

test("an HTTP 500 is retryable", async () => {
  stubSlack([{ status: 500, body: {} }]);
  await assert.rejects(
    attempt(baseConfig, baseInputs),
    (error: unknown) => error instanceof ActionExecutionError && error.retryable,
  );
});

test("thread replies pass thread_ts through", async () => {
  const calls = stubSlack([{ body: { ok: true } }]);
  await slackAction.execute(
    {
      config: baseConfig,
      inputs: { ...baseInputs, message: "reply", threadTs: "1699.000" },
    },
    context(),
  );
  assert.equal(calls[0]!.body.thread_ts, "1699.000");
});

test("the target is an input, so it can be bound from another node", async () => {
  const calls = stubSlack([{ body: { ok: true } }]);
  await slackAction.execute(
    { config: baseConfig, inputs: { ...baseInputs, target: "#other" } },
    context(),
  );
  assert.equal(calls[0]!.body.channel, "other");
});

test("missing credential, target or message is rejected before any request", async () => {
  const calls = stubSlack([{ body: { ok: true } }]);
  for (const [config, inputs] of [
    [{}, baseInputs],
    [baseConfig, { message: "m" }],
    [baseConfig, { target: "#a" }],
  ] as const) {
    await assert.rejects(
        attempt(config, inputs),
      ActionInputError,
    );
  }
  assert.equal(calls.length, 0, "nothing is sent when the step is misconfigured");
});

test("an unresolvable credential is an input error", async () => {
  stubSlack([{ body: { ok: true } }]);
  await assert.rejects(
    attempt(baseConfig, baseInputs, context(null)),
    ActionInputError,
  );
});

test("a credential payload without a token is rejected", async () => {
  stubSlack([{ body: { ok: true } }]);
  await assert.rejects(
    attempt(
      baseConfig,
      baseInputs,
      context(JSON.stringify({ webhook_url: "https://hooks.slack.com/x" })),
    ),
    ActionInputError,
  );
});
