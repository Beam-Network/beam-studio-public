import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import {
  applyInstanceOwnerLever,
  bootstrapInstanceOwner,
} from "./instance-bootstrap.js";

/**
 * The recovery lever against a real schema.
 *
 * A pool that only records statements cannot see the single-owner unique
 * index, which is exactly what the lever used to trip over: it promoted the
 * new owner before demoting the old one, and the API crash-looped on every
 * boot. These cases run against PostgreSQL so the index is in play.
 */

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres")) {
  throw new Error("The owner-recovery lever tests require PostgreSQL.");
}
const skip = !source?.startsWith("postgres");

let pool: PgPool;
let maintenance: PgPool;
const database = `instance_bootstrap_${randomBytes(6).toString("hex")}`;

if (!skip) {
  test.before(async () => {
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    maintenance = createPostgresPool(source);
    await maintenance.query(`CREATE DATABASE ${database}`);
    const url = new URL(source!);
    url.pathname = `/${database}`;
    pool = createPostgresPool(url.toString());
    await ensurePostgresMigrations(pool);
  });

  test.after(async () => {
    await pool?.end();
    await maintenance?.query(
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    );
    await maintenance?.end();
  });
}

type Membership = { organization_id: string; role: string; status: string };

async function given(
  state: "unclaimed" | "adopted" | "claimed",
  options: {
    owner?: string;
    joinPolicy?: "open" | "request" | "closed";
    members?: Array<
      [string, "owner" | "member", "admitted" | "pending" | "revoked"]
    >;
  } = {},
) {
  await pool.query("DELETE FROM studio.instance_organizations");
  await pool.query(
    `UPDATE studio.instance
        SET state = $1, owner_organization_id = $2, join_policy = $3,
            claimed_at = CASE WHEN $1 = 'claimed' THEN now() END
      WHERE id = 'singleton'`,
    [state, options.owner ?? null, options.joinPolicy ?? "closed"],
  );
  for (const [organizationId, role, status] of options.members ?? []) {
    await pool.query(
      `INSERT INTO studio.instance_organizations (organization_id, role, status)
       VALUES ($1, $2, $3)`,
      [organizationId, role, status],
    );
  }
}

async function snapshot() {
  const instance = (
    await pool.query<{
      state: string;
      owner_organization_id: string | null;
      join_policy: string;
    }>("SELECT state, owner_organization_id, join_policy FROM studio.instance")
  ).rows[0]!;
  const members = (
    await pool.query<Membership & { updated_at: Date }>(
      `SELECT organization_id, role, status, updated_at
         FROM studio.instance_organizations ORDER BY organization_id`,
    )
  ).rows;
  return {
    instance,
    members: members.map(({ organization_id, role, status }) => ({
      organization_id,
      role,
      status,
    })),
    updatedAt: members.map((row) => row.updated_at.toISOString()),
  };
}

function recordingLogger() {
  const lines: Array<{
    level: "info" | "warn" | "error";
    details: Record<string, unknown>;
    message: string;
  }> = [];
  const at =
    (level: "info" | "warn" | "error") =>
    (details: Record<string, unknown>, message: string) =>
      lines.push({ level, details, message });
  return {
    lines,
    logger: { info: at("info"), warn: at("warn"), error: at("error") },
  };
}

test("an unset owner leaves the instance alone", async () => {
  const touched: string[] = [];
  const untouched = {
    query: async (sql: string) => {
      touched.push(sql);
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      throw new Error("an unset lever opened a transaction");
    },
  } as unknown as PgPool;
  assert.deepEqual(await bootstrapInstanceOwner(untouched, undefined), {
    applied: false,
    reason: "unset",
  });
  assert.deepEqual(await bootstrapInstanceOwner(untouched, "   "), {
    applied: false,
    reason: "unset",
  });
  assert.equal(touched.length, 0);
});

