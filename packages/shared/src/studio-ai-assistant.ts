import {
  actionExecutionTargetSchema,
  type ActionExecutionTarget,
} from "./action-execution.js";
import { isStudioAssistantHref } from "./assistant-navigation.js";

export type AssistantJsonValue =
  | string
  | number
  | boolean
  | null
  | AssistantJsonValue[]
  | { [key: string]: AssistantJsonValue };

export type AssistantJsonObject = { [key: string]: AssistantJsonValue };

export const ASSISTANT_ENTITY_MENTION_TYPES = [
  "workflow",
  "transfer",
  "run",
  "credential",
  "schedule",
  "registry_action",
  "execution_location",
  "mcp_token",
  "organization",
  "project",
] as const;

export type AssistantEntityMention = {
  id: string;
  name: string;
  type: (typeof ASSISTANT_ENTITY_MENTION_TYPES)[number];
  start: number;
  end: number;
};

export function assistantEntityHref(type: string, id: string): string | null {
  const encodedId = encodeURIComponent(id);
  switch (type) {
    case "workflow":
      return `/workflows/${encodedId}/editor`;
    case "transfer":
      return `/transfers/${encodedId}`;
    case "run":
      return `/workflows/runs/${encodedId}`;
    case "schedule":
      return `/schedules/${encodedId}`;
    case "registry_action": {
      const [scope, ...nameParts] = id.split("/");
      const name = nameParts.join("/");
      if (!scope || !name) return "/registry";
      return `/registry/${encodeURIComponent(scope).replace("%40", "@")}/${encodeURIComponent(name)}`;
    }
    case "credential":
      return "/credentials";
    case "execution_location":
      return "/orchestration";
    case "mcp_token":
      return "/mcp/tokens";
    case "organization":
    case "project":
      return "/settings";
    default:
      return null;
  }
}

export function normalizeAssistantMarkdownLinks(content: string) {
  return content.replace(
    /\]\(\s*https?:\/\/studio(?:\.local)?\/\s*((?:workflows|transfers|runs|credentials|schedules|registry|orchestration|mcp|settings)(?:\/[^)\s]*)?)\s*\)/gi,
    (_match, path: string) => `](/${path})`,
  );
}

// Keep code examples intact; only prose links are navigation targets.
export function sanitizeAssistantMarkdownLinks(
  content: string,
  allowedHrefs?: ReadonlySet<string>,
) {
  return content
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g)
    .map((part, index) => {
      if (index % 2) return part;
      const normalized = normalizeAssistantMarkdownLinks(part).replace(
        /\]\(\s*https?:\/\/studio(?:\.local)?\/\s*([^\s)]*)\s*\)/gi,
        (_match, path: string) => `](/${path})`,
      );
      return normalized.replace(
        /(?<!!)\[((?:\\.|[^\]\\])*)\]\(\s*(\/[^\s)]*)(?:\s+"[^"]*")?\s*\)/g,
        (link, label: string, href: string) =>
          isStudioAssistantHref(href) &&
          (!allowedHrefs || allowedHrefs.has(href))
            ? link
            : label,
      );
    })
    .join("");
}

export function parseAssistantEntityMentions(
  content: string,
): AssistantEntityMention[] {
  const supported = new Set<string>(ASSISTANT_ENTITY_MENTION_TYPES);
  const pattern = /@\[((?:\\.|[^\]])+)\]\(studio:([a-z_]+):([^)]+)\)/g;
  const mentions: AssistantEntityMention[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const type = match[2] ?? "";
    const id = (match[3] ?? "").trim();
    if (!supported.has(type) || !id) continue;
    mentions.push({
      id,
      name: (match[1] ?? "").replace(/\\([[\]\\])/g, "$1"),
      type: type as AssistantEntityMention["type"],
      start: match.index,
      end: pattern.lastIndex,
    });
  }
  return mentions;
}

export type AssistantWorkflowTriggerType =
  | "manual"
  | "schedule"
  | "webhook"
  | "date"
  | "completion";

export type AssistantDecisionJoinMode = "all" | "any_settled";
export type AssistantDecisionBranch = "true" | "false";

