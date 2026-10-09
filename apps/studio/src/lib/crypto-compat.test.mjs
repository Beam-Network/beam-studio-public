import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { cryptoCompatibilityScript } from "./crypto-compat.ts";

test("polyfills a standards-compliant randomUUID with secure random values", () => {
  const crypto = {
    getRandomValues(bytes) {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    },
  };

  vm.runInNewContext(cryptoCompatibilityScript, { crypto, Uint8Array });

  assert.equal(typeof crypto.randomUUID, "function");
  assert.equal(crypto.randomUUID(), "00010203-0405-4607-8809-0a0b0c0d0e0f");
});

test("preserves a native randomUUID implementation", () => {
  const randomUUID = () => "native";
  const crypto = { getRandomValues() {}, randomUUID };

  vm.runInNewContext(cryptoCompatibilityScript, { crypto, Uint8Array });

  assert.equal(crypto.randomUUID, randomUUID);
});

test("does nothing when secure random values are unavailable", () => {
  assert.doesNotThrow(() =>
    vm.runInNewContext(cryptoCompatibilityScript, { Uint8Array }),
  );
});
