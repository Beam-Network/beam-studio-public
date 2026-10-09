import assert from "node:assert/strict";
import test from "node:test";
import { organizationScope } from "./organization-scope.js";

test("a scope cannot be built without an organization", () => {
  // The store reduced a missing organization to "", which its SQL read as
  // "no filter". Refusing to construct the scope removes that state entirely.
  for (const missing of [undefined, null, "", "   "]) {
    assert.throws(
      () => organizationScope(missing),
      (error: Error & { code?: string; statusCode?: number }) => {
        assert.equal(error.code, "organization_required");
        assert.equal(error.statusCode, 400);
        return true;
      },
      `${JSON.stringify(missing)} must not produce a scope`,
    );
  }
});

test("a scope carries the trimmed organization", () => {
  assert.deepEqual(organizationScope("  org_alpha  "), {
    organizationId: "org_alpha",
  });
});
