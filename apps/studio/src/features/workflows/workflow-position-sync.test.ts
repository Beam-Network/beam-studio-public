import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkflowPositionSync,
  type PositionSyncState,
  type PositionSyncTransport,
} from "./workflow-position-sync";
import { workflowDefinitionSignature } from "./workflow-definition-signature";
import type {
  WorkflowLayout,
  WorkflowLayoutPatch,
} from "@beam-studio/shared";

test("default clock preserves the browser timer receiver", async (t) => {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  let checkReceiver = false;
  let scheduled = 0;
  let cancelled = 0;
  t.mock.method(globalThis, "setTimeout", function (
    this: unknown,
    callback: () => void,
    delay: number,
  ) {
    if (checkReceiver) {
      assert.equal(this, globalThis);
      scheduled++;
    }
    return set(callback, delay);
  });
  t.mock.method(globalThis, "clearTimeout", function (
    this: unknown,
    timer: ReturnType<typeof setTimeout>,
  ) {
    if (checkReceiver) {
      assert.equal(this, globalThis);
      cancelled++;
    }
    clear(timer);
  });
  const moduleUrl = new URL("./workflow-position-sync.ts", import.meta.url);
  moduleUrl.searchParams.set("timer-receiver", "isolated");
  const { WorkflowPositionSync: BrowserSync } = await import(moduleUrl.href) as
    typeof import("./workflow-position-sync");
  const sync = new BrowserSync(
    { read: async () => null, write: async () => ({ revision: 0 }) },
    () => {},
    () => {},
  );
  checkReceiver = true;
  try {
    sync.setActive(true);
    sync.dispose();
  } finally {
    checkReceiver = false;
    sync.dispose();
  }
  assert.equal(scheduled, 1);
  assert.equal(cancelled, 1);
});

function clock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    set(callback: () => void, delay: number) {
      const next = ++id;
      timers.set(next, { at: now + delay, callback });
      return next as unknown as ReturnType<typeof setTimeout>;
    },
    clear(value: ReturnType<typeof setTimeout>) {
      timers.delete(value as unknown as number);
    },
    async advance(delay: number) {
      now += delay;
      for (const [key, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(key);
        timer.callback();
      }
      // Drain request/finally/scheduling microtasks without wall-clock waiting.
      for (let i = 0; i < 15; i++) await Promise.resolve();
    },
    get count() {
      return timers.size;
    },
  };
}
function harness() {
  const time = clock();
  const writes: WorkflowLayoutPatch[] = [];
  const reads: (number | null)[] = [];
  const states: PositionSyncState[] = [];
  const received: WorkflowLayout[] = [];
  let layout: WorkflowLayout = {
    revision: 0,
    positions: [
      { nodeId: "a", x: 0, y: 0 },
      { nodeId: "b", x: 10, y: 10 },
    ],
  };
  let rejectWrite = false;
  let release: (() => void) | undefined;
  const transport: PositionSyncTransport = {
    async read(revision) {
      reads.push(revision);
      return revision === layout.revision ? null : structuredClone(layout);
    },
    async write(patch) {
      writes.push(structuredClone(patch));
      if (rejectWrite) throw new Error("Offline");
      if (patch.revision !== layout.revision)
        throw Object.assign(new Error("Changed"), {
          code: "workflow_layout_conflict",
        });
      if (release)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      layout = {
        revision: layout.revision + 1,
        positions: layout.positions.map(
          (p) => patch.positions.find((next) => next.nodeId === p.nodeId) ?? p,
        ),
      };
      return { revision: layout.revision };
    },
  };
  const sync = new WorkflowPositionSync(
    transport,
    (next) => received.push(next),
    (next) => states.push(next),
    time,
  );
  sync.setKnown(["a", "b"]);
  return {
    sync,
    transport,
    time,
    writes,
    reads,
    states,
    received,
    get layout() {
      return layout;
    },
    remote(next: WorkflowLayout) {
      layout = next;
    },
    offline(value: boolean) {
      rejectWrite = value;
    },
    hold() {
      release = () => {};
    },
    release() {
      release?.();
      release = undefined;
    },
  };
}

