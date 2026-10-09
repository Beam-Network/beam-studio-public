import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantOperation,
  AssistantOperationPlan,
} from "@beam-studio/shared";
import {
  AssistantPlanError,
  assistantConfirmationForRisk,
  assistantPlanValidationHash,
  resolveAssistantOperationOrder,
  routeStudioAssistantIntent,
  studioAssistantToolDescriptors,
  validateAssistantPlan,
  type AssistantActionPackage,
  type AssistantExecutionScope,
} from "./assistant-operations.js";
import {
  createAssistantChatResponse,
  fallbackUniversalPlanDraft,
} from "./assistant.js";

const scope: AssistantExecutionScope = {
  organizationId: "org_1",
  projectId: "prj_1",
  userId: "usr_1",
  permissions: ["workflow:read", "workflow:write"],
};

const actions: AssistantActionPackage[] = [
  {
    name: "@beam/list",
    version: "1.2.0",
    manifest: {
      configSchema: { type: "object" },
      permissions: ["storage:read"],
    },
  },
];

test("intent router selects workflow creation and structured reads", () => {
  assert.equal(
    routeStudioAssistantIntent("Crée un workflow manuel pour lister S3"),
    "workflow.create",
  );
  assert.equal(
    routeStudioAssistantIntent("Show me failed workflow runs"),
    "studio.read",
  );
  assert.equal(
    routeStudioAssistantIntent(
      "Que fait le workflow @[Test workflow](studio:workflow:wft_1) ?",
    ),
    "read",
  );
});

test("read-only workflow questions return a concise answer without a plan", async () => {
  const response = await createAssistantChatResponse({
    actions,
    messages: [
      {
        role: "user",
        content:
          "Que fait le workflow @[Test workflow](studio:workflow:wft_1) ?",
      },
    ],
    route: "/",
    routeContext: {
      workflows: [
        {
          id: "wft_1",
          name: "Test workflow",
          description: "Calls two children with public outputs.",
          href: "/workflows/wft_1/editor",
        },
      ],
    },
  });
  assert.match(response.message, /Test workflow/);
  assert.equal("plan" in response, false);
});

test("tool catalogue covers every Studio resource domain with typed risk", () => {
  const tools = new Map(
    studioAssistantToolDescriptors().map((descriptor) => [
      descriptor.name,
      descriptor,
    ]),
  );
  for (const name of [
    "workflow.create",
    "workflow.update_graph",
    "transfer.create",
    "transfer.endpoint.create",
    "schedule.create",
    "credential.validate_access",
    "registry.install",
    "run.monitor",
    "run.diagnose",
    "queue.inspect",
    "dead_letter.inspect",
    "orchestration.inspect",
    "mcp.token.create",
    "workspace.navigate",
  ]) {
    assert.ok(tools.has(name), `${name} must be registered`);
    assert.equal(tools.get(name)?.inputSchema.type, "object");
  }
  assert.equal(tools.has("job.create"), false);
  assert.equal(tools.get("workflow.delete")?.risk, "destructive");
  assert.equal(tools.get("mcp.token.create")?.risk, "security");
  assert.equal(tools.get("run.monitor")?.risk, "read");
});

test("child workflow operations are ordered before their parent", () => {
  const operations: AssistantOperation[] = [
    {
      ...operation("parent", ["workflow_import", "workflow_validation"]),
      tool: "workflow.create",
    },
    { ...operation("workflow_import"), tool: "workflow.create" },
    { ...operation("workflow_validation"), tool: "workflow.create" },
  ];
  assert.deepEqual(resolveAssistantOperationOrder(operations), [
    "workflow_import",
    "workflow_validation",
    "parent",
  ]);
});

test("provider fallback creates missing workflows before a composing parent", () => {
  const draft = fallbackUniversalPlanDraft(
    "Crée un workflow composé de validation et Import CSV en séquence",
    {
      workflows: [{ id: "wft_import", name: "Import CSV" }],
      registry: {
        packages: [
          {
            name: "@beam/validate-csv",
            displayName: "Validation CSV",
            version: "1.0.0",
          },
        ],
      },
    },
  );
  assert.deepEqual(
    draft.operations.map((operation) => operation.tool),
    ["workflow.create", "workflow.create"],
  );
  assert.deepEqual(draft.operations[1]?.dependsOn, ["create_workflow_1"]);
  const parent = draft.operations[1]?.arguments.workflow as {
    steps: Array<{ kind: string; calledWorkflowId: string }>;
    output: unknown;
  };
  assert.equal(parent.steps[1]?.kind, "workflow");
  assert.equal(
    parent.steps[1]?.calledWorkflowId,
    "${operations.create_workflow_1.result.id}",
  );
  assert.deepEqual(parent.output, {
    schema: { type: "object", additionalProperties: false },
    bindings: {},
  });
});

test("typed mentions take precedence over fuzzy resource matching", () => {
  const draft = fallbackUniversalPlanDraft(
    "Supprime le workflow @[Import quotidien](studio:workflow:wft_exact)",
    {
      workflows: [
        { id: "wft_fuzzy", name: "Import quotidien" },
        { id: "wft_exact", name: "Autre nom" },
      ],
    },
  );

  assert.equal(draft.operations[0]?.tool, "workflow.delete");
  assert.equal(draft.operations[0]?.arguments.id, "wft_exact");
});

