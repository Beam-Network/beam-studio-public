import assert from "node:assert/strict";
import test from "node:test";
import { slackActionManifest } from "@beam-studio/core";
import { credentialConfigFields } from "./workflow-config-schema";

test("the Slack action offers a picker of Slack credentials", () => {
  const fields = credentialConfigFields(
    slackActionManifest as unknown as Record<string, never>,
  );
  assert.deepEqual([...fields.keys()], ["credentialId"]);
  assert.deepEqual(fields.get("credentialId"), ["slack_bot_token"]);
});

test("an action with no credential requirement contributes no picker", () => {
  assert.equal(credentialConfigFields({}).size, 0);
  assert.equal(
    credentialConfigFields({ catalog: { credentialRequirements: [] } }).size,
    0,
  );
});

test("only config paths become pickers, since inputs are bound elsewhere", () => {
  const fields = credentialConfigFields({
    catalog: {
      credentialRequirements: [
        {
          key: "object-storage",
          configPaths: [
            "inputs.credentialId",
            "config.credentialId",
            // A wildcard addresses an array the bespoke endpoint editor owns.
            "inputs.endpoints[*].credentialId",
          ],
          acceptedCredentialTypes: ["s3_compatible_access_key"],
        },
      ],
    },
  });
  assert.deepEqual([...fields.keys()], ["credentialId"]);
});

test("a requirement naming no accepted types still yields a picker", () => {
  // An empty list means "any credential", which the form must not read as
  // "no credentials can satisfy this".
  const fields = credentialConfigFields({
    catalog: {
      credentialRequirements: [
        { key: "anything", configPaths: ["config.credentialId"] },
      ],
    },
  });
  assert.deepEqual(fields.get("credentialId"), []);
});
