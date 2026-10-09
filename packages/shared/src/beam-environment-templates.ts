import { z } from "zod";
import { devBeamEnvironmentTemplate } from "./beam-environment-templates.dev.js";

export type BeamEnvironment = "dev" | "prod";

export type BeamEnvironmentTemplate = {
  key: string;
  name: string;
  baseUrl: string;
  coordinatorUrl: string;
  natsUrl: string;
  authUrl: string;
  apiUrl: string;
  registryUrl: string;
  builtIn: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export const defaultBeamEnvironmentTemplateKey = "prod";

export const beamEnvironmentTemplateKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, {
    message:
      "Template keys must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.",
  });

export const beamEnvironmentTemplateInputSchema = z
  .object({
    key: beamEnvironmentTemplateKeySchema,
    name: z.string().trim().min(1).max(120),
    baseUrl: z.string().trim().url(),
    coordinatorUrl: z.string().trim().url(),
    natsUrl: z
      .string()
      .trim()
      .min(1)
      .refine((value) => isSupportedNatsUrl(value), {
        message: "NATS URL must use nats:// or tls://.",
      }),
    authUrl: z.string().trim().url(),
    apiUrl: z.string().trim().url(),
    registryUrl: z.string().trim().url(),
  })
  .strict();

export const builtinBeamEnvironmentTemplates = {
  prod: {
    key: "prod",
    name: "Beam Production",
    baseUrl: "https://beamcore.b1m.ai",
    coordinatorUrl: "https://coordinator.b1m.ai",
    natsUrl: "tls://orch-gateway.b1m.ai:4222",
    authUrl: "https://auth.b1m.ai",
    apiUrl: "https://api.b1m.ai",
    registryUrl: "https://api.b1m.ai/registry",
    builtIn: true,
  },
  dev: devBeamEnvironmentTemplate,
} as const satisfies Record<BeamEnvironment, BeamEnvironmentTemplate>;

export function defaultBeamEnvironmentTemplate() {
  return builtinBeamEnvironmentTemplates.prod;
}

export function builtinBeamEnvironmentTemplate(environment: BeamEnvironment) {
  return builtinBeamEnvironmentTemplates[environment];
}

export function roomCoordinatorUrl(environment: BeamEnvironment) {
  return builtinBeamEnvironmentTemplates[environment].coordinatorUrl;
}

export function normalizeBeamEnvironmentTemplate(
  input: unknown,
): BeamEnvironmentTemplate {
  const parsed = beamEnvironmentTemplateInputSchema.parse(input);
  return { ...parsed, builtIn: false };
}

export function templateKeyFromValue(value: unknown) {
  const parsed = beamEnvironmentTemplateKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isSupportedNatsUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "nats:" || parsed.protocol === "tls:";
  } catch {
    return false;
  }
}
