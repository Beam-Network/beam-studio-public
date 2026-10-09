import assert from "node:assert/strict";
import test from "node:test";
import { actionDisabledReason, canRunAction, type RunAction } from "./run-detail-data";

const retry: RunAction = { label: "Retry", method: "POST", path: () => "/retry" };
const room = {
  actionPackageName: "@beam/room-transfer", status: "cancelled",
  state: { publicationId: "publication", beamStatus: "cancelled" },
};

test("a terminal room retry is disabled with actionable Run-again guidance", () => {
  assert.equal(canRunAction(retry, "cancelled", [room]), false);
  assert.match(actionDisabledReason(retry, "cancelled", [room])!, /Run the workflow again/);
});

test("normal action retries and active room reconnects stay available", () => {
  assert.equal(canRunAction(retry, "failed", [{ ...room, actionPackageName: "@beam/transfer" }]), true);
  assert.equal(canRunAction(retry, "failed", [{ ...room, state: { publicationId: "publication", beamStatus: "in_progress" } }]), true);
  assert.equal(canRunAction(retry, "failed", []), true);
});

test("running workflows cannot be retried and terminal room state does not disable Cancel", () => {
  assert.equal(canRunAction(retry, "running", []), false);
  assert.equal(canRunAction({ ...retry, label: "Cancel" }, "running", [room]), true);
});
