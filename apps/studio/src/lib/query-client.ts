import { QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-errors";

const SESSION_QUERY_KEY = "/studio/session";

/**
 * Who is signed in, and which organizations and projects they work in, change
 * only through a full page load: signing in or out, and switching organization
 * or project, all reload Studio, and the root session gate re-validates the
 * session on every load. Refetching them on every page mount only delays each
 * page behind the same answers.
 */
export const workspaceContextQueryKeys = [
  SESSION_QUERY_KEY,
  "/studio/organizations",
  "/studio/projects",
] as const;

export const workspaceContextStaleTime = 5 * 60_000;

/**
 * Retries only what a retry can fix: an unreachable API, rate limiting, a
 * server error, or an error the API marks retryable. A refusal (400, 401, 403,
 * 404, ...) answers the same way the next time, and retrying it only keeps the
 * page on its placeholder for seconds before showing the error.
 */
export function studioQueryRetry(failureCount: number, error: unknown) {
  if (failureCount >= 2) return false;
  if (!(error instanceof ApiError)) return true;
  return (
    error.retryable ||
    error.statusCode === 0 ||
    error.statusCode === 429 ||
    error.statusCode >= 500
  );
}

export function createStudioQueryClient() {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // A request refused as signed out re-runs the root session gate, which
        // sends the user to sign in. The session query itself is that gate.
        if (
          error instanceof ApiError &&
          error.statusCode === 401 &&
          query.queryKey[0] !== SESSION_QUERY_KEY
        ) {
          void queryClient.invalidateQueries({
            queryKey: [SESSION_QUERY_KEY],
          });
        }
      },
    }),
    defaultOptions: { queries: { retry: studioQueryRetry } },
  });
  for (const key of workspaceContextQueryKeys) {
    queryClient.setQueryDefaults([key], {
      staleTime: workspaceContextStaleTime,
    });
  }
  return queryClient;
}
