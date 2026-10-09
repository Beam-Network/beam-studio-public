import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement as h } from "react";
import { JSDOM } from "jsdom";

test("conversation controls open a portal menu, select a view, show a dismissible retry toast, and copy a sent message", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://studio.test",
    pretendToBeVisual: true,
  });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    DocumentFragment: dom.window.DocumentFragment,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: {
      writeText: async (value: string) => {
        copied = value;
      },
    },
  });
  const { createRoot } = await import("react-dom/client");
  const {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
  } = await import("./dropdown-menu.js");
  const { ToastProvider, useToast } = await import("./toast.js");
  const { CopyButton } = await import("../copy-button.js");
  let selected = "active";
  let retries = 0;
  function Probe() {
    const { notify } = useToast();
    return h(
      "div",
      null,
      h(
        DropdownMenu,
        null,
        h(DropdownMenuTrigger, { "aria-label": "View options" }, "More"),
        h(
          DropdownMenuContent,
          null,
          h(
            DropdownMenuRadioGroup,
            {
              value: selected,
              onValueChange: (value: string) => {
                selected = value;
              },
            },
            h(DropdownMenuRadioItem, { value: "active" }, "Active"),
            h(DropdownMenuRadioItem, { value: "archived" }, "Archived"),
          ),
        ),
      ),
      h(
        "button",
        {
          onClick: () =>
            notify({
              message: "Could not send message",
              variant: "error",
              action: {
                label: "Try again",
                onClick: () => {
                  retries++;
                },
              },
            }),
        },
        "Notify",
      ),
      h(CopyButton, {
        label: "Copy message",
        value: "An already sent message",
      }),
    );
  }
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const query = (selector: string) =>
    dom.window.document.querySelector<HTMLElement>(selector)!;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  try {
    await act(async () => {
      root.render(h(ToastProvider, null, h(Probe)));
      await settle();
    });
    const trigger = query('[aria-label="View options"]');
    await act(async () => {
      trigger.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
      await settle();
    });
    assert.ok(query('[role="menu"]'));
    assert.equal(container.contains(query('[role="menu"]')), false);
    assert.equal(
      query('[role="menuitemradio"][aria-checked="true"]').textContent,
      "Active",
    );
    const archived = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]',
      ),
    ].find((item) => item.textContent === "Archived")!;
    await act(async () => {
      archived.click();
      await settle();
    });
    assert.equal(selected, "archived");
    assert.equal(query('[role="menu"]'), null);
    const notify = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Notify",
    )!;
    await act(async () => {
      notify.click();
      await settle();
    });
    const viewport = query('[aria-label="Notifications"]');
    assert.match(viewport.textContent ?? "", /Could not send message/);
    const retry = [...viewport.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    await act(async () => {
      retry.click();
      await settle();
    });
    assert.equal(retries, 1);
    assert.doesNotMatch(viewport.textContent ?? "", /Could not send message/);
    await act(async () => {
      query('[aria-label="Copy message"]').click();
    });
    assert.equal(copied, "An already sent message");
    assert.ok(query('[aria-label="Copied"]'));
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
