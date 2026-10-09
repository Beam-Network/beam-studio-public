import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDebouncedValue } from "./use-debounced-value";

test("coalesces edits and discards pending work on input changes and unmount", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM("<div id='root'></div>");
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
  function View({ input }: { input: string }) {
    return createElement("output", null, useDebouncedValue(input, 500));
  }
  const render = (input: string) =>
    act(() => root.render(createElement(View, { input })));
  const advance = (ms: number) => act(() => context.mock.timers.tick(ms));
  try {
    await render("");
    await render("hippius:b");
    await advance(300);
    await render("hippius:beam");
    await advance(499);
    assert.equal(dom.window.document.querySelector("output")!.textContent, "");
    await render("hippius:beam-dev");
    await advance(500);
    assert.equal(
      dom.window.document.querySelector("output")!.textContent,
      "hippius:beam-dev",
    );
    await render("r2:example-bucket");
    await advance(499);
    assert.equal(
      dom.window.document.querySelector("output")!.textContent,
      "hippius:beam-dev",
    );
    await advance(1);
    assert.equal(
      dom.window.document.querySelector("output")!.textContent,
      "r2:example-bucket",
    );
    await render("discarded");
    await act(() => root.unmount());
    await advance(500);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
