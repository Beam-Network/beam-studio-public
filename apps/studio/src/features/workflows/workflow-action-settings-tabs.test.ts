import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ActionSettingsTabs,
  actionIssueTab,
} from "./workflow-action-settings-tabs";

function DraftEditor() {
  const [draft, setDraft] = useState("{}");
  return createElement("textarea", {
    "aria-label": "JSON draft",
    value: draft,
    onInput: (event: React.FormEvent<HTMLTextAreaElement>) =>
      setDraft(event.currentTarget.value),
  });
}

test("action tabs preserve drafts, support keyboard navigation, and expose all issues", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  const globals = globalThis as unknown as Record<string, unknown>;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const issues = [
    "Beam transfer requires a Beam credential.",
    "Upload requires a content binding.",
    "Unknown action @example/missing.",
  ];
  const render = (nodeId: string) =>
    createElement(ActionSettingsTabs, {
      key: nodeId,
      name: createElement("input", { "aria-label": "Name" }),
      configuration: createElement(DraftEditor),
      inputs: createElement("input", { "aria-label": "Input binding" }),
      settings: createElement("input", {
        type: "checkbox",
        "aria-label": "Enabled",
      }),
      issues,
    });
  try {
    await act(async () => root.render(render("node-1")));
    const doc = dom.window.document;
    const tabs = [...doc.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const panels = [...doc.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    assert.equal(tabs.length, 3);
    const expectActive = (index: number) => {
      tabs.forEach((tab, i) => {
        assert.equal(tab.getAttribute("aria-selected"), String(i === index));
        assert.equal(tab.tabIndex, i === index ? 0 : -1);
        assert.equal(tab.getAttribute("aria-controls"), panels[i]!.id);
        assert.equal(panels[i]!.getAttribute("aria-labelledby"), tab.id);
        assert.equal(panels[i]!.hidden, i !== index);
      });
      assert.equal(
        doc.querySelector('[aria-label="Validation issues"]')?.textContent,
        issues.join(""),
      );
    };
    expectActive(0);
    assert.match(tabs[0]!.textContent!, /1 validation issues/);
    assert.match(tabs[1]!.textContent!, /1 validation issues/);
    assert.doesNotMatch(tabs[2]!.textContent!, /validation issues/);
    const draft = doc.querySelector("textarea")!;
    await act(async () => {
      draft.value = '{"unfinished":';
      draft.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => tabs[1]!.click());
    expectActive(1);
    await act(async () => tabs[0]!.click());
    assert.equal(doc.querySelector("textarea"), draft);
    assert.equal(draft.value, '{"unfinished":');
    for (const [from, key, to] of [
      [0, "ArrowLeft", 2],
      [2, "ArrowRight", 0],
      [0, "End", 2],
      [2, "Home", 0],
      [0, "ArrowRight", 1],
    ] as const) {
      await act(async () =>
        tabs[from]!.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key, bubbles: true }),
        ),
      );
      expectActive(to);
      assert.equal(doc.activeElement, tabs[to]);
    }
    await act(async () => root.render(render("node-1")));
    assert.equal(draft.value, '{"unfinished":');
    await act(async () => root.render(render("node-2")));
    assert.equal(
      doc.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
      "true",
    );
    assert.equal(doc.querySelector("textarea")?.value, "{}");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
});

test("only known validation messages are attributed to action tabs", () => {
  assert.equal(
    actionIssueTab("Binding references missing step source."),
    "inputs",
  );
  assert.equal(
    actionIssueTab("Binding expression ${bad} is not supported."),
    "inputs",
  );
  assert.equal(
    actionIssueTab("Beam transfer requires a Beam credential."),
    "configuration",
  );
  assert.equal(actionIssueTab("Unknown action @example/missing."), undefined);
  assert.equal(
    actionIssueTab("A future configuration error mentioning a binding."),
    undefined,
  );
});
