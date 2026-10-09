import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes } from "./format-bytes";

test("binary units with IEC labels", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(1_073_741_824), "1.0 GiB");
  assert.equal(formatBytes(20_000_000_000), "18.6 GiB");
  assert.equal(formatBytes(500 * 1_073_741_824), "500 GiB");
  assert.equal(formatBytes(3 * 1024 ** 4), "3.0 TiB");
});

test("a value that rounds up to 1024 moves to the next unit", () => {
  assert.equal(formatBytes(1024 * 1024 - 1), "1.0 MiB");
});

test("anything but a byte count is left to the caller", () => {
  for (const value of [null, undefined, Number.NaN, -1, Infinity])
    assert.equal(formatBytes(value), null);
});
