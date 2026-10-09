import { validateStudioDeploymentConfig } from "../src/config/deployment-config.js";

const summary = validateStudioDeploymentConfig(process.env);
console.log(
  JSON.stringify({
    ok: true,
    beamEnvironment: summary.beamEnvironment,
    devSettingsEnabled: summary.devSettingsEnabled,
  }),
);
