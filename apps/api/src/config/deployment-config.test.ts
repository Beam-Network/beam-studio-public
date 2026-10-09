import assert from "node:assert/strict";
import test from "node:test";
import { validateStudioDeploymentConfig } from "./deployment-config.js";

const valid = {
  BEAM_ENV: "prod",
  BEAM_STUDIO_DEV_SETTINGS_ENABLED: "true",
  BEAM_DEFAULT_BASE_URL: "https://beam.example",
  BEAM_DEFAULT_COORDINATOR_URL: "https://coordinator.example",
  BEAM_DEFAULT_REGISTRY_URL: "https://api.example/registry",
  BEAM_DEFAULT_NATS_URL: "tls://nats.example:4222",
  BEAM_SERVER_OPTIONS: "https://beam.example,http://beam.dev.example:8000",
  BEAM_AUTH_URL: "https://auth.example",
  BEAM_API_URL: "https://api.example",
  BEAM_ACTION_REGISTRY_URL: "https://api.example/registry",
} satisfies NodeJS.ProcessEnv;

test("deployment configuration needs no room service credential", () => {
  assert.deepEqual(validateStudioDeploymentConfig(valid), {
    beamEnvironment: "prod",
    devSettingsEnabled: true,
  });
});

test("deployment configuration rejects malformed typed values", () => {
  assert.throws(
    () =>
      validateStudioDeploymentConfig({
        ...valid,
        BEAM_STUDIO_DEV_SETTINGS_ENABLED: "yes",
      }),
    /must be true or false/,
  );
  assert.throws(
    () =>
      validateStudioDeploymentConfig({
        ...valid,
        BEAM_DEFAULT_NATS_URL: "https://nats.example",
      }),
    /must use one of these protocols/,
  );
});
