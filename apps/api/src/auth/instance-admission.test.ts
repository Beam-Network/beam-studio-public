import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { createInstanceAdmission } from "./instance-admission.js";

type InstanceSeed = {
  state?: "unclaimed" | "adopted" | "claimed";
  joinPolicy?: "open" | "request" | "closed";
  ownerOrganizationId?: string | null;
};

type MembershipSeed = {
  role?: "owner" | "member";
  status: "admitted" | "pending" | "revoked";
};

/**
 * A pool answering only the two instance reads, so these tests exercise the
 * admission decision rather than a repository's SQL.
 */
function harness(
  instance: InstanceSeed | null,
  memberships: Record<string, MembershipSeed> = {},
  options: { ttlMs?: number; consumerOrganizationId?: string | null } = {},
) {
  let clock = 0;
  const queries: string[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      // Checked first: "studio.instance_organizations" contains
      // "studio.instance", so the looser match has to come second.
      if (sql.includes("studio.instance_organizations")) {
        const seed = memberships[String(values?.[0])];
        return seed
          ? {
              rows: [
                {
                  organization_id: String(values?.[0]),
                  role: seed.role ?? "member",
                  status: seed.status,
                  requested_by_user_id: null,
                  requested_by_email: null,
                  decided_by_user_id: null,
                  decided_by_email: null,
                  requested_at: null,
                  decided_at: null,
                  note: null,
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("studio.instance")) {
        return instance
          ? {
              rows: [
                {
                  state: instance.state ?? "claimed",
                  owner_organization_id: instance.ownerOrganizationId ?? null,
                  join_policy: instance.joinPolicy ?? "closed",
                  claimed_at: null,
                  claimed_by_user_id: null,
                  claimed_by_email: null,
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PgPool;

  const admission = createInstanceAdmission({
    pool,
    now: () => clock,
    ttlMs: options.ttlMs ?? 10_000,
    consumerOrganizationId: options.consumerOrganizationId ?? null,
  });
  return { admission, queries, advance: (ms: number) => (clock += ms) };
}

test("an admitted organization is served", async () => {
  const { admission } = harness({ joinPolicy: "closed" }, {
    org_a: { status: "admitted" },
  });
  const verdict = await admission.check("org_a");
  assert.equal(verdict.outcome, "admitted");
  assert.equal(verdict.role, "member");
});

test("an organization this deployment never admitted is refused", async () => {
  const { admission } = harness({ joinPolicy: "closed" });
  assert.equal((await admission.check("org_stranger")).outcome, "forbidden");
});

test("an unclaimed instance serves nobody", async () => {
  const { admission } = harness({ state: "unclaimed", joinPolicy: "open" }, {
    org_a: { status: "admitted" },
  });
  assert.equal((await admission.check("org_a")).outcome, "unclaimed");
});

test("an adopted deployment keeps serving the organizations it already served", async () => {
  // The upgrade seeds this state for any database that already had
  // organizations. If it refused them the way an unclaimed instance does, the
  // deploy that introduced ownership would sign out every live installation.
  const { admission } = harness({ state: "adopted", joinPolicy: "open" }, {
    org_existing: { status: "admitted" },
  });
  assert.equal((await admission.check("org_existing")).outcome, "admitted");
});

test("an adopted deployment still admits newcomers under its open policy", async () => {
  const { admission } = harness({ state: "adopted", joinPolicy: "open" });
  assert.equal((await admission.check("org_new")).outcome, "admitted");
});

test("a database with no instance row refuses rather than admits", async () => {
  const { admission } = harness(null);
  assert.equal((await admission.check("org_a")).outcome, "unclaimed");
});

test("a revoked organization stays refused under an open policy", async () => {
  const { admission } = harness({ joinPolicy: "open" }, {
    org_a: { status: "revoked" },
  });
  assert.equal((await admission.check("org_a")).outcome, "revoked");
});

test("a pending organization is reported as pending, not forbidden", async () => {
  const { admission } = harness({ joinPolicy: "request" }, {
    org_a: { status: "pending" },
  });
  assert.equal((await admission.check("org_a")).outcome, "pending");
});

test("an open instance admits an organization it has never seen", async () => {
  const { admission } = harness({ joinPolicy: "open" });
  assert.equal((await admission.check("org_new")).outcome, "admitted");
});

test("a request-to-join instance refuses an unknown organization", async () => {
  const { admission } = harness({ joinPolicy: "request" });
  assert.equal((await admission.check("org_new")).outcome, "forbidden");
});

test("the local sentinel organization is always served", async () => {
  const { admission } = harness({ state: "unclaimed", joinPolicy: "closed" });
  assert.equal((await admission.check("__local__")).outcome, "admitted");
});

test("an owner that is also the consumer organization keeps the owner role", async () => {
  const { admission } = harness(
    { joinPolicy: "closed", ownerOrganizationId: "org_consumer" },
    { org_consumer: { role: "owner", status: "admitted" } },
    { consumerOrganizationId: "org_consumer" },
  );
  const verdict = await admission.check("org_consumer");
  assert.equal(verdict.outcome, "admitted");
  assert.equal(verdict.role, "owner");
});

test("an exempt organization with no membership row is still admitted", async () => {
  const { admission } = harness(
    { state: "unclaimed", joinPolicy: "closed" },
    {},
    { consumerOrganizationId: "org_consumer" },
  );
  const verdict = await admission.check("org_consumer");
  assert.equal(verdict.outcome, "admitted");
  assert.equal(verdict.role, "member");
  // Must not become "policy", or a machine token for it would be refused.
  assert.notEqual(verdict.source, "policy");
});

test("the Rooms consumer organization is always served", async () => {
  const { admission } = harness(
    { joinPolicy: "closed" },
    {},
    { consumerOrganizationId: "org_consumer" },
  );
  assert.equal((await admission.check("org_consumer")).outcome, "admitted");
});

test("an answer is reused until it expires", async () => {
  const { admission, queries, advance } = harness(
    { joinPolicy: "closed" },
    { org_a: { status: "admitted" } },
    { ttlMs: 1000 },
  );
  await admission.check("org_a");
  const afterFirst = queries.length;
  await admission.check("org_a");
  assert.equal(queries.length, afterFirst, "second check queried again");

  advance(1001);
  await admission.check("org_a");
  assert.ok(queries.length > afterFirst, "an expired answer was not refreshed");
});

test("concurrent checks share one read", async () => {
  const { admission, queries } = harness({ joinPolicy: "closed" }, {
    org_a: { status: "admitted" },
  });
  await Promise.all([
    admission.check("org_a"),
    admission.check("org_a"),
    admission.check("org_a"),
  ]);
  // One instance read plus one membership read, not three of each.
  assert.equal(queries.length, 2);
});

test("forgetting an organization makes the next check read again", async () => {
  const { admission, queries } = harness({ joinPolicy: "closed" }, {
    org_a: { status: "admitted" },
  });
  await admission.check("org_a");
  const afterFirst = queries.length;

  admission.forget("org_a");
  await admission.check("org_a");
  assert.ok(
    queries.length > afterFirst,
    "a decision would not take effect until the cache expired",
  );
});
