import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import {
  captureWorkflowTreePg,
  createPostgresPool,
  enqueueFrozenWorkflowRunPg,
  ensurePostgresMigrations,
  retryFrozenWorkflowRunPg,
  WorkflowAuthorizationError,
  WorkflowAuthorityUnavailableError,
  withPostgresTransaction,
  type PgPool,
} from "@beam-studio/db";
import { encryptString, vaultSecretFromEnv } from "@beam-studio/vault";
import {
  assertWorkflowExecutionAuthorized,
  registerWorkflowExecutionAuthorizationRoutes,
} from "./execution-authorization.js";
import { roomMemberCan } from "../agent-control/room-workflow-options.js";

const source = process.env.BEAM_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
const database = `workflow_auth_${crypto.randomBytes(6).toString("hex")}`;
let pool: PgPool, maintenance: PgPool, run: Record<string, any>;
let checks = 0,
  accountAllowed = true;
let expectedEnvironment: string | undefined;
let expectedOrigin: string | undefined;
const originalFetch = globalThis.fetch;
before(async () => {
  if (!source) return;
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  maintenance = createPostgresPool(source);
  await maintenance.query(`CREATE DATABASE ${database}`);
  const url = new URL(source);
  url.pathname = `/${database}`;
  pool = createPostgresPool(url.toString());
  await ensurePostgresMigrations(pool);
  await pool.query(
    "INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Test')",
  );
  await pool.query(
    "INSERT INTO secrets.credential_types(id,slug,display_name) VALUES('test-type','test-key','Test key')",
  );
  await pool.query(
    "INSERT INTO secrets.credentials(id,organization_id,credential_type_id,name) VALUES('key','org','test-type','Execution key')",
  );
  await pool.query(
    "INSERT INTO secrets.credential_versions(id,credential_id,version,encrypted_payload,encryption_key_id) VALUES('key-v1','key',1,$1,'local')",
    [
      encryptString(
        JSON.stringify({ api_key: "test-only-key" }),
        vaultSecretFromEnv(),
      ),
    ],
  );
  await pool.query(
    "INSERT INTO actions.scopes(id,name) VALUES('test-scope','@test')",
  );
  await pool.query(
    "INSERT INTO actions.packages(id,scope_id,name,package_name,display_name) VALUES('action','test-scope','action','@test/action','Test action')",
  );
  await pool.query(
    "INSERT INTO actions.package_versions(id,package_id,version,manifest_json,manifest_checksum,artifact_checksum,status) VALUES('version','action','1.0.0',$1,'manifest','artifact','active')",
    [
      JSON.stringify({
        name: "@test/action",
        version: "1.0.0",
        runtime: {
          placements: ["local-workers"],
          defaultPlacement: "local-workers",
        },
        configSchema: { type: "object" },
        catalog: {
          credentialRequirements: [{ configPaths: ["inputs.apiKey"] }],
        },
      }),
    ],
  );
  await pool.query(
    "INSERT INTO workflow.templates(id,organization_id,name,api_key_id) VALUES('workflow','org','Test','key')",
  );
  await pool.query(
    "INSERT INTO workflow.steps(id,workflow_template_id,action_package_name,action_version_range,position) VALUES('step','workflow','@test/action','1.0.0',0)",
  );
  const runId = await withPostgresTransaction(pool, async (client) => {
    const tree = await captureWorkflowTreePg(client, {
      organizationId: "org",
      workflowTemplateId: "workflow",
    });
    return enqueueFrozenWorkflowRunPg(client, {
      definition: tree.root,
      definitions: tree.definitions,
      runtimeInput: {},
      trigger: "manual",
      executionContext: { initiatingPrincipalId: "user" },
    });
  });
  await pool.query(
    "UPDATE execution.workflow_runs SET status='running' WHERE id=$1",
    [runId],
  );
  run = (
    await pool.query("SELECT * FROM execution.workflow_runs WHERE id=$1", [
      runId,
    ])
  ).rows[0];
  // The run's own Beam key is the whole credential: Beam takes the organization
  // from it, so no shared secret or organization id is sent.
  globalThis.fetch = async (url, init) => {
    if (expectedOrigin !== undefined)
      assert.equal(new URL(String(url)).origin, expectedOrigin);
    assert.equal(
      new URL(String(url)).pathname,
      "/v1/workflow-execution/authorize",
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-only-key");
    assert.deepEqual([...headers.keys()].sort(), [
      "authorization",
      "content-type",
    ]);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), [
      "environment",
      "initiatingPrincipalId",
      "permission",
      "projectId",
    ]);
    assert.equal(body.initiatingPrincipalId, "user");
    if (expectedEnvironment !== undefined)
      assert.equal(body.environment, expectedEnvironment);
    checks++;
    return Response.json(
      accountAllowed
        ? { authorized: true }
        : { authorized: false, code: "execution_membership_revoked" },
      { status: accountAllowed ? 200 : 403 },
    );
  };
});