export type AssistantWorkflowPatchOperation =
  | {
      op: "add_trigger";
      ref: string;
      triggerType: AssistantWorkflowTriggerType;
      name?: string;
      config?: AssistantJsonObject;
    }
  | {
      op: "add_step";
      ref: string;
      actionPackageName: string;
      config?: AssistantJsonObject;
    }
  | {
      op: "add_decision";
      ref: string;
      name?: string;
      joinMode?: AssistantDecisionJoinMode;
      handleFailure?: boolean;
      predicate?: AssistantJsonValue;
    }
  | {
      op: "connect";
      fromRef: string;
      toRef: string;
      condition?: AssistantJsonValue;
      /**
       * Required when the edge leaves a decision, meaningless otherwise: the
       * branch is what makes the edge mean anything.
       */
      branch?: AssistantDecisionBranch;
    }
  | {
      op: "set_binding";
      stepRef: string;
      inputKey: string;
      expression: string;
    }
  | {
      op: "configure_step";
      stepRef: string;
      config: AssistantJsonObject;
    }
  | {
      op: "rename_step";
      stepRef: string;
      name: string;
    }
  | {
      op: "update_step";
      stepRef: string;
      actionPackageName?: string;
      actionVersionRange?: string;
      enabled?: boolean;
      config?: AssistantJsonObject;
      inputBindings?: AssistantJsonObject;
    }
  | { op: "remove_step"; stepRef: string }
  | { op: "disconnect"; fromRef: string; toRef: string }
  | { op: "remove_edge"; edgeRef: string }
  | {
      op: "update_edge";
      edgeRef: string;
      condition: AssistantJsonValue;
    }
  | {
      op: "update_trigger";
      triggerRef: string;
      triggerType?: AssistantWorkflowTriggerType;
      name?: string;
      enabled?: boolean;
      config?: AssistantJsonObject;
    }
  | { op: "remove_trigger"; triggerRef: string }
  | {
      op: "set_step_runtime";
      stepRef: string;
      executionTarget?: ActionExecutionTarget;
      timeoutSeconds?: number | null;
      required?: boolean;
    }
  | {
      op: "set_workflow_metadata";
      name?: string;
      description?: string;
      enabled?: boolean;
    };

export type AssistantWorkflowPatch = AssistantWorkflowPatchOperation[];

export type AssistantPatchErrorCode =
  | "duplicate_ref"
  | "forbidden_data"
  | "invalid_config"
  | "invalid_field"
  | "invalid_response"
  | "missing_required_field"
  | "unknown_action"
  | "unknown_ref"
  | "unsupported_operation";

export type AssistantPatchError = {
  code: AssistantPatchErrorCode;
  message: string;
  path?: string;
  operationIndex?: number;
  ref?: string;
};

export type AssistantWorkflowPlan = {
  message: string;
  plan: string[];
  patch: AssistantWorkflowPatch;
  needsInput: string[];
  risks: string[];
  assumptions: string[];
  patchErrors?: string[];
  patchErrorDetails?: AssistantPatchError[];
};

export type AssistantMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AssistantProviderSummary = {
  id: string;
  name: string;
  provider: string;
  protocol: "anthropic" | "openai-compatible";
  baseUrl: string;
  model: string;
  models?: {
    chat?: string;
    copilot?: string;
    fallback?: string;
  };
  apiKeyConfigured?: boolean;
  enabled: boolean;
  configured: boolean;
  scope: "user";
  status: "ready" | "disabled" | "missing_api_key" | "missing_model";
};

export type AssistantProviderOption = {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  protocol: "anthropic" | "openai-compatible";
  customBaseUrl?: boolean;
  managed?: boolean;
};

export type AssistantProviderSettings = {
  providerId: string;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  source: "user";
};

export type AssistantModelOption = {
  id: string;
  name: string;
  recommended?: boolean;
};

export type AssistantReasoningEffort = "low" | "medium" | "high";

export type CompactActionManifest = {
  href: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  configSchema: AssistantJsonValue;
  inputs: AssistantJsonValue;
  outputs: AssistantJsonValue;
  permissions: string[];
  catalog: AssistantJsonValue;
};

export type AssistantProviderPreferences = {
  providerId?: string;
  model?: string;
  temperature?: number;
  jsonMode?: boolean;
};

