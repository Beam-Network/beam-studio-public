import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareActionVersions,
  latestActionPackagesByName,
} from "./action-versions.js";

test("compares semantic action versions", () => {
  assert.equal(compareActionVersions("2.0.0", "1.9.9") > 0, true);
  assert.equal(compareActionVersions("1.10.0", "1.9.0") > 0, true);
  assert.equal(compareActionVersions("1.0.0", "1.0.0"), 0);
});

test("selects latest action packages independent of query order", () => {
  const actions = [
    { name: "@beam/room-transfer", version: "2.0.0" },
    { name: "@beam/room-transfer", version: "1.0.0" },
  ];
  assert.equal(
    latestActionPackagesByName(actions).get("@beam/room-transfer")?.version,
    "2.0.0",
  );
  assert.equal(
    latestActionPackagesByName([...actions].reverse()).get(
      "@beam/room-transfer",
    )?.version,
    "2.0.0",
  );
});