test("a failing lever is logged and never thrown, so the API keeps serving", async () => {
  const broken = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
        throw Object.assign(
          new Error(
            'duplicate key value violates unique constraint "studio_instance_single_owner"',
          ),
          { code: "23505" },
        );
      },
      release() {},
    }),
  } as unknown as PgPool;
  const { lines, logger } = recordingLogger();
  const result = await applyInstanceOwnerLever(
    broken,
    "org_new",
    logger,
    async () => undefined,
  );
  assert.equal(result, null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, "error");
  assert.equal(lines[0]?.details.organizationId, "org_new");
  assert.match(lines[0]!.message, /ownership is unchanged/);
});

test(
  "the lever moves ownership on a claimed instance: demote, then promote",
  { skip },
  async () => {
    await given("claimed", {
      owner: "org_old",
      members: [
        ["org_old", "owner", "admitted"],
        ["org_new", "member", "admitted"],
      ],
    });
    const { lines, logger } = recordingLogger();
    const revoked: string[] = [];
    const result = await applyInstanceOwnerLever(
      pool,
      "org_new",
      logger,
      async (organizationId) => revoked.push(organizationId),
    );
    // The outgoing owner's instance key is revoked before ownership moves.
    assert.deepEqual(revoked, ["org_old"]);
    assert.deepEqual(result, {
      applied: true,
      organizationId: "org_new",
      action: "transferred",
      previousOwnerOrganizationId: "org_old",
    });
    const after = await snapshot();
    assert.equal(after.instance.state, "claimed");
    assert.equal(after.instance.owner_organization_id, "org_new");
    // The outgoing owner keeps access and loses only the role.
    assert.deepEqual(after.members, [
      { organization_id: "org_new", role: "owner", status: "admitted" },
      { organization_id: "org_old", role: "member", status: "admitted" },
    ]);
    const warning = lines.find((line) => line.level === "warn");
    assert.ok(warning, "a transfer by the lever must be warned");
    assert.equal(warning.details.previousOwnerOrganizationId, "org_old");
    assert.equal(warning.details.ownerOrganizationId, "org_new");
    assert.match(warning.message, /org_old/);
    assert.match(warning.message, /org_new/);
    assert.equal(lines.filter((line) => line.level === "error").length, 0);
  },
);

