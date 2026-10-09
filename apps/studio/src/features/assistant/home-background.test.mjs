import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { act, createElement as h } from "react";
import { JSDOM } from "jsdom";

// Transform the real Home with Vite's existing transpiler. Only the shell and
// model selectors are replaced; routing, mutations, polling and composer run as shipped.
test("Home submits independent server jobs, observes ready replies and survives closing the tab", async () => {
  const require = createRequire(import.meta.url);
  const viteRequire = createRequire(require.resolve("vite"));
  const { build } = await import(
    pathToFileURL(viteRequire.resolve("esbuild")).href
  );
  const studioRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const directory = await mkdtemp(`${studioRoot}/.assistant-test-`);
  const output = `${directory}/home.mjs`;
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://studio.test",
    pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    DocumentFragment: dom.window.DocumentFragment,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    scrollTo() {},
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals)
      .concat("fetch")
      .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const conversations = new Map();
  let submissions = 0;
  let cancellations = 0;
  const keys = new Set();
  const response = (value) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "https://studio.test").pathname.replace(
      /^\/__studio_api/,
      "",
    );
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/studio/session")
      return response({ session: { userId: "user" } });
    if (path === "/studio/organizations")
      return response({
        selectedOrganizationId: "org",
        organizations: [{ id: "org", credits: 1000 }],
        consoleUrl: "https://console.test",
      });
    if (path === "/studio/ai/providers")
      return response({
        providers: [{ id: "beam", provider: "beam", model: "test" }],
        settings: {},
      });
    if (path === "/studio/ai/models")
      return response({ models: [{ id: "test", name: "Test" }] });
    if (path === "/studio/assistant/context")
      return response({ workflows: [] });
    if (path === "/studio/assistant/requests") {
      submissions++;
      assert.ok(!keys.has(body.idempotencyKey));
      keys.add(body.idempotencyKey);
      const id = body.conversationId || `chat-${submissions}`;
      const request = {
        id: `request-${submissions}`,
        conversationId: id,
        status: "running",
        error: null,
        errorCode: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      const conversation = {
        id,
        title: body.prompt,
        request,
        unread: false,
        archivedAt: null,
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
        messageCount: 1,
        messages: [
          {
            id: `user-${submissions}`,
            content: body.prompt,
            role: "user",
            meta: {},
          },
        ],
      };
      conversations.set(id, conversation);
      return response({ conversationId: id, request });
    }
    if (path === "/studio/assistant/conversations") {
      const archived = new URL(
        String(input),
        "https://studio.test",
      ).searchParams.get("archived");
      return response({
        conversations: archived === "true" ? [] : [...conversations.values()],
      });
    }
    const match = /^\/studio\/assistant\/conversations\/([^/]+)(\/read)?$/.exec(
      path,
    );
    if (match) {
      const conversation = conversations.get(match[1]);
      assert.ok(conversation, `Unknown conversation ${match[1]}`);
      if (match[2]) {
        assert.equal(body.requestId, conversation.request.id);
        conversation.unread = false;
        return response({ ok: true });
      }
      return response({ conversation });
    }
    if (path.endsWith("/cancel") || path.endsWith("/retry")) {
      const id = path.split("/").at(-2);
      const conversation = [...conversations.values()].find(
        (chat) => chat.request.id === id,
      );
      assert.ok(conversation);
      if (path.endsWith("/cancel")) {
        cancellations++;
        conversation.request.status = "cancelled";
        conversation.request.completedAt = new Date().toISOString();
      } else {
        conversation.request.status = "running";
        conversation.request.completedAt = null;
      }
      return response({
        conversationId: conversation.id,
        request: conversation.request,
      });
    }
    throw new Error(`Unexpected API call ${path}`);
  };
  let root;
  let client;
  try {
    await build({
      absWorkingDir: studioRoot,
      entryPoints: ["./src/routes/new.tsx"],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      jsx: "automatic",
      define: { "import.meta.env": "{}" },
      plugins: [
        {
          name: "test-shell",
          setup(build) {
            build.onResolve(
              {
                filter:
                  /^@\/components\/(app-shell|assistant-model-selector|assistant-effort-selector)$/,
              },
              ({ path }) => ({ path, namespace: "test-shell" }),
            );
            build.onLoad({ filter: /.*/, namespace: "test-shell" }, () => ({
              contents: `import {createElement as h} from 'react'; export function AppShell({children}) { return h('main',null,children) } export function PageControls({children}) { return h('div',null,children) } export const AssistantModelSelector=()=>null; export const AssistantEffortSelector=()=>null;`,
              loader: "js",
              resolveDir: studioRoot,
            }));
          },
        },
      ],
    });
    const { HomePage } = await import(pathToFileURL(output).href);
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } =
      await import("@tanstack/react-query");
    const {
      createRootRoute,
      createRoute,
      createRouter,
      createMemoryHistory,
      RouterProvider,
    } = await import("@tanstack/react-router");
    const mount = async (path) => {
      client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: 0 },
          mutations: { gcTime: 0 },
        },
      });
      const base = createRootRoute();
      const home = createRoute({
        getParentRoute: () => base,
        id: "_home",
        component: HomePage,
      });
      home.addChildren([
        createRoute({ getParentRoute: () => home, path: "/" }),
        createRoute({ getParentRoute: () => home, path: "c/$id" }),
      ]);
      const router = createRouter({
        routeTree: base.addChildren([home]),
        history: createMemoryHistory({ initialEntries: [path] }),
        isServer: false,
      });
      root = createRoot(dom.window.document.getElementById("root"));
      await act(async () => {
        await router.load();
        root.render(
          h(QueryClientProvider, { client }, h(RouterProvider, { router })),
        );
      });
      return router;
    };
    const wait = async (predicate) => {
      const deadline = Date.now() + 4500;
      while (!predicate()) {
        if (Date.now() > deadline)
          throw new Error("Timed out waiting for Home state");
        await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
      }
    };
    const submit = async (prompt) => {
      await wait(
        () =>
          dom.window.document.querySelector("textarea") &&
          !dom.window.document.querySelector("textarea").disabled,
      );
      const textarea = dom.window.document.querySelector("textarea");
      await act(() => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        ).set.call(textarea, prompt);
        textarea.dispatchEvent(
          new dom.window.Event("input", { bubbles: true }),
        );
      });
      await act(() =>
        textarea
          .closest("form")
          .dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
    };
    const complete = (id) => {
      const conversation = conversations.get(id);
      conversation.request.status = "succeeded";
      conversation.request.completedAt = new Date().toISOString();
      conversation.messages.push({
        id: `answer-${id}`,
        role: "assistant",
        content: `Answer for ${id}`,
        meta: {},
      });
      conversation.messageCount++;
      conversation.unread = true;
      conversation.updatedAt = conversation.request.completedAt;
    };
    let router = await mount("/");
    await submit("First conversation");
    await wait(
      () =>
        router.state.location.pathname === "/c/chat-1" &&
        dom.window.document.body.textContent.includes("Working…"),
    );
    const newChat = dom.window.document.querySelector(
      'button[aria-label="Start a new conversation"]',
    );
    assert.equal(
      newChat.disabled,
      false,
      "a running job must not prevent a new chat",
    );
    await act(() => newChat.click());
    await wait(() => router.state.location.pathname === "/");
    await submit("Second conversation");
    await wait(
      () => router.state.location.pathname === "/c/chat-2" && submissions === 2,
    );
    assert.equal(conversations.get("chat-1").request.status, "running");
    complete("chat-1");
    await wait(() =>
      dom.window.document.body.textContent.includes("Response ready"),
    );
    assert.equal(
      conversations.get("chat-1").unread,
      true,
      "another chat's answer must remain unread",
    );
    // Closing the tab has no effect on either durable request.
    await act(() => root.unmount());
    root = undefined;
    client.clear();
    assert.equal(cancellations, 0);
    complete("chat-2");
    router = await mount("/c/chat-2");
    await wait(() =>
      dom.window.document.body.textContent.includes("Answer for chat-2"),
    );
    await wait(() => conversations.get("chat-2").unread === false);
    assert.equal(conversations.get("chat-1").unread, true);
    assert.equal(
      submissions,
      2,
      "reopening the tab must never resubmit a message",
    );
    assert.equal(conversations.get("chat-2").messages.length, 2);
    await act(async () => {
      await router.navigate({ to: "/" });
    });
    await submit("Third conversation");
    await wait(
      () =>
        router.state.location.pathname === "/c/chat-3" &&
        dom.window.document.querySelector('button[aria-label="Stop response"]'),
    );
    await act(() =>
      dom.window.document
        .querySelector('button[aria-label="Stop response"]')
        .click(),
    );
    await wait(
      () =>
        conversations.get("chat-3").request.status === "cancelled" &&
        dom.window.document.body.textContent.includes("Retry response"),
    );
    const retry = [...dom.window.document.querySelectorAll("button")].find(
      (button) => button.textContent.includes("Retry response"),
    );
    await act(() => retry.click());
    await wait(
      () =>
        conversations.get("chat-3").request.status === "running" &&
        dom.window.document.querySelector('button[aria-label="Stop response"]'),
    );
    assert.equal(
      cancellations,
      1,
      "only the explicit Stop button cancels a server request",
    );
    assert.equal(
      conversations.get("chat-3").messages.length,
      1,
      "retrying keeps the same persisted user message",
    );
    assert.equal(submissions, 3);
  } finally {
    if (root) await act(() => root.unmount());
    client?.clear();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
