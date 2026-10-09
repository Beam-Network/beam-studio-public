import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTANCE_UNCLAIMED,
  apiDisplayUrl,
  apiUnreachableMessage,
  isInstanceUnclaimedResponse,
  isNetworkFailure,
} from "./api-errors";

test("a refused connection names the API and a next step", () => {
  assert.equal(
    apiUnreachableMessage(apiDisplayUrl("http://localhost:8787/")),
    "Studio can't reach its API at http://localhost:8787. Check that the Studio services are running.",
  );
});

test("a same-origin API path is shown against the page origin", () => {
  assert.equal(
    apiDisplayUrl("/__studio_api/", "https://studio.example.com"),
    "https://studio.example.com/__studio_api",
  );
});

test("only a fetch rejection without a response is a network failure", () => {
  assert.equal(isNetworkFailure(new TypeError("Failed to fetch")), true);
  const abort = new Error("The operation was aborted.");
  abort.name = "AbortError";
  assert.equal(isNetworkFailure(abort), false);
});

test("only the workspace refusal of an unclaimed instance opens the claim step", () => {
  assert.equal(isInstanceUnclaimedResponse(403, INSTANCE_UNCLAIMED), true);
  // Instance administration answers 409 with the same code; the page making
  // that call is already the claim step.
  assert.equal(isInstanceUnclaimedResponse(409, INSTANCE_UNCLAIMED), false);
  assert.equal(
    isInstanceUnclaimedResponse(403, "organization_forbidden"),
    false,
  );
});
