/**
 * Every route reachable before this deployment admits the caller.
 *
 * These still require a signed-in Beam account — the funnel is narrower than
 * the public surface, not wider. What they skip is the instance check, which is
 * the whole point: an unclaimed Studio has to be claimable, and a caller it
 * refuses has to be told why rather than served a broken UI.
 *
 * Adding an entry is a security decision, not a refactor. Every route here is
 * one an unadmitted stranger can reach, so the conformance test fails until
 * this list and the router agree exactly.
 */
export const CLAIM_FUNNEL_ROUTES: readonly string[] = [
  "GET /studio/session", // identity probe; the SPA redirect-loops without it
  "GET /studio/organizations", // the claimant picks which of *their* orgs owns this
  "GET /studio/instance/access", // renders the claim or the "private" screen
  "POST /studio/instance/claim", // the claim itself
];
