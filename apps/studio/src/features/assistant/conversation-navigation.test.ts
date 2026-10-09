import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement as h, useEffect } from "react";
import { JSDOM } from "jsdom";
import {
  conversationHref,
  conversationIdFromPath,
  lastConversationKey,
  useLastConversation,
} from "./conversation-navigation";

test("conversation URLs round-trip IDs and leave Home as a new chat", () => {
  assert.equal(conversationHref(null), "/");
  assert.equal(conversationIdFromPath("/"), null);
  assert.equal(conversationIdFromPath("/c/%invalid"), null);
  for (const id of ["chat_123", "id with spaces", "id/with/slashes"]) {
    assert.equal(conversationIdFromPath(conversationHref(id)), id);
  }
  assert.notEqual(
    lastConversationKey("alice", "org1"),
    lastConversationKey("bob", "org1"),
  );
  assert.notEqual(
    lastConversationKey("alice", "org1"),
    lastConversationKey("alice", "org2"),
  );
  assert.equal(lastConversationKey(undefined, "org1"), null);
});

test("Home links update immediately across consumers and remain scoped", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://studio.test",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Event: globalThis.Event,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let remember!: (id: string) => void;
  function Writer() {
    [, remember] = useLastConversation("alice", "org1");
    return null;
  }
  function HomeLink({ organizationId }: { organizationId: string }) {
    const [id] = useLastConversation("alice", organizationId);
    return h("a", { href: conversationHref(id) }, "Home");
  }
  const render = (organizationId = "org1") =>
    root.render(h("div", null, h(Writer), h(HomeLink, { organizationId })));
  try {
    await act(() => render());
    await act(() => remember("chat_1"));
    assert.equal(
      dom.window.document.querySelector("a")?.getAttribute("href"),
      "/c/chat_1",
    );
    await act(() => render("org2"));
    assert.equal(
      dom.window.document.querySelector("a")?.getAttribute("href"),
      "/",
    );
    await act(() => render());
    assert.equal(
      dom.window.document.querySelector("a")?.getAttribute("href"),
      "/c/chat_1",
    );
    await act(() => remember(""));
    assert.equal(
      dom.window.document.querySelector("a")?.getAttribute("href"),
      "/",
    );
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

test("the shared chat layout survives URL creation and restores back/forward targets", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://studio.test",
    pretendToBeVisual: true,
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    self: globalThis.self,
    scrollTo: globalThis.scrollTo,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    self: dom.window,
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const {
    createRootRoute,
    createRoute,
    createRouter,
    createMemoryHistory,
    RouterProvider,
    useLocation,
  } = await import("@tanstack/react-router");
  const restored: string[] = [];
  let mounts = 0;
  let unmounts = 0;
  function Chat() {
    const location = useLocation();
    useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    useEffect(() => {
      restored.push(conversationIdFromPath(location.pathname) ?? "");
    }, [location.pathname]);
    return h("div", null, location.pathname);
  }
  const rootRoute = createRootRoute();
  const home = createRoute({
    getParentRoute: () => rootRoute,
    id: "_home",
    component: Chat,
  });
  home.addChildren([
    createRoute({ getParentRoute: () => home, path: "/" }),
    createRoute({ getParentRoute: () => home, path: "c/$id" }),
  ]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    await act(async () => {
      await router.load();
      root.render(h(RouterProvider, { router }));
    });
    await act(settle);
    assert.deepEqual(restored, [""]);
    await act(async () => {
      await router.navigate({
        to: "/c/$id",
        params: { id: "first" },
        replace: true,
      });
    });
    await act(settle);
    assert.equal(mounts, 1);
    assert.equal(
      unmounts,
      0,
      "changing the URL must not abort a pending response by unmounting the chat",
    );
    await act(async () => {
      await router.navigate({ to: "/c/$id", params: { id: "second" } });
    });
    await act(settle);
    await act(async () => {
      router.history.back();
      await settle();
    });
    await act(settle);
    assert.equal(router.state.location.pathname, "/c/first");
    await act(async () => {
      router.history.forward();
      await settle();
    });
    await act(settle);
    await act(async () => {
      await router.navigate({ to: "/" });
    });
    await act(settle);
    assert.deepEqual(restored, ["", "first", "second", "first", "second", ""]);
    assert.equal(mounts, 1);
    assert.equal(unmounts, 0);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});
