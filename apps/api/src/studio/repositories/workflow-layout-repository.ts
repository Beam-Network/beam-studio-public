import {
  withPostgresTransaction,
  type PgClient,
  type PgPool,
} from "@beam-studio/db";
import {
  workflowLayoutPatchSchema,
  type WorkflowLayout,
  type WorkflowLayoutPatch,
  type WorkflowLayoutPosition,
} from "@beam-studio/shared";
import type { OrganizationScope } from "./organization-scope.js";

type Control = {
  id: string;
  fanInId?: string;
  layout?: Record<string, number>;
};
export function layoutError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode, expose: true });
}

/** Coordinate-only access; no definition assembly, action resolution or run capture. */
export class WorkflowLayoutRepository {
  constructor(private readonly pool: PgPool) {}

  async revision(scope: OrganizationScope, workflowId: string) {
    const result = await this.pool.query<{ layout_revision: number }>(
      "SELECT layout_revision FROM workflow.templates WHERE id=$1 AND organization_id=$2",
      [workflowId, scope.organizationId],
    );
    if (!result.rows[0])
      throw layoutError("workflow_not_found", "Workflow not found.", 404);
    return result.rows[0].layout_revision;
  }

  async read(
    scope: OrganizationScope,
    workflowId: string,
  ): Promise<WorkflowLayout> {
    const result = await this.pool.query<{
      revision: number;
      positions: WorkflowLayoutPosition[];
    }>(
      `
      SELECT w.layout_revision AS revision, COALESCE((
        SELECT jsonb_agg(jsonb_build_object('nodeId',p.id,'x',p.x,'y',p.y)) FROM (
          SELECT id,canvas_x AS x,canvas_y AS y FROM workflow.steps WHERE workflow_template_id=w.id AND retired_at IS NULL
          UNION ALL SELECT id,canvas_x,canvas_y FROM workflow.triggers WHERE workflow_template_id=w.id
          UNION ALL SELECT id,canvas_x,canvas_y FROM workflow.decisions WHERE workflow_template_id=w.id
          UNION ALL SELECT c->>'id',(c->'layout'->>'x')::real,(c->'layout'->>'y')::real
            FROM jsonb_array_elements(COALESCE(w.graph_json->'controls','[]'::jsonb)) c
          UNION ALL SELECT c->>'fanInId',(c->'layout'->>'fanInX')::real,(c->'layout'->>'fanInY')::real
            FROM jsonb_array_elements(COALESCE(w.graph_json->'controls','[]'::jsonb)) c WHERE c->>'kind'='fan-out'
        ) p
      ),'[]'::jsonb) AS positions
      FROM workflow.templates w WHERE w.id=$1 AND w.organization_id=$2`,
      [workflowId, scope.organizationId],
    );
    if (!result.rows[0])
      throw layoutError("workflow_not_found", "Workflow not found.", 404);
    return result.rows[0];
  }

