import assert from "node:assert/strict";
import test from "node:test";
import type { StudioSession } from "../auth/session.js";
import {
  authorizeUpdateOperation,
  updateCapabilities,
  updateModeFromEnv,
  type UpdateMode,
  type UpdateOperation,
} from "./update-policy.js";

const session = (
  platformRole: StudioSession["platformRole"],
): StudioSession => ({ type: "account", userId: "user_1", platformRole });

const admin = session("ADMIN");
const superAdmin = session("SUPERADMIN");
const member = session("USER");

test("an unrecognised mode fails closed rather than managing the host", () => {
  assert.equal(updateModeFromEnv(undefined), "managed");
  assert.equal(updateModeFromEnv("  "), "managed");
  assert.equal(updateModeFromEnv("managed"), "managed");
  assert.equal(updateModeFromEnv("notify-only"), "notify-only");
  assert.equal(updateModeFromEnv("disabled"), "disabled");
  // A typo is a configuration mistake. Reading it as "manage this host anyway"
  // is the one interpretation that could install software nobody asked for.
  for (const wrong of ["Managed", "notify_only", "enabled", "true", "off"]) {
    assert.equal(updateModeFromEnv(wrong), "disabled", wrong);
  }
});

test("a disabled installation exposes no update surface at all", () => {
  for (const operation of [
    "status",
    "check",
    "apply",
    "rollback",
  ] as UpdateOperation[]) {
    const decision = authorizeUpdateOperation({
      mode: "disabled",
      operation,
      session: superAdmin,
    });
    assert.equal(decision.allowed, false, operation);
    assert.equal(
      decision.allowed === false && decision.code,
      "updates_disabled",
    );
    // 404 rather than 403: the surface does not exist here, and saying so
    // avoids advertising an endpoint this deployment never serves.
    assert.equal(decision.allowed === false && decision.statusCode, 404);
  }
});

test("notify-only reports releases but refuses to install them", () => {
  for (const operation of ["status", "check"] as UpdateOperation[]) {
    assert.equal(
      authorizeUpdateOperation({
        mode: "notify-only",
        operation,
        session: member,
      }).allowed,
      true,
      operation,
    );
  }
  for (const operation of ["apply", "rollback"] as UpdateOperation[]) {
    const decision = authorizeUpdateOperation({
      mode: "notify-only",
      operation,
      session: superAdmin,
    });
    assert.equal(decision.allowed, false, operation);
    assert.equal(
      decision.allowed === false && decision.code,
      "updates_notify_only",
    );
  }
});

test("mode is decided before identity", () => {
  // An administrator must not be able to talk a notify-only host into an
  // update its operator deliberately withheld.
  const decision = authorizeUpdateOperation({
    mode: "notify-only",
    operation: "apply",
    session: superAdmin,
  });
  assert.equal(
    decision.allowed === false && decision.code,
    "updates_notify_only",
  );
});

test("any signed-in user may install a release on a managed host", () => {
  // No role condition: explicit confirmation happens in the browser, and the
  // updater only installs a newer signed release.
  for (const operation of ["apply", "rollback"] as UpdateOperation[]) {
    for (const account of [member, admin, superAdmin]) {
      assert.equal(
        authorizeUpdateOperation({
          mode: "managed",
          operation,
          session: account,
        }).allowed,
        true,
        `${account.platformRole} ${operation}`,
      );
    }
    const anonymous = authorizeUpdateOperation({
      mode: "managed",
      operation,
      session: null,
    });
    assert.equal(anonymous.allowed, false, `anonymous ${operation}`);
    assert.equal(anonymous.allowed === false && anonymous.statusCode, 401);
  }
});

test("an anonymous caller cannot even read update status", () => {
  const decision = authorizeUpdateOperation({
    mode: "managed",
    operation: "status",
    session: null,
  });
  assert.equal(decision.allowed, false);
  assert.equal(
    decision.allowed === false && decision.statusCode,
    401,
  );
});

test("a member may read status on a managed installation", () => {
  assert.equal(
    authorizeUpdateOperation({
      mode: "managed",
      operation: "status",
      session: member,
    }).allowed,
    true,
  );
});

test("capabilities describe what each mode needs", () => {
  assert.deepEqual(updateCapabilities("managed"), {
    mode: "managed",
    checksReleases: true,
    canApply: true,
    requiresUpdaterSocket: true,
  });
  // Release checks are verified by the updater, so notify-only still reads
  // through its socket; it simply never mutates.
  assert.deepEqual(updateCapabilities("notify-only"), {
    mode: "notify-only",
    checksReleases: true,
    canApply: false,
    requiresUpdaterSocket: true,
  });
  // A disabled installation needs no updater service or socket at all.
  assert.deepEqual(updateCapabilities("disabled" as UpdateMode), {
    mode: "disabled",
    checksReleases: false,
    canApply: false,
    requiresUpdaterSocket: false,
  });
});
