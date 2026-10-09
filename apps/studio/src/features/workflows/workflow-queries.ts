import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import type {
  ActionPackage,
  WorkflowBundle,
  WorkflowRun,
  WorkflowSourceSummary,
} from "./workflow-graph-types";

export type WorkflowRunsPage = {
  runs: WorkflowRun[];
  totalCount: number;
  nextCursor: string | null;
};
export type RunFilters = {
  workflowTemplateId?: string;
  status?: string;
  search?: string;
  view?: string;
  cursor?: string;
  limit?: number;
};
export const workflowListOptions = () =>
  queryOptions({
    queryKey: ["/studio/workflows"],
    queryFn: ({ signal }) =>
      apiGet<{ workflows: WorkflowSourceSummary[] }>(
        "/studio/workflows",
        signal,
      ),
    staleTime: 30_000,
  });
export const workflowDefinitionOptions = (id: string) =>
  queryOptions({
    queryKey: ["/studio/workflows", id],
    queryFn: ({ signal }) =>
      apiGet<WorkflowBundle>(`/studio/workflows/${id}`, signal),
    staleTime: 30_000,
  });
export type WorkflowReferences = {
  callers: Array<{ id: string; name: string; historyOnly: boolean }>;
  fixtureCampaignIds: string[];
};
/** Workflows and fixture campaigns that would block deleting this workflow. */
export const workflowReferencesOptions = (id: string) =>
  queryOptions({
    queryKey: ["/studio/workflows", id, "references"],
    queryFn: ({ signal }) =>
      apiGet<WorkflowReferences>(`/studio/workflows/${id}/references`, signal),
  });
export const workflowActionsOptions = () =>
  queryOptions({
    queryKey: ["/studio/workflow-actions"],
    queryFn: ({ signal }) =>
      apiGet<{ actions: ActionPackage[] }>("/studio/workflow-actions", signal),
    staleTime: 60_000,
  });
export const workflowRunsOptions = (filters: RunFilters = {}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (value !== undefined && value !== "" && value !== "all")
      params.set(key, String(value));
  }
  const query = params.toString();
  return queryOptions({
    queryKey: ["/studio/workflow-runs", { query }],
    queryFn: ({ signal }) =>
      apiGet<WorkflowRunsPage>(
        `/studio/workflow-runs${query ? `?${query}` : ""}`,
        signal,
      ),
    staleTime: 5_000,
  });
};

/** One page at a time keeps large histories cheap to fetch and render. */
export function useWorkflowRunPage(filters: Omit<RunFilters, "cursor">) {
  const [search, setSearch] = useState(filters.search ?? "");
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setSearch(filters.search ?? ""),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [filters.search]);
  const filterKey = JSON.stringify({ ...filters, search });
  const [navigation, setNavigation] = useState<{
    key: string;
    cursors: (string | undefined)[];
  }>({ key: filterKey, cursors: [undefined] });
  const cursors =
    navigation.key === filterKey ? navigation.cursors : [undefined];
  const query = useQuery({
    ...workflowRunsOptions({ ...filters, search, cursor: cursors.at(-1) }),
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) =>
        ["running", "queued", "cancel_requested"].includes(run.status),
      )
        ? 2_000
        : false,
    refetchIntervalInBackground: false,
  });
  return {
    ...query,
    page: cursors.length,
    previous:
      cursors.length > 1
        ? () => setNavigation({ key: filterKey, cursors: cursors.slice(0, -1) })
        : undefined,
    next: query.data?.nextCursor
      ? () =>
          setNavigation({
            key: filterKey,
            cursors: [...cursors, query.data!.nextCursor!],
          })
      : undefined,
  };
}