export type CompactWorkflowTemplate = {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  href?: string;
};

export type CompactWorkflowTrigger = {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  config: AssistantJsonObject;
  state: AssistantJsonObject;
  canvasX?: number;
  canvasY?: number;
};

export type CompactWorkflowStep = {
  id: string;
  kind?: "action" | "workflow";
  calledWorkflowId?: string;
  executionTarget?: ActionExecutionTarget;
  actionPackageName: string;
  actionVersionRange?: string;
  position?: number;
  enabled: boolean;
  config: AssistantJsonObject;
  inputBindings: AssistantJsonObject;

  canvasX?: number;
  canvasY?: number;
  timeoutSeconds?: number;
  required?: boolean;
};

export type CompactWorkflowEdge = {
  id: string;
  fromStepId: string;
  toStepId: string;
  condition: AssistantJsonValue;
};

export type CompactWorkflowTriggerEdge = {
  id: string;
  triggerId: string;
  toStepId: string;
  condition: AssistantJsonValue;
};

export type CompactWorkflow = {
  template?: CompactWorkflowTemplate;
  triggers: CompactWorkflowTrigger[];
  triggerEdges: CompactWorkflowTriggerEdge[];
  steps: CompactWorkflowStep[];
  edges: CompactWorkflowEdge[];
};

export type CompactCredentialMetadata = {
  id: string;
  name: string;
  kind: string;
  provider?: string;
  providerDisplayName?: string;
  credentialType?: string;
  credentialTypeId?: string;
  organizationId?: string;
  projectId?: string;
  payloadPreview?: string;
};

export type CompactRunSummary = {
  id: string;
  href?: string;
  workflowTemplateId?: string;
  workflowName?: string;
  status: string;
  trigger?: string;
  triggerId?: string;
  triggerType?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  error?: string;
};

export type AssistantContextLimits = {
  actions: number;
  credentials: number;
  messages: number;
  runs: number;
  validationErrors: number;
};

export type AssistantContext = {
  organizationId?: string;
  projectId?: string;
  userId?: string;
  workflowId?: string;
  route?: string;
  selectedNodeId?: string;
  prompt?: string;
  providerPreferences?: AssistantProviderPreferences;
  messages: AssistantMessage[];
  actions: CompactActionManifest[];
  workflow: CompactWorkflow | null;
  validationErrors: string[];
  credentials: CompactCredentialMetadata[];
  runs: CompactRunSummary[];
};

export type AssistantConversationRetentionPolicy = {
  scope: "local" | "server";
  maxMessages: number;
  maxAgeDays?: number;
  storeModelInputs: boolean;
};

export const ASSISTANT_FORBIDDEN_CONTEXT_KEYS = [
  "apiKey",
  "authorization",
  "bearer",
  "cookie",
  "env",
  "password",
  "privateKey",
  "secret",
  "session",
  "token",
] as const;

export const ASSISTANT_DEFAULT_CONTEXT_LIMITS: AssistantContextLimits = {
  actions: 80,
  credentials: 40,
  messages: 24,
  runs: 20,
  validationErrors: 40,
};

export const ASSISTANT_CONVERSATION_RETENTION_POLICY = {
  scope: "local",
  maxMessages: 40,
  storeModelInputs: false,
} as const satisfies AssistantConversationRetentionPolicy;

const SENSITIVE_KEY_PATTERN =
  /(?:secret|token|api[_-]?key|apikey|private[_-]?key|password|authorization|bearer|session|cookie|env(?:ironment)?[_-]?(?:var|vars)?)/i;
const SECRET_LIKE_VALUE_PATTERN =
  /(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,})/i;

export function redactAssistantPayload(value: unknown): AssistantJsonValue {
  return redactValue(value, 0);
}

export function compactActionManifest(input: {
  name: string;
  version: string;
  manifest: Record<string, unknown>;
}): CompactActionManifest {
  const manifest = input.manifest;
  return {
    href: assistantEntityHref("registry_action", input.name) ?? "/registry",
    name: input.name,
    version: input.version,
    displayName: stringValue(manifest.displayName) || input.name,
    description: stringValue(manifest.description),
    configSchema: redactAssistantPayload(manifest.configSchema ?? null),
    inputs: redactAssistantPayload(manifest.inputs ?? {}),
    outputs: redactAssistantPayload(manifest.outputs ?? {}),
    permissions: Array.isArray(manifest.permissions)
      ? manifest.permissions.map(String)
      : [],
    catalog: redactAssistantPayload(manifest.catalog ?? {}),
  };
}

