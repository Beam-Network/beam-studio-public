import assert from "node:assert/strict";
import test from "node:test";
import { beamRevision } from "./revision.js";

test("the build revision is a commit hash or nothing", () => {
  assert.equal(
    beamRevision(" 0123456789ABCDEF0123456789abcdef01234567 "),
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(beamRevision("abc1234"), "abc1234");
  for (const value of [undefined, "", "  ", "abc12", "main", "v1.2.3", "0123456; rm"]) {
    assert.equal(beamRevision(value), null, String(value));
  }
});
