import assert from "node:assert/strict";
import test from "node:test";

import { secureRandomHex } from "./secure-random.ts";

test("generates secure hexadecimal tokens without randomUUID", () => {
  const cryptoSource = {
    getRandomValues(bytes) {
      bytes.set([0, 1, 15, 16, 254, 255]);
      return bytes;
    },
  };

  assert.equal(secureRandomHex(6, cryptoSource), "00010f10feff");
});

test("rejects invalid token sizes", () => {
  assert.throws(() => secureRandomHex(0), /positive integer/);
});