test(
  "a key that cannot be revoked leaves ownership where it was",
  { skip },
  async () => {
    await given("claimed", {
      owner: "org_old",
      members: [["org_old", "owner", "admitted"]],
    });
    const before = await snapshot();
    const { lines, logger } = recordingLogger();
    const result = await applyInstanceOwnerLever(
      pool,
      "org_new",
      logger,
      async () => {
        throw new Error("Studio could not reach Beam");
      },
    );
    assert.equal(result, null);
    assert.deepEqual(await snapshot(), before);
    assert.match(lines[0]!.message, /previous owner's instance key/);
  },
);

test(
  "the lever claims an unclaimed instance without opening it",
  { skip },
  async () => {
    await given("unclaimed", { joinPolicy: "closed" });
    const result = await bootstrapInstanceOwner(pool, "org_owner");
    assert.deepEqual(result, {
      applied: true,
      organizationId: "org_owner",
      action: "claimed",
      previousOwnerOrganizationId: null,
    });
    const after = await snapshot();
    assert.equal(after.instance.state, "claimed");
    assert.equal(after.instance.owner_organization_id, "org_owner");
    assert.equal(after.instance.join_policy, "closed");
    assert.deepEqual(after.members, [
      { organization_id: "org_owner", role: "owner", status: "admitted" },
    ]);
  },
);

test(
  "the lever claims an adopted instance and leaves its open policy alone",
  { skip },
  async () => {
    await given("adopted", {
      joinPolicy: "open",
      members: [
        ["org_a", "member", "admitted"],
        ["org_b", "member", "admitted"],
      ],
    });
    await bootstrapInstanceOwner(pool, "org_b");
    const after = await snapshot();
    assert.equal(after.instance.state, "claimed");
    assert.equal(after.instance.owner_organization_id, "org_b");
    assert.equal(after.instance.join_policy, "open");
    assert.deepEqual(after.members, [
      { organization_id: "org_a", role: "member", status: "admitted" },
      { organization_id: "org_b", role: "owner", status: "admitted" },
    ]);
  },
);

test(
  "naming the current owner is a no-op on every boot",
  { skip },
  async () => {
    await given("claimed", {
      owner: "org_owner",
      members: [
        ["org_owner", "owner", "admitted"],
        ["org_member", "member", "admitted"],
      ],
    });
    const before = await snapshot();
    const { lines, logger } = recordingLogger();
    for (let boot = 0; boot < 3; boot += 1) {
      assert.deepEqual(
        await applyInstanceOwnerLever(pool, "org_owner", logger, async () => {
          throw new Error("an unchanged owner's key must not be revoked");
        }),
        { applied: false, reason: "unchanged", organizationId: "org_owner" },
      );
    }
    assert.deepEqual(
      await snapshot(),
      before,
      "an unchanged owner was rewritten",
    );
    assert.equal(lines.filter((line) => line.level !== "info").length, 0);
  },
);

test(
  "naming the current owner restores a revoked or demoted owner row",
  { skip },
  async () => {
    await given("claimed", {
      owner: "org_owner",
      members: [["org_owner", "member", "revoked"]],
    });
    const result = await bootstrapInstanceOwner(pool, "org_owner");
    assert.equal(result.applied && result.action, "restored");
    assert.deepEqual((await snapshot()).members, [
      { organization_id: "org_owner", role: "owner", status: "admitted" },
    ]);
  },
);

test(
  "a non-admitted organization is admitted as owner (the claim went to the wrong org)",
  { skip },
  async () => {
    await given("claimed", {
      owner: "org_wrong",
      members: [
        ["org_wrong", "owner", "admitted"],
        ["org_revoked", "member", "revoked"],
      ],
    });
    // Never recorded at all.
    await bootstrapInstanceOwner(pool, "org_right");
    let after = await snapshot();
    assert.equal(after.instance.owner_organization_id, "org_right");
    assert.deepEqual(after.members, [
      { organization_id: "org_revoked", role: "member", status: "revoked" },
      { organization_id: "org_right", role: "owner", status: "admitted" },
      { organization_id: "org_wrong", role: "member", status: "admitted" },
    ]);

    // Recorded, but revoked: the lever overrides the revoke.
    await bootstrapInstanceOwner(pool, "org_revoked");
    after = await snapshot();
    assert.equal(after.instance.owner_organization_id, "org_revoked");
    assert.deepEqual(after.members, [
      { organization_id: "org_revoked", role: "owner", status: "admitted" },
      { organization_id: "org_right", role: "member", status: "admitted" },
      { organization_id: "org_wrong", role: "member", status: "admitted" },
    ]);
    const owners = after.members.filter((member) => member.role === "owner");
    assert.equal(owners.length, 1);
  },
);

test("the join policy is never changed by the lever", { skip }, async () => {
  for (const joinPolicy of ["open", "request", "closed"] as const) {
    await given("claimed", {
      owner: "org_old",
      joinPolicy,
      members: [["org_old", "owner", "admitted"]],
    });
    await bootstrapInstanceOwner(pool, "org_new");
    assert.equal((await snapshot()).instance.join_policy, joinPolicy);
  }
});

test(
  "an owner named by the instance but missing its row keeps access after a move",
  { skip },
  async () => {
    await given("claimed", { owner: "org_old", members: [] });
    await bootstrapInstanceOwner(pool, "org_new");
    assert.deepEqual((await snapshot()).members, [
      { organization_id: "org_new", role: "owner", status: "admitted" },
      { organization_id: "org_old", role: "member", status: "admitted" },
    ]);
  },
);
