import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_PROVIDER_CATALOG,
  BEAM_AI_PROVIDER_ID,
  assistantProviderConfigSummary,
  assistantProviderFromSettings,
  createAssistantChatResponse,
  createAssistantWorkflowPlan,
  createAssistantUniversalPlanDraft,
  listAssistantProviderModels,
  testAssistantProvider,
} from "./assistant.js";

const defaults = {
  baseUrl: "https://api.b1m.ai/api/ai/v1",
  managedCredentials: true,
  model: "gpt-default",
  providerId: BEAM_AI_PROVIDER_ID,
  requestHeaders: { "X-Organization-Id": "org_1" },
};

test("chat supplies real Registry hrefs and removes invented model links", async () => {
  let sentMessages: Array<{ role: string; content: string }> = [];
  const provider = assistantProviderFromSettings({
    ...defaults,
    request: async (_, init) => {
      sentMessages = JSON.parse(String(init?.body)).messages;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "[Slack](/registry/@beam/slack), [Custom](/registry/@custom/example), [Registry](/registry), [Workflow](/workflows/wft_1/editor), [HTTP](/actions/http-request), [Invented](/registry/@beam/not-installed).",
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  const result = await createAssistantChatResponse({
    actions: [
      {
        name: "@beam/slack",
        version: "1.0.0",
        manifest: { displayName: "Slack message" },
      },
    ],
    routeContext: {
      workflowId: "wft_1",
      registry: {
        packages: [{ packageName: "@custom/example", displayName: "Custom" }],
      },
    },
    messages: [{ role: "user", content: "What can I automate?" }],
    provider,
  });
  assert.match(sentMessages[0]!.content, /Use only exact href values/);
  assert.match(
    sentMessages[0]!.content,
    /\/actions\/\.\.\. pages do not exist/,
  );
  const context = JSON.parse(
    sentMessages[1]!.content.replace("Studio context JSON:\n", ""),
  );
  assert.equal(context.actions[0].href, "/registry/@beam/slack");
  assert.equal(
    context.routeContext.registry.packages[0].href,
    "/registry/@custom/example",
  );
  assert.ok(
    context.navigation.some(
      (item: { href: string }) => item.href === "/registry",
    ),
  );
  assert.equal(result.degraded, false);
  assert.equal(
    result.message,
    "[Slack](/registry/@beam/slack), [Custom](/registry/@custom/example), [Registry](/registry), [Workflow](/workflows/wft_1/editor), HTTP, Invented.",
  );
});

test("stopping a request aborts the provider and never produces a fallback reply or plan", async () => {
  for (const kind of ["chat", "workflow", "universal"] as const) {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let providerSignal: AbortSignal | null | undefined;
    const provider = assistantProviderFromSettings({
      ...defaults,
      request: async (_, init) =>
        new Promise<Response>((_, reject) => {
          providerSignal = init?.signal;
          providerSignal?.addEventListener(
            "abort",
            () => reject(providerSignal?.reason),
            { once: true },
          );
          started();
        }),
    });
    provider.signal = controller.signal;
    const pending =
      kind === "chat"
        ? createAssistantChatResponse({
            actions: [],
            messages: [{ role: "user", content: "Hello" }],
            provider,
          })
        : kind === "workflow"
          ? createAssistantWorkflowPlan({
              actions: [],
              prompt: "Create a workflow",
              provider,
              workflow: {},
              workflowId: "new",
              validationErrors: [],
            })
          : createAssistantUniversalPlanDraft({
              context: {},
              prompt: "Create a job",
              provider,
              tools: [],
            });
    const rejected = assert.rejects(
      pending,
      (error: Error) => error.name === "AbortError",
    );
    await ready;
    controller.abort();
    await rejected;
    assert.equal(providerSignal?.aborted, true);
  }
});

test("provider catalog exposes BEAM AI as the only managed assistant router", () => {
  assert.deepEqual(
    ASSISTANT_PROVIDER_CATALOG.map((provider) => provider.id),
    [BEAM_AI_PROVIDER_ID],
  );
  assert.equal(ASSISTANT_PROVIDER_CATALOG[0]?.managed, true);
  assert.equal(ASSISTANT_PROVIDER_CATALOG[0]?.protocol, "openai-compatible");
});

test("BEAM AI settings need only one model and allow per-request overrides", () => {
  const configured = assistantProviderFromSettings(defaults);
  const overridden = assistantProviderFromSettings({
    ...defaults,
    selectedModel: "claude-test",
  });

  assert.equal(configured.model, "gpt-default");
  assert.equal(configured.models?.chat, "gpt-default");
  assert.equal(configured.models?.copilot, "gpt-default");
  assert.equal(configured.apiKeyConfigured, false);
  assert.equal(configured.status, "ready");
  assert.equal(overridden.model, "claude-test");
});

test("provider summaries never expose managed request credentials", () => {
  const provider = assistantProviderFromSettings({
    ...defaults,
    request: async () => new Response(),
  });
  const summary = assistantProviderConfigSummary(provider);

  assert.equal(summary.apiKeyConfigured, false);
  assert.equal("apiKey" in summary, false);
  assert.equal("request" in summary, false);
  assert.equal("requestHeaders" in summary, false);
  assert.equal("managedCredentials" in summary, false);
  provider.signal = new AbortController().signal;
  assert.equal("signal" in assistantProviderConfigSummary(provider), false);
});

test("BEAM AI uses the managed OpenAI-compatible proxy contract", async () => {
  let requestUrl = "";
  let requestHeaders = new Headers();
  let requestBody: Record<string, unknown> = {};
  const provider = assistantProviderFromSettings({
    ...defaults,
    request: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
        { status: 200 },
      );
    },
  });

  const result = await testAssistantProvider(provider);

  assert.equal(result.ok, true);
  assert.equal(requestUrl, "https://api.b1m.ai/api/ai/v1/chat/completions");
  assert.equal(requestHeaders.get("authorization"), null);
  assert.equal(requestHeaders.get("x-organization-id"), "org_1");
  assert.equal(requestBody.model, "gpt-default");
  assert.equal(requestBody.max_tokens, 4096);
});

test("reasoning effort uses the proxy's OpenAI-compatible shape", async () => {
  let requestBody: Record<string, unknown> = {};
  const provider = assistantProviderFromSettings({
    ...defaults,
    request: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Beam response" } }],
        }),
        { status: 200 },
      );
    },
  });

  await createAssistantChatResponse({
    actions: [],
    messages: [{ role: "user", content: "Hello" }],
    provider,
    reasoningEffort: "high",
  });

  assert.equal(requestBody.reasoning_effort, "high");
  assert.equal("temperature" in requestBody, false);
});

