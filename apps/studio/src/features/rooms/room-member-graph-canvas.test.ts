import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountRoomGraph } from "./room-member-graph-canvas";

test("canvas follows vertical drag, caps frame rate/DPR and suspends for visibility, intersection, pause and reduced motion", () => {
  const dom = new JSDOM(
    '<canvas style="--background:0 0% 0%;--primary:160 100% 50%;--muted-foreground:0 0% 50%"></canvas>',
    { pretendToBeVisual: true },
  );
  const canvas = dom.window.document.querySelector("canvas")!;
  let draws = 0,
    id = 0,
    nodeY = 0;
  const frames = new Map<number, FrameRequestCallback>();
  let resize = () => {},
    intersection: (entries: { isIntersecting: boolean }[]) => void = () => {};
  const media = Object.assign(new dom.window.EventTarget(), { matches: false });
  const ctx = new Proxy(
    {},
    {
      get: (_, key) =>
        key === "clearRect"
          ? () => {
              draws++;
            }
          : key === "arc"
            ? (_x: number, y: number, radius: number) => {
                if (radius > 3) nodeY = y;
              }
            : key === "measureText"
              ? () => ({ width: 30 })
              : () => {},
    },
  );
  Object.defineProperty(canvas, "getContext", { value: () => ctx });
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ width: 600, height: 400, left: 0, top: 0 }),
  });
  Object.defineProperty(canvas, "setPointerCapture", { value: () => {} });
  Object.defineProperty(canvas, "hasPointerCapture", { value: () => false });
  Object.defineProperty(dom.window, "devicePixelRatio", { value: 3 });
  Object.defineProperty(dom.window, "matchMedia", { value: () => media });
  class Resize {
    constructor(callback: () => void) {
      resize = callback;
    }
    observe() {}
    disconnect() {}
  }
  class Intersection {
    constructor(callback: typeof intersection) {
      intersection = callback;
    }
    observe() {}
    disconnect() {}
  }
  const values = {
    window: dom.window,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: Resize,
    IntersectionObserver: Intersection,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    },
    cancelAnimationFrame: (key: number) => frames.delete(key),
  };
  const saved = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.assign(globalThis, values);
  try {
    const controller = mountRoomGraph(
      canvas as unknown as HTMLCanvasElement,
      () => {},
      () => {},
    )!;
    const graph = { nodes: [], links: [], channels: [] };
    controller.update(graph, {}, null, false);
    resize();
    assert.equal(canvas.width, 1200);
    assert.equal(canvas.height, 800);
    assert.equal(frames.size, 0);
    intersection([{ isIntersecting: true }]);
    assert.equal(frames.size, 1);
    function frame(time: number) {
      const entry = [...frames][0]!;
      frames.delete(entry[0]);
      entry[1](time);
    }
    frame(100);
    const baseline = draws;
    frame(116);
    assert.equal(draws, baseline);
    frame(134);
    assert.equal(draws, baseline + 1);
    media.matches = true;
    media.dispatchEvent(new dom.window.Event("change"));
    assert.equal(frames.size, 0);
    media.matches = false;
    media.dispatchEvent(new dom.window.Event("change"));
    assert.equal(frames.size, 1);
    controller.update(graph, {}, null, true);
    assert.equal(frames.size, 0);
    controller.update(graph, {}, null, false);
    assert.equal(frames.size, 1);
    intersection([{ isIntersecting: false }]);
    const offscreen = draws;
    controller.update(graph, {}, null, false);
    assert.equal(draws, offscreen);
    assert.equal(frames.size, 0);
    intersection([{ isIntersecting: true }]);
    Object.defineProperty(dom.window.document, "hidden", {
      configurable: true,
      value: true,
    });
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    assert.equal(frames.size, 0);
    Object.defineProperty(dom.window.document, "hidden", {
      configurable: true,
      value: false,
    });
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    assert.equal(frames.size, 1);
    controller.update(
      {
        nodes: [
          {
            id: "front",
            name: "Front",
            kind: "agent",
            roles: [],
            privileged: false,
            active: true,
            send: true,
            receive: true,
            permissions: [],
            position: [0, 0, 1],
          },
        ],
        links: [],
        channels: [],
      },
      { front: "online" },
      null,
      true,
    );
    const initialY = nodeY;
    canvas.dispatchEvent(
      new dom.window.MouseEvent("pointerdown", {
        clientX: 300,
        clientY: 200,
        button: 0,
      }),
    );
    canvas.dispatchEvent(
      new dom.window.MouseEvent("pointermove", { clientX: 300, clientY: 240 }),
    );
    assert.ok(nodeY > initialY, "dragging down moves the front node down");
    canvas.dispatchEvent(
      new dom.window.MouseEvent("pointermove", { clientX: 300, clientY: 160 }),
    );
    assert.ok(nodeY < initialY, "dragging up moves the front node up");
    canvas.dispatchEvent(
      new dom.window.MouseEvent("pointerup", { clientX: 300, clientY: 160 }),
    );
    controller.dispose();
    assert.equal(frames.size, 0);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
