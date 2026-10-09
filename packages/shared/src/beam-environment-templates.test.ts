import assert from "node:assert/strict";
import test from "node:test";
import {
  builtinBeamEnvironmentTemplates,
  defaultBeamEnvironmentTemplate,
  normalizeBeamEnvironmentTemplate,
  roomCoordinatorUrl,
  templateKeyFromValue,
} from "./beam-environment-templates.js";
import { devBeamEnvironmentTemplate } from "./beam-environment-templates.dev.js";

test("built-in Beam environment templates default to production", () => {
  assert.equal(defaultBeamEnvironmentTemplate().key, "prod");
  assert.equal(
    builtinBeamEnvironmentTemplates.prod.baseUrl,
    "https://beamcore.b1m.ai",
  );
  assert.equal(builtinBeamEnvironmentTemplates.dev, devBeamEnvironmentTemplate);
  assert.equal(devBeamEnvironmentTemplate.key, "dev");
  assert.equal(devBeamEnvironmentTemplate.builtIn, true);
  assert.equal(roomCoordinatorUrl("prod"), "https://coordinator.b1m.ai");
  assert.equal(
    roomCoordinatorUrl("dev"),
    devBeamEnvironmentTemplate.coordinatorUrl,
  );
});

test("template inputs own the Beam endpoint set", () => {
  const template = normalizeBeamEnvironmentTemplate({
    key: "dev",
    name: "Local Development",
    baseUrl: "http://127.0.0.1:8000",
    coordinatorUrl: "http://127.0.0.1:8789",
    natsUrl: "nats://127.0.0.1:4222",
    authUrl: "http://127.0.0.1:3004",
    apiUrl: "http://127.0.0.1:3002",
    registryUrl: "http://127.0.0.1:3002/registry",
  });
  assert.equal(template.key, "dev");
  assert.equal(template.builtIn, false);
  assert.throws(() =>
    normalizeBeamEnvironmentTemplate({ ...template, key: "DEV" }),
  );
  assert.throws(() =>
    normalizeBeamEnvironmentTemplate({ ...template, environment: "dev" }),
  );
  assert.throws(() =>
    normalizeBeamEnvironmentTemplate({ ...template, natsUrl: "http://nats" }),
  );
  assert.equal(templateKeyFromValue("prod"), "prod");
  assert.equal(templateKeyFromValue("PROD"), null);
});
