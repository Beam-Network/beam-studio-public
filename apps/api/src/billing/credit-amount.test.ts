import assert from "node:assert/strict";
import test from "node:test";
import {
  fromHundredths,
  parseCreditAmount,
  roundCredits,
  sumCredits,
  toHundredths,
} from "./credit-amount.js";

test("prices and charges round up to the next 0.01 credit; zero stays zero", () => {
  assert.equal(parseCreditAmount(1, "up"), 1);
  assert.equal(parseCreditAmount(0.05, "up"), 0.05);
  // 1 GiB at 0.01 credit per GB is 10,738 microcredits.
  assert.equal(parseCreditAmount(0.010738, "up"), 0.02);
  assert.equal(parseCreditAmount(0.01, "up"), 0.01);
  assert.equal(parseCreditAmount(0.000001, "up"), 0.01);
  assert.equal(parseCreditAmount(0, "up"), 0);
  // Floating-point noise never adds a hundredth.
  assert.equal(parseCreditAmount(0.07, "up"), 0.07);
  assert.equal(parseCreditAmount(0.1 + 0.2, "up"), 0.3);
  assert.equal(parseCreditAmount(2.1234567, "up"), 2.13);
});

test("balances round down to 0.01 and may be negative, never -0", () => {
  assert.equal(parseCreditAmount(4.989262, "down"), 4.98);
  assert.equal(parseCreditAmount(0.009, "down"), 0);
  assert.equal(parseCreditAmount(-0.5, "down"), -0.5);
  assert.equal(parseCreditAmount(-0.001, "down"), -0.01);
  assert.ok(Object.is(parseCreditAmount(-0.0000001, "down"), 0));
  assert.ok(Object.is(roundCredits(-0.0000001, "up"), 0));
});

test("a value that is not a finite number is not a credit amount", () => {
  for (const value of [
    null,
    undefined,
    "1",
    Number.NaN,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.equal(parseCreditAmount(value, "up"), undefined, String(value));
    assert.equal(parseCreditAmount(value, "down"), undefined, String(value));
  }
});

test("credit amounts sum exactly in hundredths", () => {
  assert.equal(sumCredits([0.1, 0.2]), 0.3);
  assert.equal(sumCredits([1, 0.01, 0.01]), 1.02);
  assert.equal(sumCredits(Array.from({ length: 10 }, () => 0.1)), 1);
  assert.equal(sumCredits([]), 0);
});

test("hundredths convert both ways", () => {
  assert.equal(toHundredths(1), 100);
  assert.equal(toHundredths(0.01), 1);
  assert.equal(toHundredths(0.1 + 0.2), 30);
  assert.equal(fromHundredths(2), 0.02);
  assert.ok(Object.is(fromHundredths(-0), 0));
});
