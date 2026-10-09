import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantPromptFixtures,
  assistantWorkflowPlanFixtures,
} from "./studio-ai-assistant.fixtures.js";
import { parseAssistantOperationPlan } from "./assistant-operation-plan.js";
import {
  assistantEntityHref,
  compactCredentialMetadata,
  compactWorkflowPayload,
  createAssistantContext,
  normalizeAssistantMarkdownLinks,
  normalizeAssistantWorkflowPlan,
  parseAssistantEntityMentions,
  redactAssistantPayload,
} from "./studio-ai-assistant.js";

test("redactAssistantPayload removes secrets while keeping credential references", () => {
  const redacted = redactAssistantPayload({
    credentialId: "cred_123",
    nested: {
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456",
      awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
      envVars: { OPENAI_API_KEY: "secret" },
      optionalValue: undefined,
    },
    publicBucket: "beam-demo",
  });

  assert.deepEqual(redacted, {
    credentialId: "cred_123",
    nested: {
      apiKey: "[redacted]",
      awsAccessKeyId: "[redacted]",
      envVars: "[redacted]",
    },
    publicBucket: "beam-demo",
  });
  assert.equal("optionalValue" in redacted.nested, false);
});

test("legacy plan previews normalize null resource IDs", () => {
  const parsed = parseAssistantOperationPlan({
    id: "apl_1",
    version: 1,
    organizationId: "org_1",
    projectId: null,
    userId: null,
    intent: "workflow.create",
    summary: "Create a workflow",
    operations: [],
    needsInput: [],
    assumptions: [],
    risks: [],
    status: "ready",
    preview: {
      generatedAt: "2026-09-03T00:00:00.000Z",
      validationHash: "hash_1",
      diffs: [
        {
          resourceType: "workflow",
          resourceId: null,
          label: "New workflow",
          change: "create",
          before: null,
          after: {},
        },
      ],
      warnings: [],
    },
    confirmation: { policy: "simple", required: true },
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  });

  assert.equal(parsed.preview?.diffs[0]?.resourceId, undefined);
});

test("parseAssistantEntityMentions extracts typed Studio references", () => {
  assert.deepEqual(
    parseAssistantEntityMentions(
      "Relance @[Import CSV](studio:workflow:wft_123) avec @[S3 prod](studio:credential:cred_9).",
    ).map(({ id, name, type }) => ({ id, name, type })),
    [
      { id: "wft_123", name: "Import CSV", type: "workflow" },
      { id: "cred_9", name: "S3 prod", type: "credential" },
    ],
  );
  assert.deepEqual(
    parseAssistantEntityMentions("@[Fake](studio:unknown:anything)"),
    [],
  );
});

test("Studio entity mentions resolve to navigable resource routes", () => {
  assert.equal(assistantEntityHref("job", "job_1"), null);
  assert.equal(
    assistantEntityHref("workflow", "workflow 1"),
    "/workflows/workflow%201/editor",
  );
  assert.equal(
    assistantEntityHref("registry_action", "@beam/e2e-wait"),
    "/registry/@beam/e2e-wait",
  );
  assert.equal(assistantEntityHref("unknown", "id"), null);
});

test("assistant Markdown normalizes invented Studio hosts", () => {
  assert.equal(
    normalizeAssistantMarkdownLinks(
      "Le [Test workflow](https://studio/ workflows/wft_1) est prêt.",
    ),
    "Le [Test workflow](/workflows/wft_1) est prêt.",
  );
  assert.equal(
    normalizeAssistantMarkdownLinks(
      "Voir [le workflow](https://studio.local/workflows/wft_1/editor).",
    ),
    "Voir [le workflow](/workflows/wft_1/editor).",
  );
});