export function createAssistantPatchError(
  message: string,
  input: Partial<Omit<AssistantPatchError, "message">> = {},
): AssistantPatchError {
  return stripUndefined({
    code: input.code ?? patchErrorCode(message),
    message,
    path: input.path,
    operationIndex: input.operationIndex,
    ref: input.ref,
  });
}

export function compactWorkflowPayload(value: unknown): CompactWorkflow | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    ...(compactWorkflowTemplate(value.template) ?? {}),
    triggers: compactArray(value.triggers, compactWorkflowTrigger),
    triggerEdges: compactArray(value.triggerEdges, compactWorkflowTriggerEdge),
    steps: compactArray(value.steps, compactWorkflowStep),
    edges: compactArray(value.edges, compactWorkflowEdge),
  };
}

export function compactCredentialMetadata(
  value: unknown,
): CompactCredentialMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = stringValue(value.id);
  if (!id) {
    return null;
  }

  return stripUndefined({
    id,
    name: stringValue(value.name) || id,
    kind:
      stringValue(value.kind) || stringValue(value.credentialType) || "unknown",
    provider: optionalString(value.provider),
    providerDisplayName: optionalString(value.providerDisplayName),
    credentialType: optionalString(value.credentialType),
    credentialTypeId: optionalString(value.credentialTypeId),
    organizationId: optionalString(value.organizationId),
    projectId: optionalString(value.projectId),
    payloadPreview: optionalString(
      redactAssistantPayload(value.payloadPreview),
    ),
  });
}

export function compactCredentialMetadataList(
  value: unknown,
  limit = ASSISTANT_DEFAULT_CONTEXT_LIMITS.credentials,
): CompactCredentialMetadata[] {
  return compactArray(value, compactCredentialMetadata, limit);
}

export function compactRunSummary(value: unknown): CompactRunSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = stringValue(value.id);
  const status = stringValue(value.status);
  if (!id || !status) {
    return null;
  }

  return stripUndefined({
    id,
    href: optionalString(value.href),
    workflowTemplateId: optionalString(value.workflowTemplateId),
    workflowName: optionalString(value.workflowName),
    status,
    trigger: optionalString(value.trigger),
    triggerId: optionalString(value.triggerId),
    triggerType: optionalString(value.triggerType),
    startedAt: optionalString(value.startedAt),
    completedAt: optionalString(value.completedAt),
    createdAt: optionalString(value.createdAt),
    error: optionalString(redactAssistantPayload(value.error)),
  });
}

export function compactRunSummaries(
  value: unknown,
  limit = ASSISTANT_DEFAULT_CONTEXT_LIMITS.runs,
): CompactRunSummary[] {
  return compactArray(value, compactRunSummary, limit);
}

export function compactValidationErrors(
  value: unknown,
  limit = ASSISTANT_DEFAULT_CONTEXT_LIMITS.validationErrors,
) {
  return stringList(Array.isArray(value) ? value.slice(0, limit) : value);
}

export function createAssistantContext(input: {
  actions?: Array<{
    name: string;
    version: string;
    manifest: Record<string, unknown>;
  }>;
  credentials?: unknown;
  limits?: Partial<AssistantContextLimits>;
  messages?: AssistantMessage[];
  organizationId?: string | null;
  projectId?: string | null;
  prompt?: string | null;
  providerPreferences?: AssistantProviderPreferences;
  route?: string | null;
  runs?: unknown;
  selectedNodeId?: string | null;
  userId?: string | null;
  validationErrors?: unknown;
  workflow?: unknown;
  workflowId?: string | null;
}): AssistantContext {
  const limits = { ...ASSISTANT_DEFAULT_CONTEXT_LIMITS, ...input.limits };
  return stripUndefined({
    organizationId: optionalString(input.organizationId),
    projectId: optionalString(input.projectId),
    userId: optionalString(input.userId),
    workflowId: optionalString(input.workflowId),
    route: optionalString(input.route),
    selectedNodeId: optionalString(input.selectedNodeId),
    prompt: optionalString(input.prompt),
    providerPreferences: input.providerPreferences,
    messages: compactAssistantMessages(input.messages, limits.messages),
    actions: (input.actions ?? [])
      .slice(0, limits.actions)
      .map(compactActionManifest),
    workflow: compactWorkflowPayload(input.workflow),
    validationErrors: compactValidationErrors(
      input.validationErrors,
      limits.validationErrors,
    ),
    credentials: compactCredentialMetadataList(
      input.credentials,
      limits.credentials,
    ),
    runs: compactRunSummaries(input.runs, limits.runs),
  });
}

