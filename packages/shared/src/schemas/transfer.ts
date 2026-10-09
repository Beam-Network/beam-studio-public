import { z } from "zod";
import {
  getProviderProfile,
  resolveProviderProfileEndpointUrl,
} from "../provider-profiles.js";

const providerBaseSchema = z.object({
  id: z.string().optional(),
  bucket: z.string().min(1),
  key: z.string().min(1),
});

export const s3ProviderConfigSchema = providerBaseSchema.extend({
  provider: z.literal("s3"),
  region: z.string().min(1).optional(),
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
  session_token: z.string().min(1).optional(),
  endpoint_url: z.string().min(1).optional(),
});

export const r2ProviderConfigSchema = providerBaseSchema.extend({
  provider: z.literal("r2"),
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
  account_id: z.string().min(1).optional(),
  endpoint_url: z.string().min(1).optional(),
});

export const s3CompatibleProviderConfigSchema = providerBaseSchema
  .extend({
    provider: z.string().min(1),
    driver: z.literal("s3-compatible").optional(),
    region: z.string().min(1).optional(),
    endpoint_url: z.string().min(1).optional(),
    access_key_id: z.string().min(1),
    secret_access_key: z.string().min(1),
    session_token: z.string().min(1).optional(),
    force_path_style: z.boolean().optional(),
    account_id: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
  })
  .superRefine((config, context) => {
    const provider = config.provider.trim().toLowerCase();
    const profile = getProviderProfile(provider);
    const endpoint = profile
      ? resolveProviderProfileEndpointUrl(profile, config)
      : config.endpoint_url;

    if (provider !== "s3" && provider !== "r2" && !endpoint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "S3-compatible providers require endpoint_url or enough profile fields to render an endpoint.",
        path: ["endpoint_url"],
      });
    }
  });

export const hippiusProviderConfigSchema = providerBaseSchema.extend({
  provider: z.literal("hippius"),
  api_token: z.string().min(1),
  base_url: z.string().min(1).optional(),
});

export const huggingFaceRepoTypes = [
  "model",
  "dataset",
  "space",
  "kernel",
  "bucket",
] as const;

/**
 * Hugging Face Hub config.
 *
 * Deliberately does not extend `providerBaseSchema`: the Hub addresses content by
 * `repo_id` + `path`, not `bucket` + `key`, and authenticates with a single token.
 */
export const huggingFaceProviderConfigSchema = z
  .object({
    id: z.string().optional(),
    provider: z.literal("huggingface"),
    repo_id: z.string().min(1),
    path: z.string().min(1),
    repo_type: z.enum(huggingFaceRepoTypes).optional(),
    revision: z.string().min(1).optional(),
    token: z.string().min(1),
    endpoint: z.string().min(1).optional(),
    commit_message: z.string().min(1).optional(),
    commit_description: z.string().min(1).optional(),
    create_pr: z.boolean().optional(),
    allow_source_rehash: z.boolean().optional(),
  })
  .superRefine((config, ctx) => {
    if (!config.repo_id.includes("/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Hugging Face repo_id must be `namespace/name`.",
        path: ["repo_id"],
      });
    }
  });

export const transferProviderConfigSchema = z.union([
  s3ProviderConfigSchema,
  r2ProviderConfigSchema,
  s3CompatibleProviderConfigSchema,
  hippiusProviderConfigSchema,
  huggingFaceProviderConfigSchema,
]);

export const createTransferSchema = z.object({
  name: z.string().min(1),
  apiKeyId: z.string().min(1),
  sources: z.array(transferProviderConfigSchema).min(1),
  destinations: z.array(transferProviderConfigSchema).min(1),
  expiresIn: z.number().int().positive().optional(),
  distribute: z.boolean().optional(),
  fileSuffixMode: z.string().optional(),
});

export type CreateTransferInput = z.infer<typeof createTransferSchema>;
export type TransferProviderConfig = z.infer<
  typeof transferProviderConfigSchema
>;
