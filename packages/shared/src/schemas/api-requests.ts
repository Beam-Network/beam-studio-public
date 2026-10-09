import { z } from "zod";

const requiredTextSchema = z.string().trim().min(1);
const optionalTextSchema = z
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

function requiredAliasIssue(
  ctx: z.RefinementCtx,
  path: string,
  message: string,
) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message,
  });
}

export const createStudioTransferRequestSchema = z
  .object({
    name: requiredTextSchema,
    description: optionalTextSchema,
    apiKeyId: z.string().trim().optional(),
    api_key_id: z.string().trim().optional(),
    customApiKey: optionalTextSchema,
    custom_api_key: optionalTextSchema,
    beamServerUrl: optionalTextSchema,
    beam_server_url: optionalTextSchema,
    fileSuffixMode: z.enum(["none", "timestamp", "nonce", "random_number"]).optional(),
    file_suffix_mode: z.enum(["none", "timestamp", "nonce", "random_number"]).optional(),
    notificationWebhookUrl: optionalTextSchema,
    notification_webhook_url: optionalTextSchema,
    slackWebhookUrl: optionalTextSchema,
    slack_webhook_url: optionalTextSchema,
    notifyOnStart: z.boolean().optional(),
    notify_on_start: z.boolean().optional(),
    notifyOnSuccess: z.boolean().optional(),
    notify_on_success: z.boolean().optional(),
    notifyOnFailure: z.boolean().optional(),
    notify_on_failure: z.boolean().optional(),
    notifyOnCancel: z.boolean().optional(),
    notify_on_cancel: z.boolean().optional(),
    enabled: z.boolean().optional(),
    frequency: optionalTextSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    const apiKeyId = body.apiKeyId ?? body.api_key_id ?? "";
    const customApiKey = body.customApiKey ?? body.custom_api_key ?? "";
    if (!apiKeyId && !customApiKey) {
      requiredAliasIssue(ctx, "apiKeyId", "API key is required.");
    }
  })
  .transform((body) => ({
    name: body.name,
    description: body.description,
    apiKeyId: body.apiKeyId ?? body.api_key_id ?? "",
    customApiKey: body.customApiKey ?? body.custom_api_key,
    beamServerUrl: body.beamServerUrl ?? body.beam_server_url,
    fileSuffixMode: body.fileSuffixMode ?? body.file_suffix_mode ?? "none",
    notificationWebhookUrl:
      body.notificationWebhookUrl ?? body.notification_webhook_url,
    slackWebhookUrl: body.slackWebhookUrl ?? body.slack_webhook_url,
    notifyOnStart: body.notifyOnStart ?? body.notify_on_start ?? false,
    notifyOnSuccess: body.notifyOnSuccess ?? body.notify_on_success ?? true,
    notifyOnFailure: body.notifyOnFailure ?? body.notify_on_failure ?? true,
    notifyOnCancel: body.notifyOnCancel ?? body.notify_on_cancel ?? true,
    enabled: body.enabled ?? false,
    frequency: body.frequency,
  }));

export const createApiKeyRequestSchema = z
  .object({
    name: requiredTextSchema,
    baseUrl: z.string().trim().optional(),
    base_url: z.string().trim().optional(),
    apiKey: z.string().trim().optional(),
    api_key: z.string().trim().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!(body.baseUrl ?? body.base_url ?? "")) {
      requiredAliasIssue(ctx, "baseUrl", "Base URL is required.");
    }
    if (!(body.apiKey ?? body.api_key ?? "")) {
      requiredAliasIssue(ctx, "apiKey", "API key is required.");
    }
  })
  .transform((body) => ({
    name: body.name,
    baseUrl: body.baseUrl ?? body.base_url ?? "",
    apiKey: body.apiKey ?? body.api_key ?? "",
  }));

const credentialPayloadSchema = z
  .union([requiredTextSchema, z.record(z.unknown())])
  .optional()
  .default({})
  .transform((payload) =>
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );

export const createCredentialRequestSchema = z
  .object({
    name: requiredTextSchema,
    kind: requiredTextSchema,
    payload: credentialPayloadSchema,
  })
  .strict();

export const createScheduleRequestSchema = z
  .object({
    transferTemplateId: z.string().trim().optional(),
    transfer_template_id: z.string().trim().optional(),
    frequency: z.string().trim().optional().default("manual"),
    enabled: z.boolean().optional().default(false),
    nextRunAt: optionalTextSchema,
    next_run_at: optionalTextSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!(body.transferTemplateId ?? body.transfer_template_id ?? "")) {
      requiredAliasIssue(
        ctx,
        "transferTemplateId",
        "Transfer template is required.",
      );
    }
  })
  .transform((body) => ({
    transferTemplateId:
      body.transferTemplateId ?? body.transfer_template_id ?? "",
    frequency: body.frequency,
    enabled: body.enabled,
    nextRunAt: body.nextRunAt ?? body.next_run_at,
  }));

const endpointKindSchema = z.enum(["source", "destination"]);
const endpointSourceTypeSchema = z
  .enum(["file", "directory"])
  .optional()
  .default("file");
const destinationFilenamePolicySchema = z
  .enum(["overwrite", "run_id", "timestamp", "date_partition", "custom"])
  .optional()
  .default("overwrite");
const endpointProviderSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || "s3");
const endpointCredentialIdSchema = z
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((value) => (value && value !== "__none" ? value : null));

export const createEndpointRequestSchema = z
  .object({
    kind: endpointKindSchema.optional().default("source"),
    name: requiredTextSchema,
    provider: endpointProviderSchema,
    bucket: requiredTextSchema,
    objectKey: requiredTextSchema,
    sourceType: endpointSourceTypeSchema,
    filenamePolicy: destinationFilenamePolicySchema,
    filenameTemplate: optionalTextSchema,
    filenameTimezone: z
      .string()
      .trim()
      .optional()
      .transform((value) => value || "UTC"),
    credentialId: endpointCredentialIdSchema,
  })
  .strict();

export const updateEndpointRequestSchema = createEndpointRequestSchema.extend({
  id: requiredTextSchema,
});

export const deleteEndpointRequestSchema = z
  .object({
    kind: endpointKindSchema.optional().default("source"),
    id: requiredTextSchema,
  })
  .strict();

export const selectOrganizationRequestSchema = z
  .object({
    organizationId: requiredTextSchema,
  })
  .strict();

export type CreateStudioTransferRequest = z.infer<
  typeof createStudioTransferRequestSchema
>;
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;
export type CreateCredentialRequest = z.infer<
  typeof createCredentialRequestSchema
>;
export type CreateScheduleRequest = z.infer<typeof createScheduleRequestSchema>;
export type CreateEndpointRequest = z.infer<typeof createEndpointRequestSchema>;
export type UpdateEndpointRequest = z.infer<typeof updateEndpointRequestSchema>;
export type DeleteEndpointRequest = z.infer<typeof deleteEndpointRequestSchema>;
export type SelectOrganizationRequest = z.infer<
  typeof selectOrganizationRequestSchema
>;