export function normalizeAssistantWorkflowPlan(value: unknown): {
  plan: AssistantWorkflowPlan | null;
  errors: string[];
  errorDetails: AssistantPatchError[];
} {
  if (!isRecord(value)) {
    return {
      plan: null,
      errors: ["Assistant response must be an object."],
      errorDetails: [
        {
          code: "invalid_response",
          message: "Assistant response must be an object.",
        },
      ],
    };
  }

  const errors: string[] = [];
  const errorDetails: AssistantPatchError[] = [];
  const patchInput = Array.isArray(value.patch) ? value.patch : [];
  const patch: AssistantWorkflowPatchOperation[] = [];

  for (const [index, operation] of patchInput.entries()) {
    const normalized = normalizePatchOperation(operation);
    if (normalized.operation) {
      patch.push(normalized.operation);
    }
    errors.push(
      ...normalized.errors.map((error) => `patch[${index}]: ${error}`),
    );
    errorDetails.push(
      ...normalized.errors.map((error) => ({
        ...createAssistantPatchError(`patch[${index}]: ${error}`),
        operationIndex: index,
        path: `patch[${index}]`,
      })),
    );
  }

  return {
    plan: {
      message: stringValue(value.message),
      plan: stringList(value.plan),
      patch,
      needsInput: stringList(value.needsInput),
      risks: stringList(value.risks),
      assumptions: stringList(value.assumptions),
      patchErrors: stringList(value.patchErrors),
      patchErrorDetails: compactPatchErrors(value.patchErrorDetails),
    },
    errors,
    errorDetails,
  };
}

function compactWorkflowTemplate(
  value: unknown,
): { template: CompactWorkflowTemplate } | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  if (!id && !name) {
    return null;
  }
  return {
    template: stripUndefined({
      id,
      name: name || id,
      description: optionalString(value.description),
      enabled: optionalBoolean(value.enabled),
    }),
  };
}

function compactWorkflowTrigger(value: unknown): CompactWorkflowTrigger | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = stringValue(value.id);
  const type = stringValue(value.type);
  if (!id || !type) {
    return null;
  }
  return stripUndefined({
    id,
    type,
    name: stringValue(value.name) || type,
    enabled: booleanValue(value.enabled, true),
    config: jsonObjectOrEmpty(value.config),
    state: jsonObjectOrEmpty(value.state),
    canvasX: optionalNumber(value.canvasX),
    canvasY: optionalNumber(value.canvasY),
  });
}

function compactWorkflowStep(value: unknown): CompactWorkflowStep | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = stringValue(value.id);
  const actionPackageName = stringValue(value.actionPackageName);
  if (!id || (!actionPackageName && value.kind !== "workflow")) {
    return null;
  }
  return stripUndefined({
    id,
    kind:
      value.kind === "workflow" ? ("workflow" as const) : ("action" as const),
    calledWorkflowId: optionalString(value.calledWorkflowId),
    actionPackageName,
    actionVersionRange: optionalString(value.actionVersionRange),
    position: optionalNumber(value.position),
    enabled: booleanValue(value.enabled, true),
    config: jsonObjectOrEmpty(value.config),
    inputBindings: jsonObjectOrEmpty(value.inputBindings),
    executionTarget: actionExecutionTargetSchema.safeParse(
      value.executionTarget,
    ).data,
    canvasX: optionalNumber(value.canvasX),
    canvasY: optionalNumber(value.canvasY),
    timeoutSeconds: optionalNumber(value.timeoutSeconds),
    required: optionalBoolean(value.required),
  });
}

