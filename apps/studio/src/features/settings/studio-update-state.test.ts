import assert from "node:assert/strict";
import test from "node:test";
import {
  imagePullStep,
  isActivePhase,
  isSessionEndedError,
  phaseProgress,
  studioUpdateView,
  updateNoticeVersion,
  type StudioUpdateCheckPayload,
  type StudioUpdateMode,
  type StudioUpdateStatusPayload,
} from "./studio-update-state";

const status = (
  mode: StudioUpdateMode,
  phase = "idle",
): StudioUpdateStatusPayload => ({
  mode,
  canApply: mode === "managed",
  installedVersion: "1.4.0",
  status: {
    operationId: phase === "idle" ? null : "op_1",
    operation: phase === "idle" ? null : "apply",
    phase,
    currentVersion: "1.4.0",
    targetVersion: phase === "idle" ? null : "1.5.0",
    previousVersion: null,
    message: null,
    error: null,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
  },
});

const check = (
  mode: StudioUpdateMode,
  updateAvailable = true,
): StudioUpdateCheckPayload => ({
  mode,
  channel: "nightly",
  installedVersion: "1.4.0",
  availableVersion: updateAvailable ? "1.5.0" : "1.4.0",
  updateAvailable,
  canApply: mode === "managed" && updateAvailable,
  publishedAt: null,
  releaseNotesUrl: null,
  requiresBackup: true,
});

const apiError = (code: string, statusCode: number) =>
  Object.assign(new Error(code), { code, statusCode });

test("managed with a newer release shows channel, versions, and Update", () => {
  const view = studioUpdateView({
    status: status("managed"),
    check: check("managed"),
  });
  assert.equal(view.kind, "visible");
  if (view.kind !== "visible") return;
  assert.equal(view.channel, "nightly");
  assert.equal(view.installedVersion, "1.4.0");
  assert.equal(view.availableVersion, "1.5.0");
  assert.equal(view.showUpdateButton, true);
  assert.equal(view.showNotifyOnlyNotice, false);
});

test("managed without a newer release shows no Update button", () => {
  const view = studioUpdateView({
    status: status("managed"),
    check: check("managed", false),
  });
  assert.equal(view.kind === "visible" && view.showUpdateButton, false);
  assert.equal(view.kind === "visible" && view.updateAvailable, false);
});

test("managed hides Update while an operation is running", () => {
  const view = studioUpdateView({
    status: status("managed", "pulling"),
    check: check("managed"),
  });
  assert.equal(view.kind === "visible" && view.showUpdateButton, false);
});

test("Update never appears before the check has answered", () => {
  const view = studioUpdateView({ status: status("managed") });
  assert.equal(view.kind === "visible" && view.showUpdateButton, false);
});

test("notify-only signals the new version without an install button", () => {
  const view = studioUpdateView({
    status: status("notify-only"),
    check: check("notify-only"),
  });
  assert.equal(view.kind, "visible");
  if (view.kind !== "visible") return;
  assert.equal(view.showUpdateButton, false);
  assert.equal(view.showNotifyOnlyNotice, true);
  assert.equal(view.availableVersion, "1.5.0");

  const current = studioUpdateView({
    status: status("notify-only"),
    check: check("notify-only", false),
  });
  assert.equal(
    current.kind === "visible" && current.showNotifyOnlyNotice,
    false,
  );
});

test("disabled hides the whole feature", () => {
  const disabled = apiError("updates_disabled", 404);
  assert.deepEqual(
    studioUpdateView({ statusError: disabled, checkError: disabled }),
    { kind: "hidden" },
  );
  assert.deepEqual(studioUpdateView({ statusError: disabled }), {
    kind: "hidden",
  });
});

test("updater errors keep the panel visible so they can be reported", () => {
  const view = studioUpdateView({
    statusError: apiError("updater_unavailable", 503),
    checkError: apiError("updater_check_failed", 502),
  });
  assert.equal(view.kind, "visible");
  assert.equal(view.kind === "visible" && view.showUpdateButton, false);
});

test("progress follows the updater phases", () => {
  assert.equal(isActivePhase("idle"), false);
  assert.equal(isActivePhase("deploying"), true);
  assert.equal(isActivePhase("failed"), false);
  const pulling = phaseProgress("pulling")!;
  const verifying = phaseProgress("verifying")!;
  assert.ok(pulling > 0 && pulling < verifying && verifying < 1);
  assert.equal(phaseProgress("succeeded"), 1);
  assert.equal(phaseProgress("rolling_back"), null);
});

test("the update notice announces a newer release until it is dismissed", () => {
  assert.equal(updateNoticeVersion(check("managed"), null), "1.5.0");
  assert.equal(updateNoticeVersion(check("notify-only"), null), "1.5.0");
  assert.equal(updateNoticeVersion(check("managed"), "1.5.0"), null);
  // Dismissing an older release does not silence a newer one.
  assert.equal(updateNoticeVersion(check("managed"), "1.4.5"), "1.5.0");
  assert.equal(updateNoticeVersion(check("managed", false), null), null);
  assert.equal(updateNoticeVersion(check("disabled"), null), null);
  assert.equal(updateNoticeVersion(undefined, null), null);
});

test("the bar advances image by image while pulling", () => {
  assert.deepEqual(imagePullStep("Pulling image 3/7: api"), {
    current: 3,
    total: 7,
  });
  assert.equal(imagePullStep("Validating Docker Compose"), null);
  assert.equal(imagePullStep("Pulling image 9/7: api"), null);

  const steps = [
    phaseProgress("validating", "Validating Docker Compose")!,
    ...[1, 2, 3, 4, 5, 6, 7].map(
      (image) => phaseProgress("pulling", `Pulling image ${image}/7: api`)!,
    ),
    phaseProgress("backing_up", "Backing up PostgreSQL")!,
  ];
  for (let index = 1; index < steps.length; index += 1) {
    assert.ok(steps[index - 1]! < steps[index]!, `step ${index} advances`);
  }
  // Without a recognisable message, pulling sits mid-phase.
  const unknown = phaseProgress("pulling", null)!;
  assert.ok(steps[1]! < unknown && unknown < steps[7]!);
});

test("a 401 means the restart ended the session, not that Studio is still restarting", () => {
  assert.equal(
    isSessionEndedError({ statusCode: 401, code: "studio_session_required" }),
    true,
  );
  assert.equal(isSessionEndedError({ statusCode: 502 }), false);
  assert.equal(isSessionEndedError(new TypeError("Failed to fetch")), false);
  assert.equal(isSessionEndedError(null), false);
});
