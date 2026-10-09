import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  sign as signMessage,
} from "node:crypto";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { createInstanceAdmission } from "../auth/instance-admission.js";
import { upsertInstanceOrganization } from "../studio/repositories/instance-access-repository.js";
import { AgentControlRepository } from "./repository.js";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
if (process.env.CI && !source?.startsWith("postgres")) {
  throw new Error("The agent admission tests require PostgreSQL.");
}
const skip = !source?.startsWith("postgres");

const CONSUMER = "org_consumer";
const OWNER = "org_owner";
const database = `machine_admission_${randomBytes(6).toString("hex")}`;
const globals = globalThis as typeof globalThis & {
  __beamStudioPgPool?: PgPool;
};

let maintenance: PgPool;
let pool: PgPool;
let server: FastifyInstance;
let repository: AgentControlRepository;
let previousPool: PgPool | undefined;

if (!skip) {
  test.before(async () => {
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    maintenance = createPostgresPool(source);
    await maintenance.query(`CREATE DATABASE ${database}`);
    const url = new URL(source!);
    url.pathname = `/${database}`;
    pool = createPostgresPool(url.toString());
    await ensurePostgresMigrations(pool);
    previousPool = globals.__beamStudioPgPool;
    globals.__beamStudioPgPool = pool;

    await pool.query(
      `UPDATE studio.instance
          SET state = 'claimed', owner_organization_id = $1,
              join_policy = 'open', claimed_at = now()
        WHERE id = 'singleton'`,
      [OWNER],
    );
    await upsertInstanceOrganization(pool, {
      organizationId: OWNER,
      role: "owner",
      status: "admitted",
    });

    const { buildServer } = await import("../server.js");
    server = await buildServer({
      pgPool: pool,
      admission: createInstanceAdmission({
        pool,
        consumerOrganizationId: CONSUMER,
        ttlMs: 0,
      }),
    });
    // Only used to mint enrollment codes, which the browser does through an
    // admitted session; the codes' consumption is what is under test.
    repository = new AgentControlRepository(pool, ["unused-in-these-cases"]);
  });

  test.after(async () => {
    await server?.close();
    globals.__beamStudioPgPool = previousPool;
    await pool?.end();
    await maintenance?.query(
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    );
    await maintenance?.end();
  });
}

async function enroll(organizationId: string, code?: string) {
  const identity = generateKeyPairSync("ed25519");
  const der = identity.publicKey.export({ format: "der", type: "spki" });
  const enrollmentCode =
    code ??
    (
      await repository.createEnrollment({
        organizationId,
        machineName: `${organizationId}-edge`,
      })
    ).code;
  const response = await server.inject({
    method: "POST",
    url: "/agent-control/v1/enroll",
    payload: {
      code: enrollmentCode,
      publicKey: der.subarray(der.length - 32).toString("base64url"),
      machineName: `${organizationId}-edge`,
    },
  });
  return { response, code: enrollmentCode, privateKey: identity.privateKey };
}

async function token(
  enrolled: { agentId: string; credential: string },
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
) {
  const credentialId = enrolled.credential.split(".")[0]!;
  const nonce = randomBytes(24).toString("base64url");
  const issuedAt = new Date().toISOString();
  const proof = `beam-studio-agent-token-v1\n${enrolled.agentId}\n${credentialId}\n${nonce}\n${issuedAt}`;
  return server.inject({
    method: "POST",
    url: "/agent-control/v1/token",
    payload: {
      credential: enrolled.credential,
      nonce,
      issuedAt,
      signature: signMessage(null, Buffer.from(proof), privateKey).toString(
        "base64url",
      ),
    },
  });
}

test(
  "under an open policy an unrecorded organization cannot enroll an agent until it is admitted",
  { skip },
  async () => {
    const refused = await enroll("org_stranger");
    assert.equal(refused.response.statusCode, 403, refused.response.body);
    assert.equal(
      refused.response.json().code,
      "instance_organization_forbidden",
    );

    // What POST /studio/instance/access/organizations records.
    await upsertInstanceOrganization(pool, {
      organizationId: "org_stranger",
      status: "admitted",
    });

    // The refused code was not burned.
    const admitted = await enroll("org_stranger", refused.code);
    assert.equal(admitted.response.statusCode, 201, admitted.response.body);
    const issued = await token(admitted.response.json(), admitted.privateKey);
    assert.equal(issued.statusCode, 200, issued.body);
    assert.ok(issued.json().accessToken);
  },
);

test(
  "under an open policy an agent loses its token once its admission is gone",
  { skip },
  async () => {
    await upsertInstanceOrganization(pool, {
      organizationId: "org_later",
      status: "admitted",
    });
    const enrolled = await enroll("org_later");
    assert.equal(enrolled.response.statusCode, 201, enrolled.response.body);
    assert.equal(
      (await token(enrolled.response.json(), enrolled.privateKey)).statusCode,
      200,
    );

    // Its recorded admission removed: the open policy must not stand in.
    await pool.query(
      "DELETE FROM studio.instance_organizations WHERE organization_id = 'org_later'",
    );
    const refused = await token(enrolled.response.json(), enrolled.privateKey);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(refused.json().code, "instance_organization_forbidden");
  },
);

test(
  "the Rooms consumer organization is always served, with no admission row",
  { skip },
  async () => {
    for (const joinPolicy of ["open", "request", "closed"]) {
      await pool.query(
        "UPDATE studio.instance SET join_policy = $1 WHERE id = 'singleton'",
        [joinPolicy],
      );
      const enrolled = await enroll(CONSUMER);
      assert.equal(enrolled.response.statusCode, 201, enrolled.response.body);
      const issued = await token(enrolled.response.json(), enrolled.privateKey);
      assert.equal(issued.statusCode, 200, `${joinPolicy}: ${issued.body}`);
    }
    await pool.query(
      "UPDATE studio.instance SET join_policy = 'open' WHERE id = 'singleton'",
    );
  },
);