function compactWorkflowEdge(value: unknown): CompactWorkflowEdge | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = stringValue(value.id);
  const fromStepId = stringValue(value.fromStepId);
  const toStepId = stringValue(value.toStepId);
  if (!id || !fromStepId || !toStepId) {
    return null;
  }
  return {
    id,
    fromStepId,
    toStepId,
    condition: redactAssistantPayload(value.condition ?? null),
  };
}

function compactWorkflowTriggerEdge(
  value: unknown,
): CompactWorkflowTriggerEdge | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = stringValue(value.id);
  const triggerId = stringValue(value.triggerId);
  const toStepId = stringValue(value.toStepId);
  if (!id || !triggerId || !toStepId) {
    return null;
  }
  return {
    id,
    triggerId,
    toStepId,
    condition: redactAssistantPayload(value.condition ?? null),
  };
}

function compactPatchErrors(value: unknown): AssistantPatchError[] | undefined {
  const errors = compactArray(value, compactPatchError);
  return errors.length ? errors : undefined;
}

function compactPatchError(value: unknown): AssistantPatchError | null {
  if (!isRecord(value)) {
    return null;
  }
  const message = stringValue(value.message);
  if (!message) {
    return null;
  }
  return stripUndefined({
    code: patchErrorCode(stringValue(value.code)),
    message,
    path: optionalString(value.path),
    operationIndex: optionalNumber(value.operationIndex),
    ref: optionalString(value.ref),
  });
}