test("compactWorkflowPayload whitelists graph fields and redacts configs", () => {
  const workflow = compactWorkflowPayload({
    template: {
      id: "wft_1",
      name: "Nightly copy",
      description: "Copy files every night",
      ignored: "not sent",
    },
    triggers: [
      {
        id: "tr_1",
        type: "manual",
        name: "Manual",
        enabled: true,
        config: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
        state: { lastRunId: "run_1" },
        canvasX: 10,
        canvasY: 20,
      },
    ],
    steps: [
      {
        id: "step_1",
        actionPackageName: "@beam/object-storage-endpoint",
        actionVersionRange: "*",
        enabled: true,
        config: {
          bucket: "source-bucket",
          credentialId: "cred_1",
          secretAccessKey: "hidden",
        },
        inputBindings: { endpoint: "${steps.source.outputs.endpoint}" },
        manifest: { configSchema: { secret: "ignored" } },
        position: 0,
      },
    ],
    edges: [
      {
        id: "edge_1",
        fromStepId: "step_1",
        toStepId: "step_2",
        condition: { token: "hidden" },
      },
    ],
    triggerEdges: [
      {
        id: "tre_1",
        triggerId: "tr_1",
        toStepId: "step_1",
        condition: null,
      },
    ],
  });

  assert.equal(workflow?.template?.name, "Nightly copy");
  assert.equal(workflow?.steps[0]?.config.credentialId, "cred_1");
  assert.equal(workflow?.steps[0]?.config.secretAccessKey, "[redacted]");
  assert.equal(workflow?.triggers[0]?.config.authorization, "[redacted]");
  assert.deepEqual(workflow?.edges[0]?.condition, { token: "[redacted]" });
  assert.equal("manifest" in (workflow?.steps[0] ?? {}), false);
});

test("compactCredentialMetadata drops credential payloads", () => {
  const metadata = compactCredentialMetadata({
    id: "cred_1",
    name: "S3 prod",
    kind: "s3-compatible",
    provider: "aws",
    payload: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "hidden",
    },
    payloadPreview: "AKIAIOSFODNN7EXAMPLE",
  });

  assert.deepEqual(metadata, {
    id: "cred_1",
    name: "S3 prod",
    kind: "s3-compatible",
    provider: "aws",
    payloadPreview: "[redacted]",
  });
  assert.equal("payload" in (metadata ?? {}), false);
});

test("normalizeAssistantWorkflowPlan returns structured patch errors", () => {
  const normalized = normalizeAssistantWorkflowPlan(
    assistantWorkflowPlanFixtures.invalidUnsupportedOperation,
  );

  assert.equal(normalized.plan?.patch.length, 0);
  assert.deepEqual(normalized.errors, [
    "patch[0]: Unsupported operation delete_node.",
  ]);
  assert.equal(normalized.errorDetails[0]?.code, "unsupported_operation");
  assert.equal(normalized.errorDetails[0]?.path, "patch[0]");
});

test("normalizeAssistantWorkflowPlan supports every editor trigger type", () => {
  for (const triggerType of [
    "manual",
    "schedule",
    "webhook",
    "date",
    "completion",
  ]) {
    const normalized = normalizeAssistantWorkflowPlan({
      message: "Add trigger",
      plan: [],
      patch: [
        {
          op: "add_trigger",
          ref: `trigger_${triggerType}`,
          triggerType,
          config:
            triggerType === "date" ? { runAt: "2026-08-01T02:00:00.000Z" } : {},
        },
      ],
      needsInput: [],
      risks: [],
      assumptions: [],
    });
    assert.equal(normalized.errors.length, 0);
    assert.equal(normalized.plan?.patch[0]?.op, "add_trigger");
  }
});

test("normalizeAssistantWorkflowPlan supports graph edit and runtime operations", () => {
  const patch = [
    {
      op: "update_step",
      stepRef: "step_1",
      actionPackageName: "@beam/http-request",
      enabled: false,
      config: { method: "GET" },
    },
    { op: "remove_step", stepRef: "step_2" },
    { op: "disconnect", fromRef: "step_1", toRef: "step_2" },
    { op: "remove_edge", edgeRef: "edge_1" },
    { op: "update_edge", edgeRef: "edge_2", condition: { ok: true } },
    {
      op: "update_trigger",
      triggerRef: "trigger_1",
      triggerType: "schedule",
      enabled: true,
      config: { timezone: "America/Guadeloupe" },
    },
    { op: "remove_trigger", triggerRef: "trigger_2" },
    {
      op: "set_step_runtime",
      stepRef: "step_1",
      executionTarget: {
        kind: "remote-transport",
        executionLocationId: "loc_1",
      },
      timeoutSeconds: 300,
      required: true,
    },
    {
      op: "set_workflow_metadata",
      name: "Nightly validation",
      enabled: true,
    },
  ];
  const normalized = normalizeAssistantWorkflowPlan({
    message: "Update graph",
    plan: [],
    patch,
    needsInput: [],
    risks: [],
    assumptions: [],
  });

  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(
    normalized.plan?.patch.map((operation) => operation.op),
    patch.map((operation) => operation.op),
  );
});