test("BEAM AI content parts are normalized into assistant text", async () => {
  const provider = assistantProviderFromSettings({
    ...defaults,
    request: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: "text", text: "Hello " },
                  { type: "text", text: "from Beam" },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
  });

  const response = await createAssistantChatResponse({
    actions: [],
    messages: [{ role: "user", content: "Hello" }],
    provider,
  });

  assert.equal(response.message, "Hello from Beam");
  assert.equal(response.degraded, false);
});

test("BEAM AI quota failures expose the proxy error behind the local fallback", async () => {
  const provider = assistantProviderFromSettings({
    ...defaults,
    request: async () =>
      new Response(
        JSON.stringify({ error: { message: "No Beam credits remaining" } }),
        { status: 402 },
      ),
  });

  const response = await createAssistantChatResponse({
    actions: [],
    messages: [{ role: "user", content: "Hello" }],
    provider,
  });

  assert.equal(response.degraded, true);
  assert.equal("error" in response ? response.error : undefined, "quota");
  assert.equal(
    "providerMessage" in response ? response.providerMessage : undefined,
    "No Beam credits remaining",
  );
});

test("model discovery uses the BEAM AI catalog and filters non-chat models", async () => {
  let requestUrl = "";
  let requestHeaders = new Headers();
  const provider = assistantProviderFromSettings({
    ...defaults,
    request: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          data: [
            { id: "text-embedding-3-small" },
            { id: "gpt-5.2", created: 1_700_000_000 },
            { id: "gpt-5.4", created: 1_900_000_000 },
            { id: "retired-chat", available: false },
            { id: "custom-chat-model", created: 1_800_000_000 },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const models = await listAssistantProviderModels(provider);

  assert.equal(
    requestUrl,
    "https://api.b1m.ai/api/ai/v1/models?api_shape=chat.completions",
  );
  assert.equal(requestHeaders.get("x-organization-id"), "org_1");
  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-5.4", "custom-chat-model", "gpt-5.2"],
  );
  assert.equal(
    models.find((model) => model.id === "gpt-5.4")?.recommended,
    true,
  );
});

test("model discovery falls back to natural descending version order", async () => {
  const provider = assistantProviderFromSettings({
    ...defaults,
    request: async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "gpt-5.9" }, { id: "gpt-5.10" }, { id: "gpt-4.1" }],
        }),
        { status: 200 },
      ),
  });

  const models = await listAssistantProviderModels(provider);

  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-5.10", "gpt-5.9", "gpt-4.1"],
  );
});
