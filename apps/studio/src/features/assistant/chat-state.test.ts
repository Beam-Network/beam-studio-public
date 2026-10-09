import assert from "node:assert/strict";
import test from "node:test";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  draftStorageKey,
  groupConversations,
  isNearLatest,
  pendingRequestId,
  readStoredDraft,
  useStoredDraft,
} from "./chat-state.js";

test("drafts survive switching conversations and remounting, without crossing account or organization boundaries", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://studio.test",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let key = draftStorageKey("user-a", "org-a", "chat-a");
  let draft = "";
  let update: (value: string) => void = () => {};
  function Probe() {
    [draft, update] = useStoredDraft(key, "");
    return createElement("span", null, draft);
  }
  const container = dom.window.document.getElementById("root")!;
  let root = createRoot(container);
  try {
    await act(() => root.render(createElement(Probe)));
    await act(() => update("Unfinished workflow"));
    key = draftStorageKey("user-a", "org-a", "chat-b");
    await act(() => root.render(createElement(Probe)));
    assert.equal(draft, "");
    await act(() => update("Second draft"));
    key = draftStorageKey("user-a", "org-a", "chat-a");
    await act(() => root.render(createElement(Probe)));
    assert.equal(draft, "Unfinished workflow");
    await act(() => root.unmount());
    root = createRoot(container);
    await act(() => root.render(createElement(Probe)));
    assert.equal(draft, "Unfinished workflow");
    assert.equal(
      readStoredDraft(draftStorageKey("user-b", "org-a", "chat-a"), ""),
      "",
    );
    assert.equal(
      readStoredDraft(draftStorageKey("user-a", "org-b", "chat-a"), ""),
      "",
    );
    await act(() => update(""));
    assert.equal(dom.window.localStorage.getItem(key), null);
    dom.window.localStorage.setItem(key, "invalid json");
    assert.equal(readStoredDraft(key, ""), "");
    dom.window.localStorage.setItem(key, "{}");
    assert.equal(readStoredDraft(key, ""), "");
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      IS_REACT_ACT_ENVIRONMENT: false,
    });
    dom.window.close();
  }
});

test("history search groups by local calendar days, sorts newest first, and does not mutate cached records", () => {
  const now = new Date(2026, 8, 13, 8);
  const conversations = [
    {
      title: "Workflow old",
      updatedAt: new Date(2026, 8, 11, 23).toISOString(),
    },
    {
      title: "Workflow today",
      updatedAt: new Date(2026, 8, 13, 1).toISOString(),
    },
    {
      title: "Job yesterday",
      updatedAt: new Date(2026, 8, 12, 23).toISOString(),
    },
    {
      title: "Workflow latest",
      updatedAt: new Date(2026, 8, 13, 7).toISOString(),
    },
  ];
  const groups = groupConversations(conversations, "", now);
  assert.deepEqual(
    groups.map(([label]) => label),
    ["Today", "Yesterday", "Earlier"],
  );
  assert.equal(groups[0]?.[1][0]?.title, "Workflow latest");
  assert.equal(conversations[0]?.title, "Workflow old");
  assert.equal(
    groupConversations(conversations, "  JOB  ", now)[0]?.[0],
    "Yesterday",
  );
  assert.deepEqual(groupConversations(conversations, "absent", now), []);
});

test("only an unchanged failed prompt reuses its persisted request identity", () => {
  const stored = JSON.stringify({ id: "turn-a", content: "Create a workflow" });
  assert.equal(pendingRequestId(stored, "Create a workflow"), "turn-a");
  assert.equal(pendingRequestId(stored, "Create a different workflow"), null);
  assert.equal(pendingRequestId("broken", "Create a workflow"), null);
});

test("reading older messages is distinguished from following the latest reply", () => {
  assert.equal(
    isNearLatest({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 }),
    true,
  );
  assert.equal(
    isNearLatest({ scrollHeight: 2000, clientHeight: 600, scrollTop: 500 }),
    false,
  );
});