function normalizePatchOperation(value: unknown): {
  operation: AssistantWorkflowPatchOperation | null;
  errors: string[];
} {
  if (!isRecord(value)) {
    return { operation: null, errors: ["operation must be an object."] };
  }

  const op = stringValue(value.op);
  switch (op) {
    case "add_trigger": {
      const ref = stringValue(value.ref);
      const triggerType = stringValue(value.triggerType);
      const supportedTriggerTypes: AssistantWorkflowTriggerType[] = [
        "manual",
        "schedule",
        "webhook",
        "date",
        "completion",
      ];
      const errors = [
        ...requiredStringError("ref", ref),
        ...(supportedTriggerTypes.includes(
          triggerType as AssistantWorkflowTriggerType,
        )
          ? []
          : [
              "triggerType must be manual, schedule, webhook, date or completion.",
            ]),
      ];
      return {
        operation: errors.length
          ? null
          : {
              op,
              ref,
              triggerType: triggerType as AssistantWorkflowTriggerType,
              ...(stringValue(value.name)
                ? { name: stringValue(value.name) }
                : {}),
              ...(isRecord(value.config)
                ? { config: jsonObject(value.config) }
                : {}),
            },
        errors,
      };
    }
    case "add_step": {
      const ref = stringValue(value.ref);
      const actionPackageName = stringValue(value.actionPackageName);
      const config = isRecord(value.config) ? jsonObject(value.config) : {};
      const errors = [
        ...requiredStringError("ref", ref),
        ...requiredStringError("actionPackageName", actionPackageName),
      ];
      return {
        operation: errors.length
          ? null
          : { op, ref, actionPackageName, config },
        errors,
      };
    }
    case "add_decision": {
      const ref = stringValue(value.ref);
      const joinMode = stringValue(value.joinMode) || "all";
      const errors = [
        ...requiredStringError("ref", ref),
        ...(joinMode === "all" || joinMode === "any_settled"
          ? []
          : ["joinMode must be all or any_settled."]),
      ];
      return {
        operation: errors.length
          ? null
          : {
              op,
              ref,
              joinMode: joinMode as AssistantDecisionJoinMode,
              ...(stringValue(value.name)
                ? { name: stringValue(value.name) }
                : {}),
              ...(typeof value.handleFailure === "boolean"
                ? { handleFailure: value.handleFailure }
                : {}),
              ...(value.predicate === undefined
                ? {}
                : { predicate: redactAssistantPayload(value.predicate) }),
            },
        errors,
      };
    }
    case "connect": {
      const fromRef = stringValue(value.fromRef);
      const toRef = stringValue(value.toRef);
      const branch = stringValue(value.branch);
      const errors = [
        ...requiredStringError("fromRef", fromRef),
        ...requiredStringError("toRef", toRef),
        ...(branch && branch !== "true" && branch !== "false"
          ? ["branch must be true or false."]
          : []),
      ];
      return {
        operation: errors.length
          ? null
          : {
              op,
              fromRef,
              toRef,
              ...(value.condition !== undefined
                ? { condition: redactAssistantPayload(value.condition) }
                : {}),
              ...(branch ? { branch: branch as AssistantDecisionBranch } : {}),
            },
        errors,
      };
    }
    case "set_binding": {
      const stepRef = stringValue(value.stepRef);
      const inputKey = stringValue(value.inputKey);
      const expression = stringValue(value.expression);
      const errors = [
        ...requiredStringError("stepRef", stepRef),
        ...requiredStringError("inputKey", inputKey),
        ...requiredStringError("expression", expression),
      ];
      return {
        operation: errors.length ? null : { op, stepRef, inputKey, expression },
        errors,
      };
    }
    case "configure_step": {
      const stepRef = stringValue(value.stepRef);
      const config = isRecord(value.config) ? jsonObject(value.config) : null;
      const errors = [
        ...requiredStringError("stepRef", stepRef),
        ...(config ? [] : ["config must be an object."]),
      ];
      return {
        operation: errors.length ? null : { op, stepRef, config: config ?? {} },
        errors,
      };
    }
    case "rename_step": {
      const stepRef = stringValue(value.stepRef);
      const name = stringValue(value.name);
      const errors = [
        ...requiredStringError("stepRef", stepRef),
        ...requiredStringError("name", name),
      ];
      return {
        operation: errors.length ? null : { op, stepRef, name },
        errors,
      };
    }
    case "update_step": {
      const stepRef = stringValue(value.stepRef);
      const errors = requiredStringError("stepRef", stepRef);
      return {
        operation: errors.length
          ? null
          : stripUndefined({
              op,
              stepRef,
              actionPackageName: optionalString(value.actionPackageName),
              actionVersionRange: optionalString(value.actionVersionRange),
              enabled: optionalBoolean(value.enabled),
              config: isRecord(value.config)
                ? jsonObject(value.config)
                : undefined,
              inputBindings: isRecord(value.inputBindings)
                ? jsonObject(value.inputBindings)
                : undefined,
            }),
        errors,
      };
    }
    case "remove_step": {
      const stepRef = stringValue(value.stepRef);
      const errors = requiredStringError("stepRef", stepRef);
      return {
        operation: errors.length ? null : { op, stepRef },
        errors,
      };
    }
    case "disconnect": {
      const fromRef = stringValue(value.fromRef);
      const toRef = stringValue(value.toRef);
      const errors = [
        ...requiredStringError("fromRef", fromRef),
        ...requiredStringError("toRef", toRef),
      ];
      return {
        operation: errors.length ? null : { op, fromRef, toRef },
        errors,
      };
    }
    case "remove_edge": {
      const edgeRef = stringValue(value.edgeRef);
      const errors = requiredStringError("edgeRef", edgeRef);
      return {
        operation: errors.length ? null : { op, edgeRef },
        errors,
      };
    }
    case "update_edge": {
      const edgeRef = stringValue(value.edgeRef);
      const errors = requiredStringError("edgeRef", edgeRef);
      return {
        operation: errors.length
          ? null
          : {
              op,
              edgeRef,
              condition: redactAssistantPayload(value.condition ?? null),
            },
        errors,
      };
    }
    case "update_trigger": {
      const triggerRef = stringValue(value.triggerRef);
      const triggerType = optionalString(value.triggerType);
      const supported = ["manual", "schedule", "webhook", "date", "completion"];
      const errors = [
        ...requiredStringError("triggerRef", triggerRef),
        ...(triggerType && !supported.includes(triggerType)
          ? ["triggerType is invalid."]
          : []),
      ];
      return {
        operation: errors.length
          ? null
          : stripUndefined({
              op,
              triggerRef,
              triggerType: triggerType as
                | AssistantWorkflowTriggerType
                | undefined,
              name: optionalString(value.name),
              enabled: optionalBoolean(value.enabled),
              config: isRecord(value.config)
                ? jsonObject(value.config)
                : undefined,
            }),
        errors,
      };
    }
    case "remove_trigger": {
      const triggerRef = stringValue(value.triggerRef);
      const errors = requiredStringError("triggerRef", triggerRef);
      return {
        operation: errors.length ? null : { op, triggerRef },
        errors,
      };
    }
    case "set_step_runtime": {
      const stepRef = stringValue(value.stepRef);
      const errors = requiredStringError("stepRef", stepRef);
      const target =
        value.executionTarget === undefined
          ? undefined
          : actionExecutionTargetSchema.safeParse(value.executionTarget);
      if (target && !target.success)
        errors.push(
          "Invalid executionTarget: " +
            target.error.issues.map((issue) => issue.message).join("; "),
        );
      if ("placement" in value || "executionLocationId" in value)
        errors.push(
          "Use executionTarget to declare where the action computes.",
        );
      return {
        operation: errors.length
          ? null
          : stripUndefined({
              op,
              stepRef,
              executionTarget: target?.success ? target.data : undefined,
              timeoutSeconds:
                value.timeoutSeconds === null
                  ? null
                  : optionalNumber(value.timeoutSeconds),
              required: optionalBoolean(value.required),
            }),
        errors,
      };
    }
    case "set_workflow_metadata":
      return {
        operation: stripUndefined({
          op,
          name: optionalString(value.name),
          description: optionalString(value.description),
          enabled: optionalBoolean(value.enabled),
        }),
        errors: [],
      };
    default:
      return {
        operation: null,
        errors: [`Unsupported operation ${op || "(missing)"}.`],
      };
  }
}