test("coalesces completed moves, writes changed nodes only and ignores unsaved nodes", async () => {
  const h = harness();
  h.sync.setActive(true);
  await h.time.advance(0);
  h.sync.enqueue([{ nodeId: "a", x: 1, y: 2 }]);
  await h.time.advance(200);
  h.sync.enqueue([
    { nodeId: "a", x: 3, y: 4 },
    { nodeId: "b", x: 10, y: 10 },
    { nodeId: "new", x: 5, y: 5 },
  ]);
  await h.time.advance(499);
  assert.equal(h.writes.length, 0);
  await h.time.advance(1);
  assert.deepEqual(h.writes, [
    { revision: 0, positions: [{ nodeId: "a", x: 3, y: 4 }] },
  ]);
  assert.equal(h.sync.hasPending, false);
  h.sync.enqueue([{ nodeId: "a", x: 3, y: 4 }]);
  await h.time.advance(500);
  assert.equal(h.writes.length, 1);
  h.sync.dispose();
});

test("rebases conflicting moves without overwriting another node", async () => {
  const h = harness();
  h.sync.setActive(true);
  await h.time.advance(0);
  h.sync.enqueue([{ nodeId: "a", x: 20, y: 20 }]);
  h.remote({
    revision: 1,
    positions: [
      { nodeId: "a", x: 0, y: 0 },
      { nodeId: "b", x: 99, y: 99 },
    ],
  });
  await h.sync.flush();
  assert.equal(h.layout.revision, 2);
  assert.deepEqual(h.layout.positions, [
    { nodeId: "a", x: 20, y: 20 },
    { nodeId: "b", x: 99, y: 99 },
  ]);
  assert.ok(h.writes.every((patch) => patch.positions.length === 1));
  h.sync.dispose();
});

test("moving back before debounce sends no request", async () => {
  const h = harness(); h.sync.setActive(true); await h.time.advance(0);
  h.sync.enqueue([{ nodeId: "a", x: 10, y: 10 }]);
  h.sync.enqueue([{ nodeId: "a", x: 0, y: 0 }]);
  await h.time.advance(500);
  assert.equal(h.writes.length, 0); assert.equal(h.sync.hasPending, false); h.sync.dispose();
});

test("two independent editors merge moves, synchronize and recover the stored layout on reopening", async () => {
  const h = harness();
  const otherReceived: WorkflowLayout[] = [];
  const other = new WorkflowPositionSync(
    h.transport,
    (layout) => otherReceived.push(layout),
    () => {},
    h.time,
  );
  other.setKnown(["a", "b"]);
  other.setActive(true);
  h.sync.setActive(true);
  await h.time.advance(0);
  h.sync.enqueue([{ nodeId: "a", x: 11, y: 11 }]);
  other.enqueue([{ nodeId: "b", x: 22, y: 22 }]);
  await h.sync.flush();
  await other.flush();
  assert.deepEqual(h.layout.positions, [
    { nodeId: "a", x: 11, y: 11 },
    { nodeId: "b", x: 22, y: 22 },
  ]);
  assert.ok(
    otherReceived.at(-1)?.positions.some((p) => p.nodeId === "a" && p.x === 11),
  );
  h.sync.enqueue([{ nodeId: "a", x: 33, y: 33 }]);
  await h.sync.flush();
  other.enqueue([{ nodeId: "a", x: 44, y: 44 }]);
  await other.flush();
  assert.equal(h.layout.positions[0]!.x, 44);
  other.dispose();
  h.sync.dispose();
  const reopened: WorkflowLayout[] = [];
  const restart = new WorkflowPositionSync(
    h.transport,
    (layout) => reopened.push(layout),
    () => {},
    h.time,
  );
  restart.setKnown(["a", "b"]);
  restart.setActive(true);
  await h.time.advance(0);
  assert.deepEqual(reopened[0], h.layout);
  restart.dispose();
});

