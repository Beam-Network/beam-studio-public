import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiFetch } from "./api-client";
import {
  canNestWorkflow,
  parseWorkflowCollapse,
  workflowAncestors,
  workflowParents,
  workflowTreeRows,
} from "./sidebar-workflow-hierarchy";

export function useSidebarWorkflowHierarchy<
  T extends {
    id: string;
    name?: string | null;
    sidebarParentId?: string | null;
  },
>(
  workflows: T[],
  query: string,
  activeId: string | null,
  scope: string | null,
) {
  const cache = useQueryClient();
  const key = scope
    ? `beam-studio.sidebar.workflow-collapse.v1:${scope}`
    : null;
  const [stored, setStored] = useState<{
    key: string | null;
    collapsed: string[];
  }>({ key: null, collapsed: [] });
  const [message, setMessage] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const ids = new Set(workflows.map((workflow) => workflow.id));
  const parents = workflowParents(
    ids,
    Object.fromEntries(
      workflows.flatMap((workflow) =>
        workflow.sidebarParentId
          ? [[workflow.id, workflow.sidebarParentId]]
          : [],
      ),
    ),
  );
  const collapsed = stored.key === key ? stored.collapsed : [];
  const hierarchy = { parents, collapsed };
  useEffect(() => {
    let collapsed: string[] = [];
    try {
      if (key) collapsed = parseWorkflowCollapse(localStorage.getItem(key));
    } catch {
      /* Collapse is only a display preference. */
    }
    setStored({ key, collapsed });
    setMessage("");
    setDraggingId(null);
    setDropTarget(null);
    const sync = (event: StorageEvent) => {
      if (event.key === key)
        setStored({ key, collapsed: parseWorkflowCollapse(event.newValue) });
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);
  const ancestorKey = activeId
    ? JSON.stringify(workflowAncestors(activeId, parents))
    : "[]";
  useEffect(() => {
    const ancestors = new Set<string>(JSON.parse(ancestorKey));
    if (ancestors.size)
      setStored((current) => ({
        ...current,
        collapsed: current.collapsed.filter((id) => !ancestors.has(id)),
      }));
  }, [activeId, ancestorKey]);
  const saveCollapse = (collapsed: string[]) => {
    setStored({ key, collapsed });
    try {
      if (key) localStorage.setItem(key, JSON.stringify(collapsed));
    } catch {
      /* Session-only display preference. */
    }
  };
  const moveMutation = useMutation({
    mutationFn: ({
      childId,
      parentId,
    }: {
      childId: string;
      parentId: string | null;
    }) =>
      apiFetch<{ id: string; sidebarParentId: string | null }>(
        `/studio/workflows/${encodeURIComponent(childId)}/sidebar-parent`,
        { method: "PATCH", body: JSON.stringify({ parentId }) },
      ),
    onMutate: () => setMessage("Saving workflow location…"),
    onSuccess: async (saved) => {
      await cache.cancelQueries({
        queryKey: ["/studio/workflows"],
        exact: true,
      });
      cache.setQueryData<{ workflows: T[] }>(
        ["/studio/workflows"],
        (current) =>
          current && {
            ...current,
            workflows: current.workflows.map((workflow) =>
              workflow.id === saved.id
                ? { ...workflow, sidebarParentId: saved.sidebarParentId }
                : workflow,
            ),
          },
      );
      saveCollapse(collapsed.filter((id) => id !== saved.sidebarParentId));
      setMessage("Workflow location saved.");
      await cache.invalidateQueries({
        queryKey: ["/studio/workflows"],
        exact: true,
      });
    },
    onError: (error) =>
      setMessage(`Unable to save workflow location: ${error.message}`),
  });
  const canMove = (childId: string, parentId: string | null) =>
    Boolean(scope) &&
    !moveMutation.isPending &&
    canNestWorkflow(ids, parents, childId, parentId);
  return {
    rows: workflowTreeRows(workflows, hierarchy, query),
    saveError: moveMutation.isError,
    parents,
    message,
    draggingId,
    dropTarget,
    setDraggingId,
    setDropTarget,
    canMove,
    move(childId: string, parentId: string | null) {
      if (!canMove(childId, parentId)) return;
      moveMutation.mutate({ childId, parentId });
      setDraggingId(null);
      setDropTarget(null);
    },
    toggle(id: string) {
      saveCollapse(
        collapsed.includes(id)
          ? collapsed.filter((value) => value !== id)
          : [...collapsed, id],
      );
    },
  };
}
