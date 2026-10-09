import type { QueryClient } from "@tanstack/react-query";

/**
 * Leave a workflow that was just deleted and return to the workflow list.
 *
 * The editor guards against leaving with unsaved changes, and flushes pending
 * node positions before any navigation. Once the workflow is gone neither has
 * anything left to save to: the prompt would hold the redirect back, and the
 * editor would refetch the deleted workflow and render "Workflow not found".
 * So the redirect ignores those blockers, and the deleted workflow's cached
 * queries are dropped only once the editor has unmounted, so nothing refetches
 * them. Ordinary navigation away from a dirty editor is still guarded.
 */
export async function leaveDeletedWorkflow({
  workflowId,
  queryClient,
  navigate,
}: {
  workflowId: string;
  queryClient: Pick<QueryClient, "removeQueries" | "invalidateQueries">;
  navigate(options: { to: string; ignoreBlocker: true }): unknown;
}) {
  await navigate({ to: "/workflows", ignoreBlocker: true });
  queryClient.removeQueries({ queryKey: ["/studio/workflows", workflowId] });
  await queryClient.invalidateQueries({ queryKey: ["/studio/workflows"] });
}
