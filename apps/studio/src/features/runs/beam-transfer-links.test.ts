import assert from "node:assert/strict";
import test from "node:test";
import {
  beamTransferLinks,
  consoleTransferUrl,
  type ExecutionStep,
} from "./run-detail-data";

function step(overrides: Partial<ExecutionStep>): ExecutionStep {
  return {
    id: "wsr_1",
    workflowStepId: "wfs_1",
    actionPackageName: "@beam/transfer",
    name: "Beam Transfer",
    order: 0,
    status: "completed",
    ...overrides,
  };
}

test("a Beam Transfer step links its transfer in the Console", () => {
  assert.deepEqual(
    beamTransferLinks(
      [
        step({
          run: {
            id: "wsr_1",
            output: { beamTransferId: "f7ea054c-1111-2222-3333-444455556666" },
          },
        }),
      ],
      "https://console.b1m.ai",
    ),
    [
      {
        stepRunId: "wsr_1",
        stepName: "Beam Transfer",
        status: "completed",
        transferId: "f7ea054c-1111-2222-3333-444455556666",
        consoleHref:
          "https://console.b1m.ai/transfers/f7ea054c-1111-2222-3333-444455556666",
      },
    ],
  );
});

test("the action's external reference names the transfer too", () => {
  const [link] = beamTransferLinks(
    [step({ run: { id: "wsr_1", externalRef: "transfer-ref" } })],
    null,
  );
  assert.equal(link?.transferId, "transfer-ref");
  assert.equal(link?.consoleHref, null);
});

test("other steps and steps without a transfer are not linked", () => {
  assert.deepEqual(
    beamTransferLinks(
      [
        step({ run: { id: "wsr_1", output: { id: "not-a-transfer" } } }),
        step({
          actionPackageName: "@beam/object-storage-endpoint",
          run: { id: "wsr_2", output: { beamTransferId: "x" } },
        }),
        step({ run: undefined }),
      ],
      "https://console.b1m.ai",
    ),
    [],
  );
});

test("the Console URL keeps its base path and escapes the id", () => {
  assert.equal(
    consoleTransferUrl("https://example.com/console", "a/b"),
    "https://example.com/console/transfers/a%2Fb",
  );
  assert.equal(consoleTransferUrl("not a url", "a"), null);
});
