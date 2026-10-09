import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./api-errors";
import {
  createStudioQueryClient,
  studioQueryRetry,
  workspaceContextStaleTime,
} from "./query-client";

const apiError = (statusCode: number, retryable = false) =>
  new ApiError({ message: "refused", statusCode, retryable });

test("a refusal is shown at once instead of retried", () => {
  for (const status of [400, 401, 403, 404, 409]) {
    assert.equal(studioQueryRetry(0, apiError(status)), false, String(status));
  }
});

test("what a retry can fix is retried at most twice", () => {
  for (const error of [
    apiError(0, true),
    apiError(429),
    apiError(503),
    apiError(400, true),
    new TypeError("network"),
  ]) {
    assert.equal(studioQueryRetry(0, error), true);
    assert.equal(studioQueryRetry(1, error), true);
    assert.equal(studioQueryRetry(2, error), false);
  }
});

test("workspace context stays fresh across page navigation", () => {
  const queryClient = createStudioQueryClient();
  for (const key of [
    ["/studio/session"],
    ["/studio/organizations"],
    ["/studio/projects", "org_1"],
  ]) {
    assert.equal(
      queryClient.getQueryDefaults(key).staleTime,
      workspaceContextStaleTime,
      key.join(" "),
    );
  }
  assert.equal(
    queryClient.getQueryDefaults(["/studio/workflows"]).staleTime,
    undefined,
  );
});

function recordInvalidations(queryClient: ReturnType<typeof createStudioQueryClient>) {
  const keys: unknown[] = [];
  const invalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
    keys.push(filters?.queryKey);
    return invalidate(filters as never);
  }) as typeof queryClient.invalidateQueries;
  return keys;
}

async function refuse(
  queryClient: ReturnType<typeof createStudioQueryClient>,
  queryKey: string[],
) {
  await queryClient
    .fetchQuery({
      queryKey,
      queryFn: () => Promise.reject(apiError(401)),
      retry: false,
    })
    .catch(() => undefined);
}

test("a request refused as signed out re-checks the session", async () => {
  const queryClient = createStudioQueryClient();
  const invalidated = recordInvalidations(queryClient);
  await refuse(queryClient, ["/studio/workflows"]);
  assert.deepEqual(invalidated, [["/studio/session"]]);
});

test("the session query refusing does not re-check itself", async () => {
  const queryClient = createStudioQueryClient();
  const invalidated = recordInvalidations(queryClient);
  await refuse(queryClient, ["/studio/session"]);
  assert.deepEqual(invalidated, []);
});
