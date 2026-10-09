import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialMetadataNetworkTargets,
  networkTargetFromUrl,
} from "./services/trustedNetwork.js";
import { referencedCredentialIds } from "@beam-studio/core";

test("extracts only credential references from action data", () => {
  assert.deepEqual(
    referencedCredentialIds(
      { credentialId: "cred_beam", natsUrl: "nats://untrusted.test:4222" },
      {
        sourceEndpoints: [
          {
            credentialId: "cred_r2",
            endpointUrl: "https://untrusted.test",
          },
        ],
      },
    ),
    ["cred_beam", "cred_r2"],
  );
});

test("derives network targets from stored credential metadata", () => {
  assert.deepEqual(
    credentialMetadataNetworkTargets([
      {
        metadata_json: {
          endpointUrl: "https://storage.example.test",
        },
      },
      {
        metadata_json: JSON.stringify({
          natsUrl: "nats://198.51.100.20:4222",
        }),
      },
    ]),
    [
      "storage.example.test:443",
      "198.51.100.20:4222",
    ],
  );
});

test("supports trusted endpoint schemes and rejects unsupported URLs", () => {
  assert.equal(
    networkTargetFromUrl("tls://orch-gateway.b1m.ai:4222"),
    "orch-gateway.b1m.ai:4222",
  );
  assert.equal(networkTargetFromUrl("https://storage.example.com/path"), "storage.example.com:443");
  assert.equal(networkTargetFromUrl("file:///tmp/private"), null);
  assert.equal(networkTargetFromUrl("not a URL"), null);
});

test("derives Salesforce login and instance hosts from credential metadata", () => {
  // A Salesforce org mints tokens at its login host and then serves every API
  // call from a separate instance host, so both must reach the allowlist or the
  // token exchange succeeds and the first real request is denied.
  assert.deepEqual(
    credentialMetadataNetworkTargets([
      {
        metadata_json: {
          credentialType: "salesforce_jwt",
          loginUrl: "https://test.salesforce.com",
          instanceUrl: "https://acme--dev.sandbox.my.salesforce.com",
        },
      },
    ]),
    // Order follows credentialUrlFields, which lists instanceUrl first.
    [
      "acme--dev.sandbox.my.salesforce.com:443",
      "test.salesforce.com:443",
    ],
  );
});

test("keeps Salesforce secrets out of the derived allowlist", () => {
  // metadata_json is a safe projection, but assert it explicitly: a client
  // secret must never become a network rule.
  assert.deepEqual(
    credentialMetadataNetworkTargets([
      {
        metadata_json: {
          credentialType: "salesforce_client_credentials",
          instanceUrl: "https://acme.my.salesforce.com",
          apiVersion: "v62.0",
          providerProfile: "salesforce",
        },
      },
    ]),
    ["acme.my.salesforce.com:443"],
  );
});

test("derives Adobe IMS and Platform hosts from credential metadata", () => {
  // AEP mints tokens at a region-specific IMS host and calls the API at a
  // different Platform host, so the same two-host rule as Salesforce applies.
  assert.deepEqual(
    credentialMetadataNetworkTargets([
      {
        metadata_json: {
          credentialType: "adobe_aep_oauth_s2s",
          baseUrl: "https://platform.adobe.io",
          loginUrl: "https://ims-na1.adobelogin.com",
          orgId: "1234567890ABCDEF@AdobeOrg",
          sandboxName: "prod",
        },
      },
    ]),
    ["platform.adobe.io:443", "ims-na1.adobelogin.com:443"],
  );
});
