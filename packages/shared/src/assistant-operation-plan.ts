import { z } from "zod";

export const ASSISTANT_OPERATION_RISKS = [
  "read",
  "draft",
  "write",
  "execute",
  "security",
  "destructive",
] as const;

export const ASSISTANT_PLAN_STATUSES = [
  "draft",
  "needs_input",
  "ready",
  "confirmed",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const ASSISTANT_OPERATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
] as const;

export type AssistantOperationRisk =
  (typeof ASSISTANT_OPERATION_RISKS)[number];
export type AssistantOperationPlanStatus =
  (typeof ASSISTANT_PLAN_STATUSES)[number];
export type AssistantOperationStatus =
  (typeof ASSISTANT_OPERATION_STATUSES)[number];

export type AssistantInputRequest = {
  id: string;
  label: string;
  description?: string;
  type:
    | "text"
    | "number"
    | "boolean"
    | "select"
    | "credential_reference"
    | "secure_secret";
  required: boolean;
  sensitive: boolean;
  operationId?: string;
  argumentPath?: string;
  options?: Array<{ label: string; value: string }>;
  value?: string | number | boolean;
};

export type AssistantOperation = {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  dependsOn: string[];
  risk: AssistantOperationRisk;
  reversible: boolean;
  status: AssistantOperationStatus;
  result?: Record<string, unknown>;
  error?: string;
};

export type AssistantPlanDiff = {
  resourceType: string;
  resourceId?: string;
  label: string;
  change: "create" | "update" | "delete" | "execute";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type AssistantPlanPreview = {
  generatedAt: string;
  validationHash: string;
  diffs: AssistantPlanDiff[];
  warnings: string[];
};

export type AssistantPlanConfirmation = {
  policy: "none" | "simple" | "inputs_and_effects" | "reinforced" | "explicit";
  required: boolean;
  confirmedAt?: string;
  confirmedBy?: string;
  validationHash?: string;
};

export type AssistantOperationPlan = {
  id: string;
  version: 1;
  organizationId: string;
  projectId: string | null;
  userId: string | null;
  conversationId?: string | null;
  intent: string;
  summary: string;
  operations: AssistantOperation[];
  needsInput: AssistantInputRequest[];
  assumptions: string[];
  risks: string[];
  estimatedImpact?: {
    credits?: number;
    duration?: string;
    externalEffects?: string[];
  };
  status: AssistantOperationPlanStatus;
  preview?: AssistantPlanPreview;
  confirmation: AssistantPlanConfirmation;
  createdAt: string;
  updatedAt: string;
};

export type AssistantToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  risk: AssistantOperationRisk;
  permissions: string[];
  confirmationPolicy: AssistantPlanConfirmation["policy"];
  reversible: boolean;
  rollbackStrategy?: string;
};

const jsonRecordSchema = z.record(z.unknown());

export const assistantOperationSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  arguments: jsonRecordSchema,
  dependsOn: z.array(z.string().min(1)),
  risk: z.enum(ASSISTANT_OPERATION_RISKS),
  reversible: z.boolean(),
  status: z.enum(ASSISTANT_OPERATION_STATUSES),
  result: jsonRecordSchema.optional(),
  error: z.string().optional(),
});

export const assistantInputRequestSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  type: z.enum([
    "text",
    "number",
    "boolean",
    "select",
    "credential_reference",
    "secure_secret",
  ]),
  required: z.boolean(),
  sensitive: z.boolean(),
  operationId: z.string().optional(),
  argumentPath: z.string().optional(),
  options: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const assistantOperationPlanSchema = z.object({
  id: z.string().min(1),
  version: z.literal(1),
  organizationId: z.string().min(1),
  projectId: z.string().nullable(),
  userId: z.string().nullable(),
  conversationId: z.string().nullable().optional(),
  intent: z.string().min(1),
  summary: z.string().min(1),
  operations: z.array(assistantOperationSchema),
  needsInput: z.array(assistantInputRequestSchema),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  estimatedImpact: z
    .object({
      credits: z.number().nonnegative().optional(),
      duration: z.string().optional(),
      externalEffects: z.array(z.string()).optional(),
    })
    .optional(),
  status: z.enum(ASSISTANT_PLAN_STATUSES),
  preview: z
    .object({
      generatedAt: z.string(),
      validationHash: z.string().min(1),
      diffs: z.array(
        z.object({
          resourceType: z.string(),
          resourceId: z.preprocess(
            (value) => (value === null ? undefined : value),
            z.string().optional(),
          ),
          label: z.string(),
          change: z.enum(["create", "update", "delete", "execute"]),
          before: jsonRecordSchema.nullable(),
          after: jsonRecordSchema.nullable(),
        }),
      ),
      warnings: z.array(z.string()),
    })
    .optional(),
  confirmation: z.object({
    policy: z.enum([
      "none",
      "simple",
      "inputs_and_effects",
      "reinforced",
      "explicit",
    ]),
    required: z.boolean(),
    confirmedAt: z.string().optional(),
    confirmedBy: z.string().optional(),
    validationHash: z.string().optional(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function parseAssistantOperationPlan(
  value: unknown,
): AssistantOperationPlan {
  return assistantOperationPlanSchema.parse(value) as AssistantOperationPlan;
}
