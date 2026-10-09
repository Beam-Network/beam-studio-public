import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCreditAmount,
  formatCredits,
  toHundredths,
} from "./format-credits";

test("credit amounts show at most two decimals with trailing zeros trimmed", () => {
  assert.equal(formatCreditAmount(0.05), "0.05");
  assert.equal(formatCreditAmount(0.2), "0.2");
  assert.equal(formatCreditAmount(0.02), "0.02");
  assert.equal(formatCreditAmount(3), "3");
  assert.equal(formatCreditAmount(1.5), "1.5");
  assert.equal(formatCreditAmount(1.1), "1.1");
  assert.equal(formatCreditAmount(1234.5), "1,234.5");
  // Never more than two decimals, whatever arrives.
  assert.equal(formatCreditAmount(0.0125), "0.01");
  assert.equal(formatCreditAmount(1.000001), "1");
});

test("floating-point noise is not shown and nothing reads as -0", () => {
  assert.equal(formatCreditAmount(0.1 + 0.2), "0.3");
  assert.equal(formatCreditAmount(7 * 0.07), "0.49");
  assert.equal(formatCreditAmount(0.004), "0");
  assert.equal(formatCreditAmount(-0.004), "0");
  assert.equal(formatCreditAmount(-0), "0");
});

test("negative balances and non-numbers are shown without breaking", () => {
  assert.equal(formatCreditAmount(-0.5), "-0.5");
  assert.equal(formatCreditAmount(-12.25), "-12.25");
  assert.equal(formatCreditAmount(Number.NaN), "0");
  assert.equal(formatCreditAmount(Number.POSITIVE_INFINITY), "0");
});

test("the unit is singular only for exactly one credit", () => {
  assert.equal(formatCredits(1), "1 credit");
  assert.equal(formatCredits(0.2), "0.2 credits");
  assert.equal(formatCredits(1.01), "1.01 credits");
  assert.equal(formatCredits(0), "0 credits");
  assert.equal(formatCredits(12), "12 credits");
});

test("hundredths compare two-decimal amounts exactly", () => {
  assert.equal(toHundredths(0.1 + 0.2), toHundredths(0.3));
  assert.equal(toHundredths(0.01), 1);
  assert.equal(toHundredths(2), 200);
});