test("serializes slow writes and preserves moves made during a request", async () => {
  const h = harness();
  h.sync.setActive(true);
  await h.time.advance(0);
  h.hold();
  h.sync.enqueue([{ nodeId: "a", x: 1, y: 1 }]);
  await h.time.advance(500);
  h.sync.enqueue([{ nodeId: "a", x: 2, y: 2 }]);
  await h.time.advance(500);
  assert.equal(h.writes.length, 1);
  assert.equal(h.sync.hasPending, true);
  h.release();
  await h.time.advance(0);
  await h.sync.flush();
  assert.equal(h.writes.length, 2);
  assert.equal(h.layout.positions[0]!.x, 2);
  h.sync.dispose();
});

test("conditional polling backs off when idle, pauses while hidden and refreshes on focus", async () => {
  const h = harness();
  h.sync.setActive(true);
  await h.time.advance(0);
  for (let i = 0; i < 6; i++) await h.time.advance(5_000);
  const count = h.reads.length;
  await h.time.advance(5_000);
  assert.equal(h.reads.length, count);
  await h.time.advance(25_000);
  assert.equal(h.reads.length, count + 1);
  assert.ok(h.reads.slice(1).every((revision) => revision === 0));
  h.sync.setActive(false);
  assert.equal(h.time.count, 0);
  await h.time.advance(60_000);
  assert.equal(h.reads.length, count + 1);
  h.sync.setActive(true);
  await h.time.advance(0);
  assert.equal(h.reads.length, count + 2);
  h.sync.dispose();
});

test("failed saves retain pending moves, back off and recover on explicit retry", async () => {
  const h = harness();
  h.sync.setActive(true);
  await h.time.advance(0);
  h.offline(true);
  h.sync.enqueue([{ nodeId: "a", x: 4, y: 4 }]);
  await h.time.advance(500);
  assert.equal(h.sync.hasPending, true);
  assert.equal(h.states.at(-1)?.error, "Offline");
  await h.time.advance(999);
  assert.equal(h.writes.length, 1);
  await h.time.advance(1);
  assert.equal(h.writes.length, 2);
  await h.time.advance(1_999);
  assert.equal(h.writes.length, 2);
  h.offline(false);
  await h.sync.flush();
  assert.equal(h.sync.hasPending, false);
  h.sync.dispose();
});

test("remote deletion fences pending coordinates; older snapshots cannot rewind revision", async () => {
  const h = harness();
  h.sync.setActive(true);
  await h.time.advance(0);
  h.sync.enqueue([{ nodeId: "a", x: 9, y: 9 }]);
  h.remote({ revision: 1, positions: [{ nodeId: "b", x: 10, y: 10 }] });
  await h.sync.flush();
  assert.equal(h.sync.hasPending, false);
  assert.ok(h.states.at(-1)?.error.includes("removed"));
  h.sync.enqueue([{ nodeId: "a", x: 12, y: 12 }]);
  assert.equal(h.sync.hasPending, false);
  h.sync.dispose();
});

test("layout changes are excluded from semantic dirty tracking; configuration and logical order remain edits", () => {
  const initial = {
    steps: [
      { id: "a", position: 0, canvasX: 1, canvasY: 2, config: { safe: true } },
    ],
    controls: [{ id: "loop", iterations: 2, layout: { x: 1, y: 2 } }],
  };
  const moved = structuredClone(initial);
  moved.steps[0]!.canvasX = 99;
  moved.controls[0]!.layout.y = 100;
  assert.equal(
    workflowDefinitionSignature(initial),
    workflowDefinitionSignature(moved),
  );
  moved.steps[0]!.config.safe = false;
  assert.notEqual(
    workflowDefinitionSignature(initial),
    workflowDefinitionSignature(moved),
  );
});
