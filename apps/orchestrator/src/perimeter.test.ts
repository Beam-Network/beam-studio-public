import assert from "node:assert/strict";
import test from "node:test";
import { hostAllowed, listenHost } from "@beam-studio/shared";

/**
 * The orchestrator's perimeter rules now come from the shared package, whose
 * own suite covers the helpers. What is worth asserting here is the shape the
 * orchestrator is actually deployed in.
 */

test("the orchestrator answers to its Compose service name", () => {
  // This is what the local copy got wrong. All three compose files point the
  // API at http://orchestrator:8788, and the copy predated single-label names
  // being accepted, so every internal call was answered with 421.
  assert.ok(hostAllowed("orchestrator:8788", []));
  assert.ok(hostAllowed("orchestrator", []));
});

test("loopback names and IP literals are answered without configuration", () => {
  for (const host of ["localhost:8788", "127.0.0.1:8788", "[::1]:8788"]) {
    assert.ok(hostAllowed(host, []), host);
  }
  assert.ok(hostAllowed("10.0.0.5:8788", []));
});

test("a public name still has to be allowlisted", () => {
  assert.ok(!hostAllowed("orchestrator.studio.example.test:8788", []));
  assert.ok(
    hostAllowed("orchestrator.studio.example.test:8788", [
      "orchestrator.studio.example.test",
    ]),
  );
});

test("the listen host is loopback until ORCHESTRATOR_BIND_HOST widens it", () => {
  const previous = process.env.ORCHESTRATOR_BIND_HOST;
  try {
    delete process.env.ORCHESTRATOR_BIND_HOST;
    assert.equal(listenHost("ORCHESTRATOR_BIND_HOST"), "127.0.0.1");
    process.env.ORCHESTRATOR_BIND_HOST = "0.0.0.0";
    assert.equal(listenHost("ORCHESTRATOR_BIND_HOST"), "0.0.0.0");
  } finally {
    if (previous === undefined) delete process.env.ORCHESTRATOR_BIND_HOST;
    else process.env.ORCHESTRATOR_BIND_HOST = previous;
  }
});
