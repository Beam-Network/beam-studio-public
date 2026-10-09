import assert from "node:assert/strict";
import test from "node:test";

/**
 * The rule the store applies when a workflow is created without an
 * explicit key. Mirrored here so the intent is pinned independently of the
 * database: defaulting is only safe when there is no choice to make.
 */
function resolveBinding(
  explicit: string,
  availableKeyIds: string[],
): string | null {
  return (
    explicit.trim() ||
    (availableKeyIds.length === 1 ? availableKeyIds[0]! : null)
  );
}

test("a single configured key is bound automatically", () => {
  // With one key there is nothing to get wrong, so requiring a choice would be
  // friction for no benefit.
  assert.equal(resolveBinding("", ["key_only"]), "key_only");
});

test("several keys require an explicit choice", () => {
  // Picking one would spend an allowance the operator assigned to something
  // else and attribute the usage to the wrong key. Left unset, the run is
  // refused until someone chooses.
  assert.equal(resolveBinding("", ["key_a", "key_b"]), null);
  assert.equal(resolveBinding("", ["key_a", "key_b", "key_c"]), null);
});

test("no configured keys leaves the binding unset", () => {
  assert.equal(resolveBinding("", []), null);
});

test("an explicit choice always wins over the default", () => {
  assert.equal(resolveBinding("key_chosen", ["key_only"]), "key_chosen");
  assert.equal(
    resolveBinding("  key_chosen  ", ["key_a", "key_b"]),
    "key_chosen",
  );
});
