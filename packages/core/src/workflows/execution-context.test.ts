import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beamConnectionDefaults,
  resolveFrozenBeamTransferConfig,
  workflowActionEnvironment,
  type FrozenExecutionConfiguration,
} from "./execution-context.js";

const context: FrozenExecutionConfiguration = {
  environment: "prod",
  beam: {
    defaults: {
      environment: "dev",
      baseUrl: "https://dev.example",
      natsUrl: "nats://dev.example:4222",
    },
    credentials: {
      production: {
        environment: "prod",
        baseUrl: "https://prod.example",
        natsUrl: "tls://prod.example:4222",
      },
    },
    knownCredentialIds: ["production", "storage"],
  },
};

test("roomless authorization and transfer execution share frozen environment precedence", () => {
  assert.equal(workflowActionEnvironment(context), "prod");
  assert.equal(
    workflowActionEnvironment(context, {
      actionPackage: "@example/action",
      config: { environment: "unrelated-action-setting" },
    }),
    "prod",
  );
  const inputs = {
    source: { credentialId: "storage" },
    beam: { credentialId: "production" },
  };
  assert.deepEqual(
    resolveFrozenBeamTransferConfig({}, inputs, context),
    context.beam.credentials.production,
  );
  assert.equal(
    workflowActionEnvironment(
      context,
      { actionPackage: "@beam/transfer", config: {} },
      inputs,
    ),
    "prod",
  );
  assert.deepEqual(
    resolveFrozenBeamTransferConfig(
      {
        environment: "custom",
        baseUrl: "https://custom.example",
        beamNatsUrl: "tls://custom.example:4222",
      },
      inputs,
      context,
    ),
    {
      environment: "custom",
      baseUrl: "https://custom.example",
      beamNatsUrl: "tls://custom.example:4222",
    },
  );
  assert.deepEqual(
    resolveFrozenBeamTransferConfig({}, {}, context),
    context.beam.defaults,
  );
});

test("frozen connection configuration excludes credential and endpoint secrets", () => {
  assert.deepEqual(
    beamConnectionDefaults({
      base_url:
        "https://user:private@beamcore.b1m.ai/private-token-path?secret=private#private",
      nats_url: "tls://user:private@orch-gateway.b1m.ai:4222?token=private",
      api_key: "private",
      arbitrary: "private",
    }),
    {
      baseUrl: "https://beamcore.b1m.ai",
      natsUrl: "tls://orch-gateway.b1m.ai:4222",
      environment: "prod",
    },
  );
});

test("new credentials and absent snapshots cannot silently use current deployment defaults", () => {
  assert.throws(
    () =>
      resolveFrozenBeamTransferConfig(
        { credentialId: "created-later" },
        {},
        context,
      ),
    /not available in the frozen execution scope/,
  );
  assert.throws(
    () => resolveFrozenBeamTransferConfig({}, {}, {}),
    /no frozen Beam connection/,
  );
});
