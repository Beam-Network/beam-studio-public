import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { leaveDeletedWorkflow } from "./workflow-deletion";

test("a deleted workflow returns to the list past the unsaved-changes guard", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["/studio/workflows", "wf_deleted"], {
    template: { id: "wf_deleted" },
  });
  queryClient.setQueryData(["/studio/workflows", "wf_other"], {
    template: { id: "wf_other" },
  });
  queryClient.setQueryData(["/studio/workflows"], { workflows: [] });

  const events: string[] = [];
  const navigations: unknown[] = [];
  await leaveDeletedWorkflow({
    workflowId: "wf_deleted",
    queryClient,
    navigate: async (options) => {
      navigations.push(options);
      // The editor is still mounted while the redirect runs: its workflow must
      // not have been dropped yet, or it would refetch and render not found.
      events.push(
        queryClient.getQueryData(["/studio/workflows", "wf_deleted"])
          ? "navigated with workflow cached"
          : "navigated after workflow dropped",
      );
    },
  });

  // Only this redirect bypasses the guard; ordinary navigation still asks.
  assert.deepEqual(navigations, [{ to: "/workflows", ignoreBlocker: true }]);
  assert.deepEqual(events, ["navigated with workflow cached"]);
  assert.equal(
    queryClient.getQueryData(["/studio/workflows", "wf_deleted"]),
    undefined,
  );
  assert.ok(queryClient.getQueryData(["/studio/workflows", "wf_other"]));
  assert.equal(
    queryClient.getQueryState(["/studio/workflows"])?.isInvalidated,
    true,
  );
  queryClient.clear();
});
