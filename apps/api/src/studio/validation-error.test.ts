import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { auth } from "../auth/policy.js";
import { createApiLogger } from "../logging.js";
import { buildServer } from "../server.js";
import {
  StudioConflictError,
  StudioForbiddenError,
  StudioNotFoundError,
  StudioValidationError,
} from "./validation-error.js";

test("a validation error is a 400 with its code, message and details; any other error stays a 500", async () => {
  const server = await buildServer({
    pgPool: {
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as PgPool,
    logger: createApiLogger("t", { LOG_LEVEL: "silent" }),
  });
  const policy = { config: { auth: auth.public("validation error test") } };
  server.post("/test/validation", policy, async () => {
    throw new StudioValidationError(
      "workflow_name_required",
      "Workflow name is required.",
      { field: "name" },
    );
  });
  server.post("/test/failure", policy, async () => {
    throw new Error("Workflow name is required.");
  });
  try {
    const refused = await server.inject({
      method: "POST",
      url: "/test/validation",
      payload: {},
    });
    assert.equal(refused.statusCode, 400);
    assert.deepEqual(
      (({ code, error, details, statusCode }) => ({
        code,
        error,
        details,
        statusCode,
      }))(refused.json()),
      {
        code: "workflow_name_required",
        error: "Workflow name is required.",
        details: { field: "name" },
        statusCode: 400,
      },
    );

    const failed = await server.inject({
      method: "POST",
      url: "/test/failure",
      payload: {},
    });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.json().code, "internal_error");
    assert.equal(failed.json().error, "Internal server error");
  } finally {
    await server.close();
  }
});

test("StudioValidationError is still an Error with its message", () => {
  const error = new StudioValidationError("x_required", "X is required.");
  assert.ok(error instanceof Error);
  assert.equal(error.message, "X is required.");
  assert.equal(error.name, "StudioValidationError");
  assert.equal(error.statusCode, 400);
  assert.equal(error.expose, true);
  assert.equal(error.details, undefined);
});

test("not-found, conflict and forbidden errors answer 404, 409 and 403 with their code", async () => {
  const server = await buildServer({
    pgPool: {
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as PgPool,
    logger: createApiLogger("t", { LOG_LEVEL: "silent" }),
  });
  const policy = { config: { auth: auth.public("typed error test") } };
  const cases = [
    new StudioNotFoundError(
      "workflow_not_found",
      "Workflow template not found.",
    ),
    new StudioConflictError(
      "workflow_run_not_retryable",
      "Only failed or cancelled workflow runs can be retried.",
      { status: "running" },
    ),
    new StudioForbiddenError(
      "project_organization_mismatch",
      "Project does not belong to the selected organization.",
    ),
  ];
  cases.forEach((error, index) =>
    server.post(`/test/typed/${index}`, policy, async () => {
      throw error;
    }),
  );
  try {
    for (const [index, error] of cases.entries()) {
      const response = await server.inject({
        method: "POST",
        url: `/test/typed/${index}`,
        payload: {},
      });
      assert.equal(response.statusCode, error.statusCode, response.body);
      assert.equal(response.json().code, error.code);
      assert.equal(response.json().error, error.message);
      assert.deepEqual(response.json().details, error.details);
    }
  } finally {
    await server.close();
  }
});
