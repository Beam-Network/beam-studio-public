/**
 * A verified organization scope.
 *
 * The monolithic store passed organization IDs as optional strings and reduced
 * a missing one to `""`, which its SQL then read as "no filter" — so a lost
 * scope widened a query to every tenant instead of failing. Security-sensitive
 * repositories take this type instead, and `organizationScope` is the only way
 * to make one, so an unscoped read cannot be expressed.
 */
export type OrganizationScope = {
  readonly organizationId: string;
};

/**
 * Builds a scope, refusing anything blank. Callers resolve the organization
 * from the authenticated request, so a missing one is an authorization failure
 * rather than a wider query.
 */
export function organizationScope(
  organizationId: string | null | undefined,
): OrganizationScope {
  const value = typeof organizationId === "string" ? organizationId.trim() : "";
  if (!value) {
    throw Object.assign(
      new Error("An organization is required for this operation."),
      { code: "organization_required", statusCode: 400, expose: true },
    );
  }
  return { organizationId: value };
}
