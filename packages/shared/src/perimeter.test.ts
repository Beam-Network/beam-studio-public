import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedHostnames,
  hostAllowed,
  hostnameOf,
  isIpLiteral,
  isLoopbackHost,
  listenHost,
} from "./perimeter.js";

test("a service binds loopback unless told otherwise", () => {
  delete process.env.TEST_BIND_HOST;
  assert.equal(listenHost("TEST_BIND_HOST"), "127.0.0.1");
  process.env.TEST_BIND_HOST = "  ";
  assert.equal(
    listenHost("TEST_BIND_HOST"),
    "127.0.0.1",
    "blank is not a bind",
  );
  process.env.TEST_BIND_HOST = "0.0.0.0";
  assert.equal(listenHost("TEST_BIND_HOST"), "0.0.0.0");
  delete process.env.TEST_BIND_HOST;
  // Studio is the one service that faces the network by default.
  assert.equal(listenHost("TEST_BIND_HOST", "0.0.0.0"), "0.0.0.0");
});

test("the port is stripped from a Host header", () => {
  assert.equal(hostnameOf("studio.example.com:3004"), "studio.example.com");
  assert.equal(hostnameOf("studio.example.com"), "studio.example.com");
  assert.equal(hostnameOf("[::1]:3004"), "[::1]");
  assert.equal(hostnameOf("STUDIO.Example.COM"), "studio.example.com");
  assert.equal(hostnameOf(undefined), "");
});

test("IP literals are recognised", () => {
  assert.ok(isIpLiteral("203.0.113.9"));
  assert.ok(isIpLiteral("[::1]"));
  assert.ok(!isIpLiteral("studio.example.com"));
  assert.ok(!isIpLiteral("203.0.113.9.example.com"));
});

test("loopback names are recognised", () => {
  for (const name of ["localhost", "127.0.0.1", "::1", "LOCALHOST"]) {
    assert.ok(isLoopbackHost(name), name);
  }
  assert.ok(!isLoopbackHost("studio.example.com"));
});

test("an unconfigured install still answers on its own IP and loopback", () => {
  // The common client install is reached at http://<vps-ip>:3004 with nothing
  // configured, and an IP Host cannot be produced by DNS rebinding.
  for (const host of ["203.0.113.9:3004", "127.0.0.1:3004", "localhost:3004"]) {
    assert.ok(hostAllowed(host, []), host);
  }
});

test("services reach each other by container name with nothing configured", () => {
  // Regression: the guard shipped rejecting these, which returned 421 for
  // every internal call in a Compose install — the Studio proxy to the API,
  // the worker to the API, anything to the orchestrator.
  for (const host of [
    "api",
    "api:8787",
    "orchestrator:8788",
    "mcp:8766",
    "postgres:5432",
  ]) {
    assert.ok(hostAllowed(host, []), host);
  }
});

test("a single label is accepted but a dotted name still is not", () => {
  // A single label has no public TLD, so a remote attacker cannot make a
  // browser resolve it. A registrable domain is exactly the rebinding case.
  assert.ok(hostAllowed("studio", []));
  assert.ok(!hostAllowed("studio.evil.com", []));
  assert.ok(!hostAllowed("evil.com", []));
});

test("an unlisted name is refused, which is the rebinding case", () => {
  assert.ok(!hostAllowed("evil.example.com", []));
  assert.ok(!hostAllowed("evil.example.com", ["studio.example.com"]));
  assert.ok(hostAllowed("studio.example.com", ["studio.example.com"]));
  assert.ok(hostAllowed("STUDIO.example.com:3004", ["studio.example.com"]));
});

test("a missing Host is refused", () => {
  assert.ok(!hostAllowed(undefined, ["studio.example.com"]));
  assert.ok(!hostAllowed("", ["studio.example.com"]));
});

test("the allowlist is parsed leniently but matched exactly", () => {
  assert.deepEqual(allowedHostnames(" a.example.com , B.example.com ,, "), [
    "a.example.com",
    "b.example.com",
  ]);
  assert.deepEqual(allowedHostnames(undefined), []);
  // A suffix must not be enough: trusting one would trust every subdomain an
  // attacker can create under it.
  assert.ok(!hostAllowed("evil.a.example.com", ["a.example.com"]));
});
