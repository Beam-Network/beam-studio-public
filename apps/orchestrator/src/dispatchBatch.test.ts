import assert from "node:assert/strict";
import test from "node:test";
import { dispatchBatch } from "./dispatchBatch.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a stalled dispatch does not hold unrelated work and concurrency is bounded", async () => {
  const hold = deferred();
  const progress = deferred();
  const visited: number[] = [];
  let active = 0;
  let maximum = 0;
  const batch = dispatchBatch(
    Array.from({ length: 20 }, (_, index) => index),
    async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      visited.push(item);
      if (item === 0) await hold.promise;
      else await Promise.resolve();
      active -= 1;
      if (item === 19) progress.resolve();
    },
  );
  await progress.promise;
  assert.equal(visited.length, 20);
  assert.equal(active, 1);
  assert.equal(maximum, 4);
  hold.resolve();
  await batch;
  assert.equal(active, 0);
  assert.equal(new Set(visited).size, 20);
});

test("dispatch failures are returned only after started work settles", async () => {
  const hold = deferred();
  const error = new Error("authority unavailable");
  let drained = false;
  let returned = false;
  const batch = dispatchBatch([0, 1], async (item) => {
    if (item === 0) throw error;
    await hold.promise;
    drained = true;
  });
  const checked = assert.rejects(batch, (observed) => {
    assert.equal(observed, error);
    assert.equal(drained, true);
    returned = true;
    return true;
  });
  await Promise.resolve();
  assert.equal(returned, false);
  hold.resolve();
  await checked;
});

test("an empty dispatch batch performs no work", async () => {
  await dispatchBatch([], async () => {
    assert.fail("empty batch callback");
  });
});