test(
  "managed DEV authorization uses its current execution key and scoped account authority",
  { skip: !source },
  async () => {
    const saved = {
      entries: process.env.DEV_QUALIFICATION_WORKFLOWS,
      url: process.env.DEV_QUALIFICATION_ACCOUNT_API_URL,
    };
    try {
      process.env.DEV_QUALIFICATION_WORKFLOWS = JSON.stringify([
        {
          workflowId: run.workflow_template_id,
          organizationId: "org",
          credentialId: "key",
        },
      ]);
      process.env.DEV_QUALIFICATION_ACCOUNT_API_URL =
        "https://managed-dev.test";
      expectedOrigin = "https://managed-dev.test";
      expectedEnvironment = "dev";
      const managed = {
        ...run,
        execution_context_json: {
          ...run.execution_context_json,
          environment: "dev",
          billing: { apiKeyId: "key" },
        },
      };
      await assertWorkflowExecutionAuthorized(pool, managed);
      accountAllowed = false;
      await assert.rejects(assertWorkflowExecutionAuthorized(pool, managed), {
        code: "execution_membership_revoked",
      });
    } finally {
      accountAllowed = true;
      expectedOrigin = undefined;
      expectedEnvironment = undefined;
      for (const [name, value] of Object.entries({
        DEV_QUALIFICATION_WORKFLOWS: saved.entries,
        DEV_QUALIFICATION_ACCOUNT_API_URL: saved.url,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);

test(
  "roomless execution freezes credential environment across rotation and retry",
  { skip: !source },
  async () => {
    const originalEnvironment = process.env.BEAM_ENV;
    const originalMetadata = (
      await pool.query(
        "SELECT metadata_json FROM secrets.credentials WHERE id='key'",
      )
    ).rows[0].metadata_json;
    const launch = () =>
      withPostgresTransaction(pool, async (client) => {
        const tree = await captureWorkflowTreePg(client, {
          organizationId: "org",
          workflowTemplateId: "workflow",
        });
        const id = await enqueueFrozenWorkflowRunPg(client, {
          definition: tree.root,
          definitions: tree.definitions,
          runtimeInput: {},
          trigger: "manual",
          executionContext: { initiatingPrincipalId: "user" },
        });
        return (
          await client.query(
            "SELECT * FROM execution.workflow_runs WHERE id=$1",
            [id],
          )
        ).rows[0];
      });
    try {
      process.env.BEAM_ENV = "dev";
      await pool.query(
        "UPDATE secrets.credentials SET metadata_json=$1 WHERE id='key'",
        [
          {
            baseUrl: "https://beamcore.b1m.ai",
            environment: "prod",
            apiKey: "must-not-snapshot",
          },
        ],
      );
      const frozen = await launch();
      assert.equal(frozen.execution_context_json.room, null);
      assert.equal(frozen.execution_context_json.environment, "prod");
      assert.doesNotMatch(
        JSON.stringify(frozen.execution_context_json),
        /must-not-snapshot/,
      );
      expectedEnvironment = "prod";
      await assertWorkflowExecutionAuthorized(pool, frozen);
      await assertWorkflowExecutionAuthorized(pool, frozen, "step");
      await pool.query(
        "UPDATE secrets.credentials SET metadata_json=$1 WHERE id='key'",
        [{ environment: "dev" }],
      );
      process.env.BEAM_ENV = "prod";
      await assertWorkflowExecutionAuthorized(pool, frozen, "step");
      await pool.query(
        "UPDATE execution.workflow_runs SET status='failed' WHERE id=$1",
        [frozen.id],
      );
      await withPostgresTransaction(pool, (client) =>
        retryFrozenWorkflowRunPg(client, {
          workflowRunId: frozen.id,
          organizationId: "org",
          authorizeExecution: async () => {},
        }),
      );
      const retry = (
        await pool.query("SELECT * FROM execution.workflow_runs WHERE id=$1", [
          frozen.id,
        ])
      ).rows[0];
      assert.deepEqual(
        retry.execution_context_json,
        frozen.execution_context_json,
      );
      await assertWorkflowExecutionAuthorized(pool, retry, "step");
      const fresh = await launch();
      expectedEnvironment = "dev";
      await assertWorkflowExecutionAuthorized(pool, fresh, "step");
      assert.equal(fresh.execution_context_json.environment, "dev");
    } finally {
      expectedEnvironment = undefined;
      if (originalEnvironment === undefined) delete process.env.BEAM_ENV;
      else process.env.BEAM_ENV = originalEnvironment;
      await pool.query(
        "UPDATE secrets.credentials SET metadata_json=$1 WHERE id='key'",
        [originalMetadata],
      );
    }
  },
);
after(async () => {
  globalThis.fetch = originalFetch;
  await pool?.end();
  if (maintenance) {
    await maintenance.query(`DROP DATABASE IF EXISTS ${database}`);
    await maintenance.end();
  }
});
test(
  "frozen execution intent cannot bypass current credential, account or action revocation",
  { skip: !source },
  async () => {
    await assertWorkflowExecutionAuthorized(pool, run, "step");
    const snapshot = JSON.stringify(run.template_snapshot_json);
    accountAllowed = false;
    await assert.rejects(assertWorkflowExecutionAuthorized(pool, run, "step"), {
      code: "execution_membership_revoked",
    });
    accountAllowed = true;
    await pool.query(
      "UPDATE secrets.credentials SET status='revoked' WHERE id='key'",
    );
    const previous = checks;
    await assert.rejects(assertWorkflowExecutionAuthorized(pool, run, "step"), {
      code: "execution_credential_revoked",
    });
    assert.equal(checks, previous);
    await pool.query(
      "UPDATE secrets.credentials SET status='active' WHERE id='key'",
    );
    await pool.query(
      "UPDATE actions.packages SET status='blocked' WHERE id='action'",
    );
    await assert.rejects(assertWorkflowExecutionAuthorized(pool, run, "step"), {
      code: "execution_action_revoked",
    });
    await pool.query(
      "UPDATE actions.packages SET status='active' WHERE id='action'",
    );
    assert.equal(
      JSON.stringify(
        (
          await pool.query(
            "SELECT template_snapshot_json FROM execution.workflow_runs WHERE id=$1",
            [run.id],
          )
        ).rows[0].template_snapshot_json,
      ),
      snapshot,
    );
  },
);

test(
  "a key Beam rejects denies execution while an unreachable Beam stays retryable",
  { skip: !source },
  async (t) => {
    let status = 401;
    t.mock.method(globalThis, "fetch", async () =>
      Response.json(
        status === 401
          ? { code: "api_key_authentication_required" }
          : { error: "unavailable" },
        { status },
      ),
    );
    await assert.rejects(assertWorkflowExecutionAuthorized(pool, run, "step"), {
      code: "api_key_authentication_required",
      retryable: false,
    });
    status = 503;
    await assert.rejects(
      assertWorkflowExecutionAuthorized(pool, run, "step"),
      WorkflowAuthorityUnavailableError,
    );
  },
);

test(
  "a room grant cannot authorize a transfer in another environment",
  { skip: !source },
  async (t) => {
    const environments: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        environments.push(body.environment);
        return Response.json(
          body.environment === "dev"
            ? { authorized: true }
            : { authorized: false, code: "execution_environment_scope_denied" },
          { status: body.environment === "dev" ? 200 : 403 },
        );
      },
    );
    const transfer = {
      ...run,
      execution_context_json: {
        ...run.execution_context_json,
        room: {
          environmentTemplateKey: "dev",
          roomId: `btr_room_${"a".repeat(26)}`,
        },
      },
      resolved_steps_json: [
        {
          ...run.resolved_steps_json[0],
          actionPackage: "@beam/transfer",
          config: { environment: "prod" },
        },
      ],
    };
    await assert.rejects(
      assertWorkflowExecutionAuthorized(pool, transfer, "step"),
      { code: "execution_environment_scope_denied" },
    );
    assert.deepEqual(environments, ["dev", "prod"]);
  },
);
test(
  "authorization routes fence capabilities, fixed task identity, expired leases and cancellation",
  { skip: !source },
  async () => {
    const server = Fastify();
    let billingChecks = 0;
    let billingAllowed = false;
    registerWorkflowExecutionAuthorizationRoutes(
      server,
      pool,
      async (_pool, runId) => {
        assert.equal(runId, run.id);
        billingChecks++;
        if (!billingAllowed)
          throw new WorkflowAuthorityUnavailableError(
            "execution_billing_unavailable",
          );
      },
    );
    try {
      const token = (
        await pool.query(
          "SELECT authorization_token FROM execution.workflow_run_capabilities WHERE workflow_run_id=$1",
          [run.id],
        )
      ).rows[0].authorization_token;
      const request = {
        method: "POST" as const,
        url: `/internal/workflow-runs/${run.id}/authorize`,
        headers: { authorization: `Bearer ${token}` },
        payload: { stepId: "step", phase: "dispatch" },
      };
      assert.equal(
        (
          await server.inject({
            ...request,
            headers: { authorization: "Bearer invalid" },
          })
        ).statusCode,
        403,
      );
      assert.equal(billingChecks, 0);
      const unavailable = await server.inject(request);
      assert.equal(unavailable.statusCode, 503);
      assert.equal(unavailable.json().code, "execution_billing_unavailable");
      assert.equal(unavailable.json().retryable, true);
      billingAllowed = true;
      assert.equal((await server.inject(request)).statusCode, 200);
      assert.equal(billingChecks, 2);
      assert.equal(
        (
          await server.inject({ ...request, payload: { stepId: "other-step" } })
        ).json().code,
        "execution_step_missing",
      );
      await pool.query(
        "INSERT INTO execution.workflow_tasks(id,organization_id,workflow_run_id,workflow_step_id,task_kind,action_package_name,status,input_checksum,claim_token,lease_expires_at,attempt_count) VALUES('task','org',$1,'step','step','@test/action','running','input','task-claim',now()+interval '1 minute',1)",
        [run.id],
      );
      await pool.query(
        "INSERT INTO execution.workflow_step_runs(id,workflow_run_id,workflow_step_id,action_package_name,resolved_version,resolved_placement,checksum,source_registry,status) VALUES('step-run',$1,'step','@test/action','1.0.0','local-workers','manifest','test','running')",
        [run.id],
      );
      await pool.query(
        "INSERT INTO execution.executor_assignments(id,organization_id,workflow_run_id,workflow_step_run_id,task_id,attempt,backend,executor_id,declared_target_json,state,lease_expires_at) VALUES('assignment','org',$1,'step-run','task',1,'studio','runner','{\"kind\":\"studio\"}','running',now()+interval '1 minute')",
        [run.id],
      );
      await pool.query(
        "INSERT INTO runtime.worker_runtime_state(worker_id,network_identity,status,heartbeat_at) VALUES('runner','test','active',now())",
      );
      const taskRequest = {
        ...request,
        url: "/internal/workflow-tasks/task/authorize",
        headers: { authorization: "Bearer task-claim" },
        payload: { stepId: "other-step", phase: "lease_renewal" },
      };
      assert.equal((await server.inject(taskRequest)).statusCode, 200);
      assert.equal(
        billingChecks,
        2,
        "Lease renewal must not repeat billing reservation",
      );
      await pool.query(
        "INSERT INTO identity.organizations(id,slug,name) VALUES('other','other','Other')",
      );
      await pool.query(
        "UPDATE runtime.worker_runtime_state SET organization_id='other' WHERE worker_id='runner'",
      );
      const scopeChecks = checks;
      for (const phase of ["dispatch", "lease_renewal", "resource"])
        assert.equal(
          (await server.inject({ ...taskRequest, payload: { phase } })).json()
            .code,
          "execution_target_revoked",
        );
      assert.equal(checks, scopeChecks);
      await pool.query(
        "UPDATE runtime.worker_runtime_state SET organization_id='org',status='draining' WHERE worker_id='runner'",
      );
      assert.equal((await server.inject(taskRequest)).statusCode, 200);
      await pool.query(
        "UPDATE execution.executor_assignments SET cancel_requested_at=now() WHERE id='assignment'",
      );
      assert.equal(
        (await server.inject(taskRequest)).json().code,
        "execution_lease_expired_or_cancelled",
      );
      await pool.query(
        "UPDATE execution.executor_assignments SET cancel_requested_at=NULL WHERE id='assignment'",
      );
      await pool.query(
        "UPDATE execution.workflow_tasks SET lease_expires_at=now()-interval '1 second' WHERE id='task'",
      );
      const before = checks;
      assert.equal(
        (await server.inject(taskRequest)).json().code,
        "execution_lease_expired_or_cancelled",
      );
      assert.equal(checks, before);
      await pool.query(
        "UPDATE execution.workflow_runs SET status='cancel_requested' WHERE id=$1",
        [run.id],
      );
      assert.equal((await server.inject(request)).statusCode, 403);
    } finally {
      await server.close();
    }
  },
);

test(
  "MCP revocation and bound input credentials are checked against current records",
  { skip: !source },
  async () => {
    // mcp.tokens is created by the target schema; insert into the real table
    // rather than a stand-in, so the columns and constraints under test are
    // the ones production uses.
    await pool.query(
      `INSERT INTO mcp.tokens(id,organization_id,name,token_hash,scopes_json)
       VALUES('mcp','org','execution-authorization test','hash_mcp_exec','["run:transfers"]'::jsonb)
       ON CONFLICT (id) DO UPDATE SET scopes_json = EXCLUDED.scopes_json, revoked_at = NULL`,
    );
    const invoked = {
      ...run,
      execution_context_json: {
        ...run.execution_context_json,
        mcpTokenId: "mcp",
      },
    };
    await assertWorkflowExecutionAuthorized(pool, invoked, "step", {
      input_json: { apiKey: "key" },
    });
    // "invalid" was in this list while scopes was a text column. scopes_json
    // is jsonb, so a malformed value can no longer be stored at all — the
    // column enforces what parseMcpScopes used to have to tolerate.
    for (const scopes of ["[]", "null", '["read:runs"]']) {
      await pool.query(
        "UPDATE mcp.tokens SET scopes_json=$1::jsonb WHERE id='mcp'",
        [scopes],
      );
      await assert.rejects(
        assertWorkflowExecutionAuthorized(pool, invoked, "step"),
        { code: "execution_mcp_grant_revoked" },
      );
    }
    await pool.query(
      `UPDATE mcp.tokens SET scopes_json='["run:transfers"]'::jsonb,revoked_at=now() WHERE id='mcp'`,
    );
    await assert.rejects(
      assertWorkflowExecutionAuthorized(pool, invoked, "step"),
      { code: "execution_mcp_grant_revoked" },
    );
    await assert.rejects(
      assertWorkflowExecutionAuthorized(pool, run, "step", {
        input_json: { apiKey: "removed-resource" },
      }),
      { code: "execution_resource_credential_revoked" },
    );
  },
);
test("room membership alone does not grant operations and revoked role assignments stop authorizing", () => {
  const snapshot = {
    memberships: [{ member_id: "member", state: "active" }],
    channels: [{ channel_id: "channel", state: "active" }],
    roles: [{ role_id: "role", state: "active" }],
    member_roles: [
      {
        room_id: "room",
        member_id: "member",
        role_id: "role",
        state: "active",
      },
    ],
    grants: [
      {
        room_id: "room",
        channel_id: "channel",
        subject_type: "role",
        subject_id: "role",
        actions: ["publish"],
        state: "active",
      },
    ],
  };
  assert.equal(
    roomMemberCan(snapshot, "room", "channel", "member", "publish"),
    true,
  );
  assert.equal(
    roomMemberCan(snapshot, "room", "channel", "member", "request"),
    false,
  );
  snapshot.member_roles[0]!.state = "revoked";
  assert.equal(
    roomMemberCan(snapshot, "room", "channel", "member", "publish"),
    false,
  );
  snapshot.member_roles[0]!.state = "active";
  snapshot.roles[0]!.state = "revoked";
  assert.equal(
    roomMemberCan(snapshot, "room", "channel", "member", "publish"),
    false,
  );
});

test(
  "frozen managed-agent and resource references remain subject to current scope and revocation",
  { skip: !source },
  async () => {
    await pool.query(
      "INSERT INTO agent_control.agents(id,organization_id,name,public_key) VALUES('bound-agent','org','Bound agent','bound-agent-key')",
    );
    const bound = {
      ...run,
      template_snapshot_json: {
        ...run.template_snapshot_json,
        workflowTemplate: {
          ...run.template_snapshot_json.workflowTemplate,
          agentBindings: { source: { agentId: "bound-agent" } },
          resourceBindings: {
            key: { kind: "credential", credentialId: "key" },
          },
        },
      },
    };
    await assertWorkflowExecutionAuthorized(pool, bound, "step");
    await pool.query(
      "UPDATE agent_control.agents SET revoked_at=now(),status='revoked' WHERE id='bound-agent'",
    );
    await assert.rejects(
      assertWorkflowExecutionAuthorized(pool, bound, "step"),
      { code: "execution_agent_reference_unavailable" },
    );
    await pool.query(
      "UPDATE agent_control.agents SET revoked_at=NULL,status='offline',organization_id='other' WHERE id='bound-agent'",
    );
    await assert.rejects(
      assertWorkflowExecutionAuthorized(pool, bound, "step"),
      { code: "execution_agent_reference_unavailable" },
    );
    await pool.query(
      "UPDATE agent_control.agents SET organization_id='org' WHERE id='bound-agent'",
    );
    await pool.query(
      "INSERT INTO identity.projects(id,organization_id,name,slug) VALUES('bound-project','org','Bound project','bound-project')",
    );
    await pool.query(
      "UPDATE agent_control.agents SET project_id='bound-project' WHERE id='bound-agent'",
    );
    await assert.rejects(
      assertWorkflowExecutionAuthorized(pool, bound, "step"),
      { code: "execution_agent_reference_unavailable" },
    );
    await pool.query(
      "UPDATE agent_control.agents SET project_id=NULL WHERE id='bound-agent'",
    );
    bound.template_snapshot_json.workflowTemplate.resourceBindings.key.credentialId =
      "missing-credential";
    await assert.rejects(
      assertWorkflowExecutionAuthorized(pool, bound, "step"),
      { code: "execution_resource_reference_unavailable" },
    );
    assert.equal(JSON.stringify(bound).includes("test-only-key"), false);
  },
);

test(
  "configuration references resolve before manifest validation and retain authored revision expressions",
  { skip: !source },
  async () => {
    await pool.query(
      'UPDATE workflow.templates SET resource_bindings_json=\'{"settings":{"kind":"data","value":7}}\' WHERE id=\'workflow\'',
    );
    await pool.query(
      "UPDATE workflow.steps SET config_json='{\"amount\":\"${workflow.resources.settings.value}\"}' WHERE id='step'",
    );
    const tree = await withPostgresTransaction(pool, (client) =>
      captureWorkflowTreePg(client, {
        organizationId: "org",
        workflowTemplateId: "workflow",
        validateOnly: true,
      }),
    );
    assert.deepEqual(tree.root.resolvedSteps[0]!.config, { amount: 7 });
    assert.equal(
      (tree.root.snapshot.steps as any[])[0].config.amount,
      "${workflow.resources.settings.value}",
    );
  },
);

test(
  "an executor dispatch that asks for it receives a signed artifact URL before billing",
  { skip: !source },
  async () => {
    await pool.query(
      "UPDATE execution.workflow_runs SET status='running' WHERE id=$1",
      [run.id],
    );
    const signedUrl = `https://api.b1m.ai/registry/v1/artifacts/sha256/${"d".repeat(64)}?exp=1&sig=s`;
    const signed: Array<{ organizationId: string; stepId: string }> = [];
    let signing: "ok" | "unavailable" | "mismatch" = "ok";
    let billingChecks = 0;
    const server = Fastify();
    registerWorkflowExecutionAuthorizationRoutes(
      server,
      pool,
      async () => {
        billingChecks++;
      },
      async (target, step) => {
        signed.push({
          organizationId: String(target.organization_id),
          stepId: String(step.id),
        });
        if (signing === "unavailable")
          throw new WorkflowAuthorityUnavailableError(
            "executor_artifact_url_unavailable",
          );
        if (signing === "mismatch")
          throw new WorkflowAuthorizationError(
            "executor_artifact_integrity_changed",
          );
        return signedUrl;
      },
    );
    try {
      const token = (
        await pool.query(
          "SELECT authorization_token FROM execution.workflow_run_capabilities WHERE workflow_run_id=$1",
          [run.id],
        )
      ).rows[0].authorization_token;
      const dispatch = (payload: Record<string, unknown>) =>
        server.inject({
          method: "POST",
          url: `/internal/workflow-runs/${run.id}/authorize`,
          headers: { authorization: `Bearer ${token}` },
          payload: { stepId: "step", phase: "dispatch", ...payload },
        });

      const granted = await dispatch({ artifactUrl: true });
      assert.equal(granted.statusCode, 200);
      assert.deepEqual(granted.json(), {
        authorized: true,
        artifactUrl: signedUrl,
      });
      assert.deepEqual(signed, [{ organizationId: "org", stepId: "step" }]);

      // Callers that do not ask (room-member dispatch signs on its own) and
      // other phases never trigger a Registry round trip.
      assert.deepEqual((await dispatch({})).json(), { authorized: true });
      assert.deepEqual(
        (await dispatch({ artifactUrl: true, phase: "retry" })).json(),
        { authorized: true },
      );
      assert.equal(signed.length, 1);

      const before = billingChecks;
      signing = "unavailable";
      const unavailable = await dispatch({ artifactUrl: true });
      assert.equal(unavailable.statusCode, 503);
      assert.equal(
        unavailable.json().code,
        "executor_artifact_url_unavailable",
      );
      assert.equal(unavailable.json().retryable, true);
      signing = "mismatch";
      const refused = await dispatch({ artifactUrl: true });
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.json().code, "executor_artifact_integrity_changed");
      assert.equal(billingChecks, before, "no hold for a refused artifact");
      const persisted = (
        await pool.query(
          "SELECT resolved_steps_json FROM execution.workflow_runs WHERE id=$1",
          [run.id],
        )
      ).rows[0].resolved_steps_json;
      assert.doesNotMatch(JSON.stringify(persisted), /sig=/);
    } finally {
      await server.close();
    }
  },
);
