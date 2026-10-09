import assert from "node:assert/strict";
import test from "node:test";
import {
  actionDisabledReason,
  canRunAction,
  workflowExecutionKeyRepair,
  failureDetails,
  type RunAction,
} from "./run-detail-data";

const retry: RunAction = {
  label: "Retry",
  method: "POST",
  path: () => "/retry",
};

test("missing frozen execution keys offer repair instead of retry for terminal workflow runs", () => {
  for (const status of ["cancelled", "failed", "dead_letter"]) {
    const run = {
      workflowTemplateId: "workflow",
      status,
      error:
        "execution_credential_missing: The frozen run has no execution credential.",
    };
    assert.equal(workflowExecutionKeyRepair(run), true);
    assert.equal(canRunAction(retry, status, [], run), false);
    const failure = failureDetails(run, [], [], []);
    assert.ok(failure);
    assert.equal(failure.action?.href, "/workflows/workflow/settings");
    assert.doesNotMatch(
      failure.message,
      /execution_credential_missing|frozen/i,
    );
    assert.match(
      actionDisabledReason(retry, status, [], run)!,
      /Settings.*new run/,
    );
  }
});

test("unrelated failures and successful runs do not get missing-key repair", () => {
  for (const run of [
    {
      workflowTemplateId: "workflow",
      status: "completed",
      error: "execution_credential_missing",
    },
    {
      workflowTemplateId: "workflow",
      status: "cancelled",
      error: "execution_credential_revoked",
    },
    {
      workflowTemplateId: "workflow",
      status: "failed",
      error: "Unexpected execution_credential_missing text",
    },
    { status: "cancelled", error: "execution_credential_missing" },
  ])
    assert.equal(workflowExecutionKeyRepair(run), false);
  assert.equal(
    canRunAction(retry, "failed", [], {
      status: "failed",
      error: "provider_unavailable",
    }),
    true,
  );
});

test("an authorization refusal shows its customer message without the code", () => {
  const failure = failureDetails(
    {
      workflowTemplateId: "workflow",
      status: "cancelled",
      error:
        "execution_insufficient_credit: Your organization doesn't have enough credits to start this run. Add credits in the Console, then run it again.",
    },
    [],
    [],
    [],
  );
  assert.equal(
    failure?.message,
    "Your organization doesn't have enough credits to start this run. Add credits in the Console, then run it again.",
  );
});

test("a failed Beam transfer shows Beam's error message verbatim", () => {
  const accessDenied =
    "destination_access_denied: The destination storage refused Beam's requests (403 AccessDenied). Check that the credentials allow writes to this bucket and path and are not restricted to specific IP addresses or networks.";
  const stepError = `Beam transfer failed: ${accessDenied}.`;
  const step = {
    id: "wsr_transfer",
    workflowStepId: "wfs_transfer",
    actionPackageName: "@beam/transfer",
    name: "Beam Transfer",
    order: 2,
    status: "failed",
    error: stepError,
  };
  for (const run of [
    { workflowTemplateId: "workflow", status: "failed", error: stepError },
    { workflowTemplateId: "workflow", status: "failed", error: null },
  ]) {
    const failure = failureDetails(run, [step], [], []);
    assert.equal(failure?.message, stepError);
    assert.equal(failure?.stepRunId, "wsr_transfer");
  }
  assert.equal(
    failureDetails(
      { workflowTemplateId: "workflow", status: "failed", error: accessDenied },
      [],
      [],
      [],
    )?.message,
    accessDenied,
  );
});
