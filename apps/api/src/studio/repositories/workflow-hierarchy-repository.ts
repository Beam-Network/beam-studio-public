import { withPostgresTransaction, type PgPool } from "@beam-studio/db";
import type { OrganizationScope } from "./organization-scope.js";

function invalid(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode, expose: true });
}

/** Visual folder relationships never alter executable graph or run snapshots. */
export class WorkflowHierarchyRepository {
  constructor(private readonly pool: PgPool) {}

  async move(
    scope: OrganizationScope,
    childId: string,
    parentId: string | null,
    projectId?: string | null,
  ) {
    if (childId === parentId)
      throw invalid("A workflow cannot contain itself.", 400);
    return withPostgresTransaction(this.pool, async (client) => {
      // Lock the whole organization graph before reading it: concurrent opposite
      // moves must not both validate against the same old tree and create a cycle.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`workflow-sidebar:${scope.organizationId}`],
      );
      const ids = parentId ? [childId, parentId] : [childId];
      const accessible = await client.query(
        `SELECT id FROM workflow.templates WHERE id=ANY($1::text[])
         AND organization_id=$2 AND ($3='' OR project_id=$3)
         ORDER BY id FOR KEY SHARE`,
        [ids, scope.organizationId, projectId ?? ""],
      );
      if (accessible.rowCount !== ids.length)
        throw invalid(
          "Workflow not found in the selected organization or project.",
          404,
        );
      if (parentId) {
        const cycle = await client.query(
          `WITH RECURSIVE ancestors(id) AS (
            SELECT $1::text UNION
            SELECT h.parent_id FROM workflow.sidebar_hierarchy h
            JOIN ancestors a ON h.child_id=a.id
          ) SELECT 1 FROM ancestors WHERE id=$2`,
          [parentId, childId],
        );
        if (cycle.rowCount)
          throw invalid(
            "This move would create a workflow hierarchy cycle.",
            409,
          );
        await client.query(
          `INSERT INTO workflow.sidebar_hierarchy(child_id,parent_id) VALUES($1,$2)
           ON CONFLICT(child_id) DO UPDATE SET parent_id=EXCLUDED.parent_id`,
          [childId, parentId],
        );
      } else {
        await client.query(
          "DELETE FROM workflow.sidebar_hierarchy WHERE child_id=$1",
          [childId],
        );
      }
      return { id: childId, sidebarParentId: parentId };
    });
  }
}
