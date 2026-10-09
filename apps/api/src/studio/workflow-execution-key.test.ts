import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueFrozenWorkflowRunPg,
  WorkflowAuthorizationError,
  type FrozenWorkflowDefinition,
  type PgClient,
} from "@beam-studio/db";

function definition(apiKeyId: unknown): FrozenWorkflowDefinition {
  return {
    revisionId: "revision",
    workflowTemplateId: "workflow",
    organizationId: "organization",
    projectId: null,
    snapshot: {
      workflowTemplate: { apiKeyId },
      contract: {
        inputSchema: { type: "object" },
        output: { schema: { type: "object" }, bindings: {} },
      },
    },
    resolvedSteps: [],
  };
}

function database() {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return {
        rows: sql.includes("INSERT INTO execution.workflow_runs")
          ? [{ id: values[0] }]
          : [],
        rowCount: 1,
      };
    },
  } as unknown as PgClient;
  return { client, queries };
}

for (const key of [null, undefined, "", "   ", 123]) {
  test(`missing root key (${String(key)}) rejects before enqueue side effects`, async () => {
    const { client, queries } = database();
    const root = definition(key);
    // Only a Beam Transfer step's Beam credential stands in for the key; any
    // other action's credential is for another service.
    root.resolvedSteps = [{ config: { credentialId: "action-key" } }];
    await assert.rejects(
      enqueueFrozenWorkflowRunPg(client, {
        definition: root,
        definitions: { workflow: root },
        runtimeInput: {},
        trigger: "manual",
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowAuthorizationError);
        assert.equal(error.code, "execution_credential_missing");
        assert.match(error.message, /Workflow Settings/);
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(queries.length, 0);
  });
}

test("without a selected key, a root is charged to its Beam Transfer step's credential", async () => {
  const { client, queries } = database();
  const root = definition(null);
  const manifest = (name: string) => ({
    apiVersion: "workflow-actions/v1",
    name,
    configSchema: { type: "object" },
  });
  root.resolvedSteps = [
    {
      actionPackage: "@beam/object-storage-endpoint",
      manifestSnapshot: manifest("@beam/object-storage-endpoint"),
      config: { credentialId: "storage-key" },
    },
    {
      actionPackage: "@beam/transfer",
      manifestSnapshot: manifest("@beam/transfer"),
      enabled: true,
      config: { credentialId: "transfer-key" },
    },
  ];
  await enqueueFrozenWorkflowRunPg(client, {
    definition: root,
    definitions: { workflow: root },
    runtimeInput: {},
    trigger: "manual",
  });
  const insert = queries.find(({ sql }) =>
    sql.includes("INSERT INTO execution.workflow_runs"),
  )!;
  assert.equal(
    JSON.parse(String(insert.values[12])).billing.apiKeyId,
    "transfer-key",
  );
});

test("Beam Transfer steps naming different credentials need a selected key", async () => {
  const { client, queries } = database();
  const root = definition(null);
  root.resolvedSteps = ["first-key", "second-key"].map((credentialId) => ({
    actionPackage: "@beam/transfer",
    enabled: true,
    config: { credentialId },
  }));
  await assert.rejects(
    enqueueFrozenWorkflowRunPg(client, {
      definition: root,
      definitions: { workflow: root },
      runtimeInput: {},
      trigger: "manual",
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowAuthorizationError);
      assert.equal(error.code, "execution_credential_missing");
      assert.match(error.message, /different Beam credentials/);
      return true;
    },
  );
  assert.equal(queries.length, 0);
});

test("a root freezes its selected definition key, ignoring client billing overrides", async () => {
  const { client, queries } = database();
  const root = definition("workflow-key");
  await enqueueFrozenWorkflowRunPg(client, {
    definition: root,
    definitions: { workflow: root },
    runtimeInput: {},
    trigger: "manual",
    executionContext: { billing: { apiKeyId: "other-key" } },
  });
  const insert = queries.find(({ sql }) =>
    sql.includes("INSERT INTO execution.workflow_runs"),
  )!;
  const context = JSON.parse(String(insert.values[12]));
  assert.equal(context.billing.apiKeyId, "workflow-key");
  assert.equal(context.billing.creditOperationKey, insert.values[17]);
  const capture = queries.find(({ sql }) =>
    sql.includes("FROM secrets.credentials"),
  )!;
  assert.equal(capture.values[2], "workflow-key");
});

test("a child inherits the frozen parent key without a child definition key", async () => {
  const { client, queries } = database();
  const child = definition(null);
  const billing = {
    apiKeyId: "parent-key",
    creditOperationKey: "parent-operation",
  };
  await enqueueFrozenWorkflowRunPg(client, {
    definition: child,
    definitions: { workflow: child },
    runtimeInput: {},
    trigger: "workflow_call",
    parentRunId: "parent",
    executionContext: { billing, environment: "prod", beam: { defaults: {} } },
  });
  const insert = queries.find(({ sql }) =>
    sql.includes("INSERT INTO execution.workflow_runs"),
  )!;
  assert.deepEqual(JSON.parse(String(insert.values[12])).billing, billing);
  assert.equal(insert.values[17], null);
  assert.equal(
    queries.some(({ sql }) => sql.includes("FROM secrets.credentials")),
    false,
  );
});

test("a child cannot replace missing inherited authority with its definition key", async () => {
  const { client, queries } = database();
  const child = definition("child-key");
  await assert.rejects(
    enqueueFrozenWorkflowRunPg(client, {
      definition: child,
      definitions: { workflow: child },
      runtimeInput: {},
      trigger: "workflow_call",
      parentRunId: "parent",
    }),
    { code: "execution_credential_missing" },
  );
  assert.equal(queries.length, 0);
});