test("operation dependency resolution is stable and rejects cycles", () => {
  const operations: AssistantOperation[] = [
    operation("parent", ["workflow_a", "workflow_b"]),
    operation("workflow_b"),
    operation("workflow_a"),
  ];
  assert.deepEqual(resolveAssistantOperationOrder(operations), [
    "workflow_a",
    "workflow_b",
    "parent",
  ]);

  assert.throws(
    () =>
      resolveAssistantOperationOrder([
        operation("a", ["b"]),
        operation("b", ["a"]),
      ]),
    (error: unknown) =>
      error instanceof AssistantPlanError &&
      error.code === "invalid_dependencies",
  );
});

test("plan validation enforces organization, project and user scope", () => {
  assert.throws(
    () =>
      validateAssistantPlan(plan(), {
        actions,
        scope: { ...scope, projectId: "prj_2" },
      }),
    (error: unknown) =>
      error instanceof AssistantPlanError && error.code === "scope_mismatch",
  );
});

test("plan validation enforces tool permissions and Registry actions", () => {
  const missingPermission = validateAssistantPlan(plan(), {
    actions,
    scope: { ...scope, permissions: ["workflow:read"] },
  });
  assert.match(missingPermission.errors.join(" "), /workflow:write/);

  const unknownActionPlan = plan();
  workflow(unknownActionPlan).steps = [
    {
      ...workflow(unknownActionPlan).steps[0],
      actionPackageName: "@beam/does-not-exist",
    },
  ];
  const unknownAction = validateAssistantPlan(unknownActionPlan, {
    actions,
    scope,
  });
  assert.match(unknownAction.errors.join(" "), /not available/);
});

test("plan validation rejects secrets and invalid triggers before preview", () => {
  const unsafePlan = plan();
  const firstStep = workflow(unsafePlan).steps[0] as Record<string, unknown>;
  firstStep.config = { apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456" };
  const unsafe = validateAssistantPlan(unsafePlan, { actions, scope });
  assert.match(unsafe.errors.join(" "), /forbidden secret data/);
  assert.equal(unsafe.plan.preview, undefined);

  const triggerPlan = plan();
  workflow(triggerPlan).triggers = [
    {
      id: "trigger_1",
      type: "made-up",
      name: "Invalid",
      enabled: true,
      config: {},
      state: {},
      canvasX: 0,
      canvasY: 0,
    },
  ];
  const invalidTrigger = validateAssistantPlan(triggerPlan, { actions, scope });
  assert.match(invalidTrigger.errors.join(" "), /Unsupported trigger type/);
});

test("validated plans produce a preview and require write confirmation", () => {
  const validated = validateAssistantPlan(plan(), { actions, scope });
  assert.deepEqual(validated.errors, []);
  assert.equal(validated.plan.status, "ready");
  assert.equal(validated.plan.confirmation.policy, "simple");
  assert.equal(validated.plan.confirmation.required, true);
  assert.equal(validated.plan.preview?.diffs[0]?.change, "create");
});

test("destructive operations always require explicit confirmation", () => {
  assert.deepEqual(assistantConfirmationForRisk("destructive"), {
    policy: "explicit",
    required: true,
  });
});

test("validation hash is stable for idempotent double submission", () => {
  const first = plan();
  const second = structuredClone(first);
  assert.equal(
    assistantPlanValidationHash(first, actions, scope),
    assistantPlanValidationHash(second, actions, scope),
  );
});

function plan(): AssistantOperationPlan {
  const timestamp = "2026-07-27T12:00:00.000Z";
  return {
    id: "apl_1",
    version: 1,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    userId: scope.userId,
    intent: "workflow.create",
    summary: "Create a list workflow",
    operations: [
      {
        id: "op_1",
        tool: "workflow.create",
        arguments: {
          workflow: {
            id: "wft_ast_1",
            name: "List S3",
            description: "List a bucket",
            enabled: true,
            triggers: [
              {
                id: "trigger_1",
                type: "manual",
                name: "Manual",
                enabled: true,
                config: {},
                state: {},
                canvasX: 0,
                canvasY: 0,
              },
            ],
            triggerEdges: [
              {
                id: "trigger_edge_1",
                triggerId: "trigger_1",
                toStepId: "step_1",
                condition: null,
              },
            ],
            steps: [
              {
                id: "step_1",
                actionPackageName: "@beam/list",
                actionVersionRange: "*",
                position: 0,
                enabled: true,
                config: {},
                inputBindings: {},
                placement: "local-workers",
                executionLocationId: null,
                canvasX: 300,
                canvasY: 0,
                timeoutSeconds: null,
                required: true,
              },
            ],
            edges: [],
          },
        },
        dependsOn: [],
        risk: "write",
        reversible: true,
        status: "pending",
      },
    ],
    needsInput: [],
    assumptions: [],
    risks: [],
    status: "draft",
    confirmation: { policy: "simple", required: true },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function workflow(planValue: AssistantOperationPlan) {
  return planValue.operations[0]?.arguments.workflow as {
    steps: Array<Record<string, unknown>>;
    triggers: Array<Record<string, unknown>>;
  };
}

function operation(id: string, dependsOn: string[] = []): AssistantOperation {
  return {
    id,
    tool: "test",
    arguments: {},
    dependsOn,
    risk: "draft",
    reversible: true,
    status: "pending",
  };
}
