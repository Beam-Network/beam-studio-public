import assert from "node:assert/strict";
import test from "node:test";
import { ActionInputError, type ActionManifest } from "@beam-studio/core";
import { assertActionConfig } from "./services/actionConfig.js";

test("accepts action config matching the manifest schema", () => {
  assert.doesNotThrow(() =>
    assertActionConfig(manifest(), {
      mode: "fast",
      retries: 2,
      dryRun: true,
    }),
  );
});

test("rejects action config with unknown, missing, or mistyped fields", () => {
  assert.throws(
    () =>
      assertActionConfig(manifest(), {
        mode: "turbo",
        retries: 1.5,
        extra: "nope",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ActionInputError);
      assert.match(error.message, /config\.dryRun is required/);
      assert.match(error.message, /config\.extra is not allowed/);
      assert.match(error.message, /config\.mode must be one of: fast, safe/);
      assert.match(error.message, /config\.retries must be an integer/);
      return true;
    },
  );
});

function manifest(): ActionManifest {
  return {
    apiVersion: "workflow-actions/v1",
    configSchema: {
      additionalProperties: false,
      properties: {
        mode: { enum: ["fast", "safe"], type: "string" },
        retries: { type: "integer" },
        dryRun: { type: "boolean" },
      },
      required: ["mode", "dryRun"],
      type: "object",
    },
    inputs: {},
    name: "@example/configured",
    outputs: {},
    runtime: { placements: ["local-workers"] },
    version: "1.0.0",
  };
}
