import { builtinBeamEnvironmentTemplates } from "@beam-studio/shared";
import type { ActionJson } from "./actions.js";
import { WorkflowContractError } from "./contracts.js";

type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export type BeamConnectionDefaults = {
  baseUrl?: string;
  natsUrl?: string;
  environment?: string;
};
export type FrozenExecutionConfiguration = {
  environment: string;
  beam: {
    defaults: BeamConnectionDefaults;
    credentials: Record<string, BeamConnectionDefaults>;
    knownCredentialIds: string[];
  };
};

/** Only connection selectors, never credential payloads or URL authentication. */
export function beamConnectionDefaults(value: unknown): BeamConnectionDefaults {
  const metadata = object(value);
  const baseUrl = connectionUrl(metadata.baseUrl ?? metadata.base_url);
  const natsUrl = connectionUrl(metadata.natsUrl ?? metadata.nats_url);
  const environment =
    text(metadata.environment) ??
    Object.values(builtinBeamEnvironmentTemplates).find(
      (template) =>
        (baseUrl &&
          [
            template.baseUrl,
            template.apiUrl,
            template.authUrl,
            template.coordinatorUrl,
          ].some((url) => connectionUrl(url) === baseUrl)) ||
        (!baseUrl && natsUrl && connectionUrl(template.natsUrl) === natsUrl),
    )?.key;
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(natsUrl ? { natsUrl } : {}),
    ...(environment ? { environment } : {}),
  };
}

function connectionUrl(value: unknown) {
  if (!text(value)) return undefined;
  const url = new URL(String(value));
  if (!["http:", "https:", "nats:", "tls:"].includes(url.protocol))
    throw new WorkflowContractError("Unsupported Beam connection protocol.");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  // Projected Beam HTTP URLs identify an origin. Authenticated paths belong in
  // the credential payload and are never part of a public run snapshot.
  if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

export function referencedCredentialIds(...values: unknown[]) {
  const result = new Set<string>();
  let visited = 0;
  const visit = (value: unknown, depth: number) => {
    if (depth > 10 || visited >= 1_000 || value === null) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (
          (key === "credentialId" || key === "credential_id") &&
          text(child) &&
          String(child).length <= 256
        )
          result.add(String(child).trim());
        visit(child, depth + 1);
      }
    }
  };
  for (const value of values) visit(value, 0);
  return [...result].slice(0, 32);
}

/** Authorization and computation use the same frozen transfer destination. */
export function resolveFrozenBeamTransferConfig(
  config: Record<string, ActionJson>,
  inputs: unknown,
  context: unknown,
): Record<string, ActionJson> {
  const beam = object(object(context).beam);
  if (!beam.defaults || !beam.credentials)
    throw new WorkflowContractError(
      "The run has no frozen Beam connection configuration. Run the current workflow definition.",
    );
  const credentials = object(beam.credentials);
  const requested = referencedCredentialIds(config, inputs);
  if (
    requested.some(
      (id) =>
        !Array.isArray(beam.knownCredentialIds) ||
        !beam.knownCredentialIds.includes(id),
    )
  )
    throw new WorkflowContractError(
      "A referenced credential was not available in the frozen execution scope. Run the current workflow definition.",
    );
  const selected = requested.find((id) => Object.hasOwn(credentials, id));
  const credential = object(selected ? credentials[selected] : null);
  const defaults = object(beam.defaults);
  const resolved = { ...config };
  for (const key of ["baseUrl", "natsUrl", "environment"] as const) {
    const configured =
      key === "natsUrl"
        ? (config.natsUrl ?? config.beamNatsUrl ?? config.beam_nats_url)
        : config[key];
    const value =
      text(configured) ?? text(credential[key]) ?? text(defaults[key]);
    if (!text(configured) && value) resolved[key] = value;
  }
  return resolved;
}

export function workflowActionEnvironment(
  context: unknown,
  step?: { actionPackage?: unknown; config?: unknown } | null,
  inputs?: unknown,
): string | null {
  if (step?.actionPackage === "@beam/transfer") {
    const config = resolveFrozenBeamTransferConfig(
      object(step.config) as Record<string, ActionJson>,
      inputs,
      context,
    );
    return text(config.environment) ?? null;
  }
  return text(object(context).environment) ?? null;
}