function patchErrorCode(error: string): AssistantPatchErrorCode {
  const normalized = error.toLowerCase();
  if (normalized.includes("duplicate")) {
    return "duplicate_ref";
  }
  if (normalized.includes("unsupported")) {
    return "unsupported_operation";
  }
  if (normalized.includes("required")) {
    return "missing_required_field";
  }
  if (normalized.includes("unknown action")) {
    return "unknown_action";
  }
  if (normalized.includes("unknown") || normalized.includes("missing ref")) {
    return "unknown_ref";
  }
  if (
    normalized.includes("config") ||
    normalized.includes("schema") ||
    normalized.includes("allowed")
  ) {
    return "invalid_config";
  }
  if (
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("private key") ||
    normalized.includes("api key")
  ) {
    return "forbidden_data";
  }
  if (normalized.includes("response")) {
    return "invalid_response";
  }
  return "invalid_field";
}

function redactValue(value: unknown, depth: number): AssistantJsonValue {
  if (depth > 12) {
    return "[redacted:max-depth]";
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return SECRET_LIKE_VALUE_PATTERN.test(value) ? "[redacted]" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  }
  if (!isRecord(value)) {
    return String(value);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key)
          ? "[redacted]"
          : redactValue(item, depth + 1),
      ]),
  );
}

function compactAssistantMessages(
  value: unknown,
  limit: number,
): AssistantMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(-limit)
    .map((message): AssistantMessage | null => {
      if (!isRecord(message)) {
        return null;
      }
      const role = stringValue(message.role);
      const content = stringValue(redactAssistantPayload(message.content));
      if ((role !== "user" && role !== "assistant") || !content) {
        return null;
      }
      return { role, content };
    })
    .filter((message): message is AssistantMessage => Boolean(message));
}

function compactArray<T>(
  value: unknown,
  compact: (item: unknown) => T | null,
  limit = 100,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, limit)
    .map(compact)
    .filter((item): item is T => item !== null);
}

function jsonObject(value: Record<string, unknown>): AssistantJsonObject {
  const redacted = redactAssistantPayload(value);
  return isRecord(redacted) ? redacted : {};
}

function jsonObjectOrEmpty(value: unknown): AssistantJsonObject {
  return isRecord(value) ? jsonObject(value) : {};
}

function stringList(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const text = stringValue(value);
  return text ? [text] : [];
}

function requiredStringError(name: string, value: string) {
  return value ? [] : [`${name} is required.`];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown) {
  const text = stringValue(value);
  return text || undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
