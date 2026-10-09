import assert from "node:assert/strict";
import test from "node:test";
import { beamCliBinary, isDevRoomTemplate } from "./beam-environments.js";

test("the join command names the CLI built for the room's environment", () => {
  // Each channel is compiled against its own coordinator, so naming the
  // production binary for a DEV room hands the recipient a command that
  // cannot find the room.
  assert.equal(beamCliBinary("dev"), "beam-dev");
  assert.equal(beamCliBinary(" dev "), "beam-dev");
  assert.equal(beamCliBinary("prod"), "beam");
  // An unset or custom template falls back to the production default, which is
  // what defaultBeamEnvironmentTemplateKey already is.
  assert.equal(beamCliBinary(""), "beam");
  assert.equal(beamCliBinary("customer-staging"), "beam");
});

test("only the dev template is reported as a development room", () => {
  assert.equal(isDevRoomTemplate("dev"), true);
  assert.equal(isDevRoomTemplate("prod"), false);
  assert.equal(isDevRoomTemplate(""), false);
});
