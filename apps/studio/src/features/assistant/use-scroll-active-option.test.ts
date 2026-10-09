import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useScrollActiveOption } from "./use-scroll-active-option";

test("arrow navigation keeps the selected mention visible, including wraparound", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const scrolled: string[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) {
    assert.deepEqual(options, { block: "nearest", inline: "nearest" });
    scrolled.push(this.textContent!);
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  function Mentions() {
    const [selected, select] = useState(0);
    const list = useScrollActiveOption(selected, 12, true);
    return h(
      "div",
      {
        ref: list,
        onKeyDown: (event: { key: string }) =>
          select(
            (current) =>
              (current + (event.key === "ArrowDown" ? 1 : -1) + 12) % 12,
          ),
      },
      ...Array.from({ length: 12 }, (_, index) =>
        h(
          "button",
          { key: index, "aria-selected": index === selected },
          `Mention ${index}`,
        ),
      ),
    );
  }
  try {
    await act(() => root.render(h(Mentions)));
    const list = dom.window.document.getElementById("root")!.firstElementChild!;
    for (let i = 0; i < 12; i++)
      await act(() =>
        list.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
          }),
        ),
      );
    await act(() =>
      list.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowUp",
          bubbles: true,
        }),
      ),
    );
    assert.deepEqual(scrolled, [
      ...Array.from({ length: 12 }, (_, index) => `Mention ${index}`),
      "Mention 0",
      "Mention 11",
    ]);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});
