const PUBLIC_STUDIO_PATHS = new Set(["/auth", "/login"]);

export function requiresStudioSession(pathname: string) {
  return !PUBLIC_STUDIO_PATHS.has(pathname);
}

export function studioAuthRedirectPath(
  pathname: string,
  search = "",
  hash = "",
) {
  const callbackUrl = `${pathname || "/"}${search}${hash}`;
  return `/auth?callbackUrl=${encodeURIComponent(callbackUrl)}`;
}
