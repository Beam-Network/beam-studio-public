import assert from "node:assert/strict";
import test from "node:test";
import { roomTransferRetryUnavailableReason as reason } from "./room-transfer-retry.js";

const step = (state: Record<string, unknown>) => ({
  actionPackageName: "@beam/room-transfer",
  status: "failed",
  state,
});

test("terminal failures and cancellation tombstones require a new Run", () => {
  for (const beamStatus of ["failed", "cancelled", "expired"]) {
    assert.match(
      reason([step({ publicationId: "publication", beamStatus })])!,
      /Run the workflow again/,
    );
  }
  for (const cancellationStatus of ["pending", "confirmed", "unresolved"]) {
    assert.match(
      reason([step({ publishRequested: true, cancellationStatus })])!,
      /Run the workflow again/,
    );
  }
});

test("transient reconnects and failures before publication remain retryable", () => {
  assert.equal(
    reason([
      step({
        publicationId: "publication",
        beamStatus: "in_progress",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    ]),
    undefined,
  );
  for (const beamStatus of ["completed", "partial"]) {
    assert.equal(reason([step({ publicationId: "publication", beamStatus, expiresAt: "2030-01-01T00:00:00Z" })]), undefined);
  }
  assert.equal(reason([step({})]), undefined);
  assert.equal(reason([step({ cancellationStatus: "confirmed" })]), undefined);
});

test("expiry uses the original publication deadline", () => {
  const expiresAt = "2026-09-16T22:44:00Z";
  const bound = step({
    publicationId: "publication",
    beamStatus: "in_progress",
    expiresAt,
  });
  assert.equal(reason([bound], Date.parse(expiresAt) - 1), undefined);
  assert.match(reason([bound], Date.parse(expiresAt))!, /expired/);
});

test("completed calls and other action types never block a frozen retry", () => {
  const terminal = step({
    publicationId: "publication",
    beamStatus: "cancelled",
  });
  assert.equal(reason([{ ...terminal, status: "completed" }]), undefined);
  assert.equal(
    reason([{ ...terminal, actionPackageName: "@beam/transfer" }]),
    undefined,
  );
  assert.equal(
    reason([{ ...terminal, actionPackageName: undefined }]),
    undefined,
  );
});
