import assert from "node:assert/strict";
import test from "node:test";
import {
  getBeamEnvironmentSettings,
  resolveBeamEnvironmentTemplate,
} from "./store.js";

test("Beam environment templates force production when dev settings are disabled", async () => {
  assert.notEqual(process.env.BEAM_STUDIO_DEV_SETTINGS_ENABLED, "true");

  const settings = await getBeamEnvironmentSettings("org");
  assert.equal(settings.devSettingsEnabled, false);
  assert.equal(settings.defaultTemplateKey, "prod");
  assert.deepEqual(
    settings.templates.map((template) => template.name),
    ["Beam Production"],
  );
  // Room control follows the template's Coordinator, not a per-organization
  // service credential: every organization with a session can control rooms.
  assert.equal(settings.templates[0]?.roomControlAvailable, true);
  assert.equal(
    (await getBeamEnvironmentSettings("other")).templates[0]
      ?.roomControlAvailable,
    true,
  );

  const requestedDev = await resolveBeamEnvironmentTemplate({
    organizationId: "org",
    templateKey: "dev",
  });
  assert.equal(requestedDev.key, "prod");
  assert.equal(requestedDev.name, "Beam Production");
  assert.equal(requestedDev.coordinatorUrl, "https://coordinator.b1m.ai");
});
