import assert from "node:assert/strict";
import test from "node:test";

import {
  requiresStudioSession,
  studioAuthRedirectPath,
} from "./auth-redirect.ts";

test("only login routes are public", () => {
  assert.equal(requiresStudioSession("/auth"), false);
  assert.equal(requiresStudioSession("/login"), false);
  assert.equal(requiresStudioSession("/dashboard"), true);
  assert.equal(requiresStudioSession("/workflows/flow-1"), true);
});

test("auth redirects preserve the requested local Studio location", () => {
  assert.equal(
    studioAuthRedirectPath("/workflows/flow-1", "?tab=runs", "#latest"),
    "/auth?callbackUrl=%2Fworkflows%2Fflow-1%3Ftab%3Druns%23latest",
  );
});
