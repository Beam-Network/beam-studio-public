import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrganizationAuthority,
  type KeyVerdict,
} from "./organization-authority.js";

function harness(
  verdicts: KeyVerdict[],
  overrides: Partial<Parameters<typeof createOrganizationAuthority>[0]> = {},
) {
  let clock = 0;
  const calls: string[] = [];
  const authority = createOrganizationAuthority({
    resolveKey: async (org) => `key_for_${org}`,
    verifyKey: async (key) => {
      calls.push(key);
      return verdicts.shift() ?? "valid";
    },
    now: () => clock,
    ...overrides,
  });
  return { authority, calls, advance: (ms: number) => (clock += ms) };
}

test("a key Beam accepts makes the organization valid", async () => {
  const { authority } = harness(["valid"]);
  assert.equal(await authority.check("org_a"), "valid");
});

test("a key Beam rejects revokes the organization", async () => {
  const { authority } = harness(["rejected"]);
  assert.equal(await authority.check("org_a"), "revoked");
});

test("an answer is reused until it expires", async () => {
  const { authority, calls, advance } = harness(["valid"], { ttlMs: 1000 });
  assert.equal(await authority.check("org_a"), "valid");
  assert.equal(await authority.check("org_a"), "valid");
  assert.equal(calls.length, 1, "the second check must not ask Beam again");
  advance(1001);
  assert.equal(await authority.check("org_a"), "valid");
  assert.equal(calls.length, 2, "an expired answer is re-checked");
});

test("a revocation is not overridden by a stale success", async () => {
  const { authority, advance } = harness(["valid", "rejected"], { ttlMs: 100 });
  assert.equal(await authority.check("org_a"), "valid");
  advance(101);
  assert.equal(await authority.check("org_a"), "revoked");
  // And it stays revoked without asking again inside the window.
  assert.equal(await authority.check("org_a"), "revoked");
});

test("a recent success rides out an unreachable Beam", async () => {
  // A blip must not lock every machine caller out at once.
  const { authority, advance } = harness(["valid", "unavailable"], {
    ttlMs: 100,
    graceMs: 10_000,
  });
  assert.equal(await authority.check("org_a"), "valid");
  advance(101);
  assert.equal(await authority.check("org_a"), "valid");
});

test("a sustained outage eventually stops counting as verified", async () => {
  const { authority, advance } = harness(
    ["valid", "unavailable", "unavailable"],
    { ttlMs: 100, graceMs: 1000 },
  );
  assert.equal(await authority.check("org_a"), "valid");
  advance(101);
  assert.equal(await authority.check("org_a"), "valid", "inside the grace");
  advance(5000);
  assert.equal(await authority.check("org_a"), "unverified", "beyond it");
});

test("an organization with no stored key is unverified, not revoked", async () => {
  // Studio has nothing to ask Beam with. That is not evidence of revocation.
  const { authority, calls } = harness([], { resolveKey: async () => null });
  assert.equal(await authority.check("org_a"), "unverified");
  assert.deepEqual(calls, []);
});

test("concurrent checks for one organization share a single call", async () => {
  const { authority, calls } = harness(["valid"]);
  const [a, b, c] = await Promise.all([
    authority.check("org_a"),
    authority.check("org_a"),
    authority.check("org_a"),
  ]);
  assert.deepEqual([a, b, c], ["valid", "valid", "valid"]);
  assert.equal(calls.length, 1);
});

test("organizations are cached independently", async () => {
  const { authority, calls } = harness(["valid", "rejected"]);
  assert.equal(await authority.check("org_a"), "valid");
  assert.equal(await authority.check("org_b"), "revoked");
  assert.deepEqual(calls, ["key_for_org_a", "key_for_org_b"]);
});

test("forgetting an organization forces a fresh check", async () => {
  const { authority, calls } = harness(["valid", "rejected"]);
  assert.equal(await authority.check("org_a"), "valid");
  authority.forget("org_a");
  assert.equal(await authority.check("org_a"), "revoked");
  assert.equal(calls.length, 2);
});
