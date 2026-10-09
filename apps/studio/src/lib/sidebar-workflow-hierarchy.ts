import { filterSidebarWorkflows } from "./sidebar-workflow-search";

export type WorkflowHierarchy = {
  parents: Record<string, string>;
  collapsed: string[];
};
export const emptyWorkflowHierarchy = (): WorkflowHierarchy => ({
  parents: {},
  collapsed: [],
});

export function parseWorkflowCollapse(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? "null");
    return Array.isArray(parsed)
      ? parsed.filter((id: unknown): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function canNestWorkflow(
  ids: Set<string>,
  parents: Record<string, string>,
  childId: string,
  parentId: string | null,
): boolean {
  if (!ids.has(childId) || (parentId !== null && !ids.has(parentId)))
    return false;
  const visited = new Set([childId]);
  let current = parentId;
  while (current) {
    if (visited.has(current)) return false;
    visited.add(current);
    current = parents[current] ?? null;
  }
  return true;
}

/** Ignore missing parents and corrupt cycles so every accessible workflow stays visible. */
export function workflowParents(
  ids: Set<string>,
  parents: Record<string, string>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [child, parent] of Object.entries(parents)) {
    if (canNestWorkflow(ids, safe, child, parent)) safe[child] = parent;
  }
  return safe;
}

export function workflowAncestors(
  id: string,
  parents: Record<string, string>,
): string[] {
  const ancestors: string[] = [];
  const visited = new Set([id]);
  let parent = parents[id];
  while (parent && !visited.has(parent)) {
    ancestors.push(parent);
    visited.add(parent);
    parent = parents[parent];
  }
  return ancestors;
}

export function workflowTreeRows<
  T extends { id: string; name?: string | null },
>(workflows: T[], hierarchy: WorkflowHierarchy, query: string) {
  const ids = new Set(workflows.map((workflow) => workflow.id));
  const parents = workflowParents(ids, hierarchy.parents);
  const children = new Map<string | null, T[]>();
  for (const workflow of workflows) {
    const parent = parents[workflow.id] ?? null;
    children.set(parent, [...(children.get(parent) ?? []), workflow]);
  }
  const searching = Boolean(query.trim());
  const matches = new Set(
    filterSidebarWorkflows({ workflows, query }).map((workflow) => workflow.id),
  );
  const visible = new Set(matches);
  if (searching) {
    for (const workflow of workflows) {
      const ancestors = workflowAncestors(workflow.id, parents);
      if (matches.has(workflow.id) || ancestors.some((id) => matches.has(id))) {
        visible.add(workflow.id);
        ancestors.forEach((id) => visible.add(id));
      }
    }
  }
  const collapsed = new Set(hierarchy.collapsed);
  const rows: {
    workflow: T;
    depth: number;
    hasChildren: boolean;
    expanded: boolean;
  }[] = [];
  const pending = (children.get(null) ?? [])
    .map((workflow) => ({ workflow, depth: 0 }))
    .reverse();
  while (pending.length) {
    const { workflow, depth } = pending.pop()!;
    if (searching && !visible.has(workflow.id)) continue;
    const descendants = children.get(workflow.id) ?? [];
    const expanded = searching || !collapsed.has(workflow.id);
    rows.push({
      workflow,
      depth,
      hasChildren: descendants.length > 0,
      expanded,
    });
    if (expanded)
      for (let i = descendants.length - 1; i >= 0; i--)
        pending.push({ workflow: descendants[i]!, depth: depth + 1 });
  }
  return rows;
}
