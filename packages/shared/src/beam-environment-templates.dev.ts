import type { BeamEnvironmentTemplate } from "./beam-environment-templates.js";

export const devBeamEnvironmentTemplate = {
  key: "dev",
  name: "Local Development",
  baseUrl: "http://127.0.0.1:8001",
  coordinatorUrl: "http://127.0.0.1:8789",
  natsUrl: "nats://127.0.0.1:4222",
  authUrl: "http://127.0.0.1:3004",
  apiUrl: "http://127.0.0.1:3002",
  registryUrl: "http://127.0.0.1:3002/registry",
  builtIn: true,
} as const satisfies BeamEnvironmentTemplate;
