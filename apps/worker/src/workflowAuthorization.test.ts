import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeWorkflowExecutionPg,
  WorkflowAuthorizationError,
  WorkflowAuthorityUnavailableError,
  type WorkflowAuthorizationRequest,
  type PgPool,
} from "@beam-studio/db";

test("authority transport outages and invalid replies remain distinct from revocation", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.BEAM_STUDIO_API_URL;
  process.env.BEAM_STUDIO_API_URL = "https://studio.example.test";
  const input: WorkflowAuthorizationRequest = {
    workflowRunId: "run",
    taskId: "task",
    claimToken: "test-claim",
    phase: "lease_renewal",
  };
  const check = () => authorizeWorkflowExecutionPg({} as PgPool, input);
  try {
    for (const target of [
      "invalid-url",
      "ftp://studio.example.test",
      "https://user:private@studio.example.test",
    ]) {
      process.env.BEAM_STUDIO_API_URL = target;
      await assert.rejects(check(), {
        code: "execution_authority_configuration_invalid",
        retryable: false,
        statusCode: 403,
      });
    }
    process.env.BEAM_STUDIO_API_URL = "https://studio.example.test";
    globalThis.fetch = async () => {
      throw new DOMException("private transport detail", "TimeoutError");
    };
    await assert.rejects(check(), (error) => {
      assert.ok(error instanceof WorkflowAuthorityUnavailableError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.retryable, true);
      assert.equal(error.transportCode, "TimeoutError");
      assert.equal(
        JSON.stringify(error).includes("private transport detail"),
        false,
      );
      return true;
    });
    for (const status of [429, 500, 503]) {
      globalThis.fetch = async () =>
        new Response("upstream unavailable", { status });
      await assert.rejects(check(), WorkflowAuthorityUnavailableError);
    }
    for (const reply of ["invalid-json", "{}"] as const) {
      globalThis.fetch = async () => new Response(reply, { status: 200 });
      await assert.rejects(check(), WorkflowAuthorityUnavailableError);
    }
    globalThis.fetch = async () =>
      Response.json(
        { authorized: false, code: "execution_target_revoked" },
        { status: 403 },
      );
    await assert.rejects(check(), (error) => {
      assert.ok(error instanceof WorkflowAuthorizationError);
      assert.equal(error.retryable, false);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, "execution_target_revoked");
      return true;
    });
    globalThis.fetch = async () => Response.json({ authorized: true });
    await check();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.BEAM_STUDIO_API_URL;
    else process.env.BEAM_STUDIO_API_URL = originalUrl;
  }
});