test("createAssistantContext compacts shared context for prompts", () => {
  const context = createAssistantContext({
    actions: [
      {
        name: "@beam/upload",
        version: "1.0.0",
        manifest: {
          displayName: "Upload",
          description: "Uploads workflow content to object storage.",
          configSchema: { type: "object" },
          permissions: ["storage:write"],
        },
      },
    ],
    credentials: [{ id: "cred_1", name: "S3", kind: "s3", token: "hidden" }],
    messages: [
      { role: "user", content: assistantPromptFixtures.generateS3Transfer },
      { role: "assistant", content: "Use the Upload action." },
    ],
    route: "/workflows/wft_1",
    runs: [{ id: "run_1", status: "failed", error: "Bearer abcdefghijklmnop" }],
    validationErrors: ["Step step_1 requires credentialId."],
    workflow: {
      steps: [
        {
          id: "step_1",
          actionPackageName: "@beam/upload",
          enabled: true,
          config: {},
          inputBindings: {},
        },
      ],
    },
    workflowId: "wft_1",
  });

  assert.equal(context.route, "/workflows/wft_1");
  assert.equal(context.actions[0]?.name, "@beam/upload");
  assert.equal(context.actions[0]?.href, "/registry/@beam/upload");
  assert.equal(context.credentials[0]?.id, "cred_1");
  assert.equal(context.runs[0]?.error, "[redacted]");
  assert.equal(context.workflow?.steps[0]?.actionPackageName, "@beam/upload");
  assert.deepEqual(context.validationErrors, [
    "Step step_1 requires credentialId.",
  ]);
});

function planWith(patch: unknown[]) {
  return normalizeAssistantWorkflowPlan({
    summary: "Branch on the transfer outcome.",
    steps: ["Add a decision."],
    patch,
  });
}

test("normalizeAssistantWorkflowPlan accepts a decision and its branches", () => {
  const normalized = planWith([
    {
      op: "add_decision",
      ref: "gate",
      name: "Transfer finished",
      joinMode: "any_settled",
      handleFailure: true,
      predicate: {
        all: [{ left: "${steps.a.status}", op: "eq", right: "completed" }],
      },
    },
    { op: "connect", fromRef: "a", toRef: "gate" },
    { op: "connect", fromRef: "gate", toRef: "next", branch: "true" },
    { op: "connect", fromRef: "gate", toRef: "alert", branch: "false" },
  ]);

  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.plan?.patch.length, 4);
  const decision = normalized.plan?.patch[0];
  assert.equal(decision?.op, "add_decision");
  assert.equal(
    decision?.op === "add_decision" ? decision.joinMode : null,
    "any_settled",
  );
  assert.equal(
    decision?.op === "add_decision" ? decision.handleFailure : null,
    true,
  );
  const branches = (normalized.plan?.patch ?? [])
    .filter((operation) => operation.op === "connect")
    .map((operation) =>
      operation.op === "connect" ? (operation.branch ?? null) : null,
    );
  assert.deepEqual(branches, [null, "true", "false"]);
});

test("a decision defaults to the all join rather than being rejected", () => {
  const normalized = planWith([{ op: "add_decision", ref: "gate" }]);
  assert.deepEqual(normalized.errors, []);
  const decision = normalized.plan?.patch[0];
  assert.equal(
    decision?.op === "add_decision" ? decision.joinMode : null,
    "all",
  );
});

test("an unknown join mode or branch is reported rather than silently coerced", () => {
  const badJoin = planWith([
    { op: "add_decision", ref: "gate", joinMode: "any_first" },
  ]);
  assert.equal(badJoin.plan?.patch.length, 0);
  assert.match(badJoin.errors[0] ?? "", /joinMode must be all or any_settled/);

  const badBranch = planWith([
    { op: "connect", fromRef: "gate", toRef: "next", branch: "maybe" },
  ]);
  assert.equal(badBranch.plan?.patch.length, 0);
  assert.match(badBranch.errors[0] ?? "", /branch must be true or false/);
});
