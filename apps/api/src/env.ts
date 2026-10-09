type StudioAuthPortal = "auth" | "console" | "admin";

const productionBeamBaseUrl = "https://beamcore.b1m.ai";
const productionBeamCoordinatorUrl = "https://coordinator.b1m.ai";
const productionBeamNatsUrl = "tls://orch-gateway.b1m.ai:4222";

function beamServerOptions() {
  const raw =
    process.env.BEAM_SERVER_OPTIONS ||
    process.env.NEXT_PUBLIC_BEAM_SERVER_OPTIONS ||
    "";
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length
    ? values
    : [process.env.BEAM_DEFAULT_BASE_URL ?? productionBeamBaseUrl];
}

/**
 * Whether the session cookie carries Secure.
 *
 * The explicit setting still wins, but the fallback is the request's own
 * scheme rather than NODE_ENV: a deployment serving HTTPS while NODE_ENV
 * happened to be "development" was issuing a non-Secure session cookie.
 */
function secureCookies(secureRequest?: boolean) {
  if (process.env.BEAM_STUDIO_SECURE_COOKIES === "false") {
    return false;
  }

  if (process.env.BEAM_STUDIO_SECURE_COOKIES === "true") {
    return true;
  }

  return secureRequest ?? process.env.NODE_ENV === "production";
}

export { secureCookies as studioSecureCookies };

function defaultAuthUrl() {
  return "https://auth.b1m.ai";
}

function defaultApiUrl() {
  return "https://api.b1m.ai";
}

function defaultConsoleUrl() {
  return process.env.NODE_ENV === "production"
    ? "https://console.b1m.ai"
    : "http://localhost:3001";
}

export const webEnv = {
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? "BEAM Transfer Studio",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://beam:beam@127.0.0.1:5432/beam_studio",
  beamDefaultBaseUrl:
    process.env.BEAM_DEFAULT_BASE_URL ?? productionBeamBaseUrl,
  beamDefaultCoordinatorUrl:
    process.env.BEAM_DEFAULT_COORDINATOR_URL ?? productionBeamCoordinatorUrl,
  beamDefaultNatsUrl:
    process.env.BEAM_DEFAULT_NATS_URL ?? productionBeamNatsUrl,
  beamDefaultRegistryUrl:
    process.env.BEAM_DEFAULT_REGISTRY_URL ?? "https://api.b1m.ai/registry",
  consoleUrl:
    process.env.BEAM_CONSOLE_URL ??
    process.env.NEXT_PUBLIC_CONSOLE_URL ??
    defaultConsoleUrl(),
  adminUrl: "http://localhost:3003",
  authUrl:
    process.env.BEAM_AUTH_URL ??
    process.env.NEXT_PUBLIC_AUTH_URL ??
    defaultAuthUrl(),
  apiUrl:
    process.env.BEAM_API_URL ??
    process.env.NEXT_PUBLIC_BEAM_API_URL ??
    defaultApiUrl(),
  beamActionRegistryUrl:
    process.env.BEAM_ACTION_REGISTRY_URL ??
    process.env.REGISTRY_API_URL ??
    process.env.registry_api_url ??
    "https://api.b1m.ai/registry",
  transferStudioUrl:
    process.env.NEXT_PUBLIC_TRANSFER_STUDIO_URL ?? "http://localhost:3000",
  /**
   * A `bm_sa_` service account credential, used only to read budget alerts.
   * Optional: without it the budget warning bar stays hidden rather than
   * Studio failing to start.
   */
  beamManagementCredential: process.env.BEAM_MANAGEMENT_CREDENTIAL ?? "",
  studioAuthPortal: "auth" as StudioAuthPortal,
  beamServerOptions: beamServerOptions(),
  secureCookies: secureCookies(),
  devSettingsEnabled: process.env.BEAM_STUDIO_DEV_SETTINGS_ENABLED === "true",
  instanceKeyEnabled: process.env.BEAM_STUDIO_INSTANCE_KEY !== "disabled",
  /** Room Workflows (distributed workflow-graph/v3) ship in a later release. */
  roomWorkflowsEnabled: process.env.BEAM_STUDIO_ROOM_WORKFLOWS === "true",
};