  async write(scope: OrganizationScope, workflowId: string, value: unknown) {
    const parsed = workflowLayoutPatchSchema.safeParse(value);
    if (!parsed.success)
      throw layoutError(
        "workflow_layout_invalid",
        "Layout requires unique node IDs, finite coordinates and a nonnegative revision.",
        400,
      );
    const patch = parsed.data;
    return withPostgresTransaction(this.pool, async (client) => {
      const locked = await client.query<{
        layout_revision: number;
        controls: Control[];
      }>(
        "SELECT layout_revision,COALESCE(graph_json->'controls','[]'::jsonb) AS controls FROM workflow.templates WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [workflowId, scope.organizationId],
      );
      const row = locked.rows[0];
      if (!row)
        throw layoutError("workflow_not_found", "Workflow not found.", 404);
      if (row.layout_revision !== patch.revision)
        throw layoutError(
          "workflow_layout_conflict",
          "Workflow positions changed. Refresh positions and retry.",
          409,
        );
      const ids = patch.positions.map((position) => position.nodeId);
      const existing = await client.query<{
        id: string;
        x: number | null;
        y: number | null;
      }>(
        `
        SELECT id,canvas_x AS x,canvas_y AS y FROM workflow.steps WHERE workflow_template_id=$1 AND retired_at IS NULL AND id=ANY($2::text[])
        UNION ALL SELECT id,canvas_x,canvas_y FROM workflow.triggers WHERE workflow_template_id=$1 AND id=ANY($2::text[])
        UNION ALL SELECT id,canvas_x,canvas_y FROM workflow.decisions WHERE workflow_template_id=$1 AND id=ANY($2::text[])`,
        [workflowId, ids],
      );
      const positions = new Map(
        existing.rows.map((position) => [position.id, position]),
      );
      for (const control of row.controls) {
        positions.set(control.id, {
          id: control.id,
          x: control.layout?.x ?? null,
          y: control.layout?.y ?? null,
        });
        if (control.fanInId)
          positions.set(control.fanInId, {
            id: control.fanInId,
            x: control.layout?.fanInX ?? null,
            y: control.layout?.fanInY ?? null,
          });
      }
      for (const position of patch.positions) {
        if (!positions.has(position.nodeId))
          throw layoutError(
            "workflow_layout_node_unavailable",
            "A moved node was removed or is not saved. Refresh the workflow.",
            409,
          );
      }
      const changed = patch.positions.filter((position) => {
        const before = positions.get(position.nodeId)!;
        // Coordinate columns are real: compare the stored precision to avoid repeat writes.
        return (
          before.x === null ||
          before.y === null ||
          Math.fround(before.x) !== Math.fround(position.x) ||
          Math.fround(before.y) !== Math.fround(position.y)
        );
      });
      if (!changed.length) return { revision: row.layout_revision };
      await writeCoordinates(client, workflowId, changed);
      let controlsChanged = false;
      const changes = new Map(
        changed.map((position) => [position.nodeId, position]),
      );
      const controls = row.controls.map((control, index) => {
        const primary = changes.get(control.id);
        const fanIn = control.fanInId
          ? changes.get(control.fanInId)
          : undefined;
        if (!primary && !fanIn) return control;
        controlsChanged = true;
        return {
          ...control,
          layout: {
            x: 160 + index * 360,
            y: 420,
            ...control.layout,
            ...(primary
              ? { x: Math.fround(primary.x), y: Math.fround(primary.y) }
              : {}),
            ...(fanIn
              ? { fanInX: Math.fround(fanIn.x), fanInY: Math.fround(fanIn.y) }
              : {}),
          },
        };
      });
      const updated = await client.query<{ revision: number }>(
        `
        UPDATE workflow.templates SET layout_revision=layout_revision+1,
          graph_json=CASE WHEN $2 THEN jsonb_set(graph_json,'{controls}',$3::jsonb) ELSE graph_json END
        WHERE id=$1 RETURNING layout_revision AS revision`,
        [workflowId, controlsChanged, JSON.stringify(controls)],
      );
      return updated.rows[0]!;
    });
  }
}

async function writeCoordinates(
  client: PgClient,
  workflowId: string,
  positions: WorkflowLayoutPatch["positions"],
) {
  const payload = JSON.stringify(
    positions.map((p) => ({ id: p.nodeId, x: p.x, y: p.y })),
  );
  await client.query(
    `WITH p AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS p(id text,x real,y real)),
    steps AS (UPDATE workflow.steps n SET canvas_x=p.x,canvas_y=p.y FROM p
      WHERE n.workflow_template_id=$1 AND n.id=p.id AND n.retired_at IS NULL
        AND (n.canvas_x IS DISTINCT FROM p.x OR n.canvas_y IS DISTINCT FROM p.y) RETURNING 1),
    triggers AS (UPDATE workflow.triggers n SET canvas_x=p.x,canvas_y=p.y FROM p
      WHERE n.workflow_template_id=$1 AND n.id=p.id
        AND (n.canvas_x IS DISTINCT FROM p.x OR n.canvas_y IS DISTINCT FROM p.y) RETURNING 1),
    decisions AS (UPDATE workflow.decisions n SET canvas_x=p.x,canvas_y=p.y FROM p
      WHERE n.workflow_template_id=$1 AND n.id=p.id
        AND (n.canvas_x IS DISTINCT FROM p.x OR n.canvas_y IS DISTINCT FROM p.y) RETURNING 1)
    SELECT (SELECT count(*) FROM steps)+(SELECT count(*) FROM triggers)+(SELECT count(*) FROM decisions) AS changed`,
    [workflowId, payload],
  );
}
