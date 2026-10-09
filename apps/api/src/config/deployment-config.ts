export type StudioDeploymentConfigSummary = {
  beamEnvironment: "dev" | "prod";
  devSettingsEnabled: boolean;
};

export function validateStudioDeploymentConfig(
  environment: NodeJS.ProcessEnv,
): StudioDeploymentConfigSummary {
  // Room control has no static credential: user requests delegate with the
  // Beam Auth session, background work with an organization Beam API key.
  // A leftover room service credential secret is ignored so existing
  // deployments keep starting until the secret is removed.
  const beamEnvironment = required(environment, "BEAM_ENV");
  if (beamEnvironment !== "dev" && beamEnvironment !== "prod") {
    throw new Error("BEAM_ENV must be dev or prod.");
  }
  const devSettings = required(environment, "BEAM_STUDIO_DEV_SETTINGS_ENABLED");
  if (devSettings !== "true" && devSettings !== "false") {
    throw new Error("BEAM_STUDIO_DEV_SETTINGS_ENABLED must be true or false.");
  }
  for (const name of [
    "BEAM_DEFAULT_BASE_URL",
    "BEAM_DEFAULT_COORDINATOR_URL",
    "BEAM_DEFAULT_REGISTRY_URL",
    "BEAM_AUTH_URL",
    "BEAM_API_URL",
    "BEAM_ACTION_REGISTRY_URL",
  ] as const) {
    requireUrl(environment, name, new Set(["http:", "https:"]));
  }
  requireUrl(environment, "BEAM_DEFAULT_NATS_URL", new Set(["nats:", "tls:"]));
  const serverOptions = required(environment, "BEAM_SERVER_OPTIONS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!serverOptions.length) {
    throw new Error("BEAM_SERVER_OPTIONS must contain at least one URL.");
  }
  serverOptions.forEach((value, index) => {
    validateUrl(
      value,
      `BEAM_SERVER_OPTIONS entry ${index + 1}`,
      new Set(["http:", "https:"]),
    );
  });
  return {
    beamEnvironment,
    devSettingsEnabled: devSettings === "true",
  };
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

function requireUrl(
  environment: NodeJS.ProcessEnv,
  name: string,
  protocols: ReadonlySet<string>,
) {
  validateUrl(required(environment, name), name, protocols);
}

function validateUrl(
  value: string,
  name: string,
  protocols: ReadonlySet<string>,
) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (!parsed.hostname || !protocols.has(parsed.protocol)) {
    throw new Error(
      `${name} must use one of these protocols: ${[...protocols].join(", ")}.`,
    );
  }
}
