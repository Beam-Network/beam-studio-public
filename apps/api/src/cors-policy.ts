import { webEnv } from "./env.js";

// Local development ports for the Studio dev server and the built Studio app.
// Production never falls back to these: an unset STUDIO_CORS_ORIGIN there means
// no cross-origin request is credentialed, rather than trusting localhost.
const developmentOrigins = "http://localhost:5173,http://localhost:3004";

function isProduction() {
  return process.env.NODE_ENV === "production";
}

let parsed: { raw: string; origins: Set<string> } | null = null;

function configuredOrigins() {
  const raw =
    process.env.STUDIO_CORS_ORIGIN ?? (isProduction() ? "" : developmentOrigins);
  if (!parsed || parsed.raw !== raw) {
    parsed = {
      raw,
      origins: new Set(
        raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    };
  }
  return parsed.origins;
}

/**
 * sslip.io resolves whatever IP is embedded in the hostname, so anyone can
 * serve a page from a `*.sslip.io` name they control. Trusting the suffix is
 * therefore equivalent to allowing every origin — with credentials, and with
 * private-network access on top. It stays available for local tunnel work, but
 * only when deliberately enabled, and never in production.
 */
function tunnelOriginsEnabled() {
  return (
    !isProduction() &&
    process.env.STUDIO_CORS_ALLOW_TUNNEL_ORIGINS === "true"
  );
}

function isTunnelOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "sslip.io" || url.hostname.endsWith(".sslip.io"))
    );
  } catch {
    return false;
  }
}

/**
 * The single origin decision for every Studio surface. `extraOrigins` carries
 * the caller's own trusted origins, such as the configured Studio URL for
 * agent-control routes.
 */
export function isAllowedStudioOrigin(
  origin: string | undefined,
  extraOrigins: string[] = [],
) {
  if (!origin) return false;
  if (configuredOrigins().has(origin)) return true;
  if (extraOrigins.some((value) => value && value === origin)) return true;
  return tunnelOriginsEnabled() && isTunnelOrigin(origin);
}

export function studioAgentControlOrigins() {
  return [webEnv.transferStudioUrl];
}
