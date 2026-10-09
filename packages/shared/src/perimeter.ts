/**
 * Where a service listens, and which `Host` values it will answer to.
 *
 * Studio is installed on machines its operator controls, so the defaults here
 * assume the network is hostile until configured otherwise: every service binds
 * loopback unless told not to, and only the Studio web server is expected to be
 * told otherwise.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string) {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * The interface a service listens on. Loopback unless explicitly widened, so a
 * service that nobody configured is not reachable from the network.
 */
export function listenHost(envName: string, fallback = "127.0.0.1") {
  return process.env[envName]?.trim() || fallback;
}

/** Hostnames this installation answers to, from `BEAM_STUDIO_ALLOWED_HOSTS`. */
export function allowedHostnames(
  raw = process.env.BEAM_STUDIO_ALLOWED_HOSTS,
): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** Strips the port from a `Host` header, keeping bracketed IPv6 intact. */
export function hostnameOf(header: string | undefined | null) {
  const value = (header ?? "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  const colon = value.lastIndexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * True for a name with no dot, such as a container or Compose service name.
 *
 * DNS rebinding needs a name the victim's browser can resolve, which means a
 * registrable domain the attacker controls. A single label has no public TLD
 * and resolves only through a local search domain, a hosts file or a container
 * network — none of which a remote attacker can influence. Accepting these is
 * what lets `http://api:8787` work between containers without every operator
 * having to enumerate their service names.
 */
export function isSingleLabelHost(hostname: string) {
  return (
    hostname.length > 0 && !hostname.includes(".") && !hostname.includes("[")
  );
}

/** True for a bare IPv4/IPv6 literal, which DNS rebinding cannot produce. */
export function isIpLiteral(hostname: string) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Whether a `Host` header may be answered.
 *
 * DNS rebinding needs a *name* whose answer can be flipped to a private
 * address; the victim's browser then sends that name as `Host`. An IP literal
 * cannot be rebound, and loopback names are the local install talking to
 * itself, so both are accepted — which keeps `http://<vps-ip>:3004`, far and
 * away the common client install, working without configuration. Single-label
 * names are accepted for the same reason: services address each other as
 * `http://api:8787` over a container network, and those names are not publicly
 * resolvable. Every other name has to be in `BEAM_STUDIO_ALLOWED_HOSTS`.
 */
export function hostAllowed(
  header: string | undefined | null,
  allowlist: readonly string[] = allowedHostnames(),
) {
  const hostname = hostnameOf(header);
  if (!hostname) return false;
  if (
    isLoopbackHost(hostname) ||
    isIpLiteral(hostname) ||
    isSingleLabelHost(hostname)
  ) {
    return true;
  }
  return allowlist.includes(hostname);
}
