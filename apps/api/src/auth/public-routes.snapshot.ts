/**
 * Every route on the Studio API that answers without authenticating anybody.
 *
 * Adding an entry is a security decision, not a refactor. The conformance test
 * fails until this list and the router agree exactly, so widening the
 * unauthenticated surface cannot happen as a side effect of adding a route.
 */
export const PUBLIC_ROUTES: readonly string[] = [
  "GET /health", // liveness; no tenant data
  "GET /studio/contracts", // static client/server contract shapes
  "GET /studio/health", // liveness
  "POST /studio/auth/device/authorize", // starts the OAuth device grant
  "POST /studio/auth/logout", // must work without a valid session
];
