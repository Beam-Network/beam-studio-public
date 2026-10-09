import { pgMany, type PgPool } from "@beam-studio/db";
import type { OrganizationScope } from "./organization-scope.js";

/** Navigation data deliberately excludes immutable snapshots and business output. */
export type WorkflowRunSummary = {
  id: string;
  organizationId: string;
  workflowTemplateId: string;
  workflowName: string;
  parentRunId: string | null;
  rootRunId: string | null;
  status: string;
  trigger: string;
  triggerId: string | null;
  triggerType: string | null;
  historical: boolean;
  outputValidation: string;
  error: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRunFilters = {
  workflowTemplateId?: string;
  status?: string;
  actionPackage?: string;
  from?: string;
  to?: string;
  projectId?: string | null;
  search?: string;
  view?: string;
  limit?: number;
  cursor?: string;
};

export class WorkflowReadRepository {
  constructor(private readonly pool: PgPool) {}

  async listRuns(scope: OrganizationScope, filters: WorkflowRunFilters = {}) {
    return (await this.runsPage(scope, filters)).runs;
  }

  async runsPage(scope: OrganizationScope, filters: WorkflowRunFilters = {}) {
    const limit = Math.max(1, Math.min(100, Math.floor(filters.limit || 50)));
    let cursor: { at: string; id: string } | null = null;
    if (filters.cursor) {
      try {
        cursor = JSON.parse(
          Buffer.from(filters.cursor, "base64url").toString("utf8"),
        );
        if (
          !cursor ||
          typeof cursor.id !== "string" ||
          typeof cursor.at !== "string" ||
          !Number.isFinite(Date.parse(cursor.at))
        )
          throw new Error();
      } catch {
        throw Object.assign(new Error("Invalid run page cursor."), {
          statusCode: 400,
          expose: true,
        });
      }
    }
    const predicate = `
      FROM execution.workflow_runs r
      JOIN workflow.templates w ON w.id = r.workflow_template_id
      WHERE r.organization_id = $1 AND w.organization_id = $1
        AND ($2 = '' OR r.workflow_template_id = $2)
        AND ($3 = 'all' OR r.status = $3)
        AND ($4 = '' OR r.created_at >= NULLIF($4, '')::timestamptz)
        AND ($5 = '' OR r.created_at <= NULLIF($5, '')::timestamptz)
        AND ($6 = '' OR w.project_id = $6)
        AND ($7 = '' OR EXISTS (
          SELECT 1 FROM execution.workflow_step_runs sr
          WHERE sr.workflow_run_id = r.id AND sr.action_package_name = $7
        ) OR EXISTS (
          SELECT 1 FROM workflow.steps s WHERE s.workflow_template_id = w.id
            AND s.action_package_name = $7 AND s.retired_at IS NULL
        ))
        AND ($8 = '' OR strpos(lower(concat_ws(' ', r.id, w.name, r.status, r.trigger, r.trigger_type, r.trigger_id, r.error)), lower($8)) > 0)
        AND ($9 NOT IN ('queue','dead-letter') OR
          ($9 = 'queue' AND r.status IN ('queued','running','cancel_requested')) OR
          ($9 = 'dead-letter' AND r.status IN ('failed','cancelled')))`;
    const values = [
      scope.organizationId,
      filters.workflowTemplateId ?? "",
      filters.status ?? "all",
      filters.from ?? "",
      filters.to ?? "",
      filters.projectId ?? "",
      filters.actionPackage ?? "",
      (filters.search ?? "").slice(0, 200),
      filters.view ?? "all",
    ];
    const [rows, counts] = await Promise.all([
      pgMany<WorkflowRunSummary>(
        this.pool,
        `
      SELECT r.id, r.organization_id AS "organizationId",
        r.workflow_template_id AS "workflowTemplateId", w.name AS "workflowName",
        r.parent_run_id AS "parentRunId", r.root_run_id AS "rootRunId",
        r.status, r.trigger, r.trigger_id AS "triggerId", r.trigger_type AS "triggerType",
        r.historical, r.output_validation AS "outputValidation", r.error,
        r.queued_at AS "queuedAt", r.started_at AS "startedAt", r.completed_at AS "completedAt",
        r.created_at AS "createdAt", r.updated_at AS "updatedAt"
      ${predicate}
        AND ($10 = '' OR (r.created_at, r.id) < (NULLIF($10, '')::timestamptz, $11))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $12`,
        [...values, cursor?.at ?? "", cursor?.id ?? "", limit + 1],
      ),
      pgMany<{ count: string }>(
        this.pool,
        `SELECT count(*)::text AS count ${predicate}`,
        values,
      ),
    ]);
    const runs = rows.slice(0, limit);
    const last = runs.at(-1);
    return {
      runs,
      totalCount: Number(counts[0]?.count ?? 0),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.createdAt, id: last.id }),
            ).toString("base64url")
          : null,
    };
  }

  async listWorkflows(scope: OrganizationScope, projectId?: string | null) {
    return pgMany<Record<string, unknown>>(
      this.pool,
      `
      SELECT w.id, w.name, w.description, w.enabled, w.updated_at AS "updatedAt",
        parent.id AS "sidebarParentId",
        (SELECT count(*)::int FROM workflow.steps s WHERE s.workflow_template_id=w.id AND s.retired_at IS NULL) AS "stepCount",
        (SELECT count(*)::int FROM execution.workflow_runs r WHERE r.workflow_template_id=w.id) AS "runCount",
        (SELECT r.status FROM execution.workflow_runs r WHERE r.workflow_template_id=w.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS "lastRunStatus",
        EXISTS(SELECT 1 FROM workflow.triggers t WHERE t.workflow_template_id=w.id AND t.type='schedule' AND t.enabled) AS scheduled,
        (SELECT min(NULLIF(t.config_json->>'nextRunAt','')::timestamptz) FROM workflow.triggers t WHERE t.workflow_template_id=w.id AND t.type='schedule' AND t.enabled) AS "nextRunAt"
      FROM workflow.templates w
      LEFT JOIN workflow.sidebar_hierarchy h ON h.child_id=w.id
      LEFT JOIN workflow.templates parent ON parent.id=h.parent_id AND parent.organization_id=w.organization_id
      WHERE w.organization_id=$1 AND ($2='' OR w.project_id=$2)
      ORDER BY w.updated_at DESC, w.id DESC`,
      [scope.organizationId, projectId ?? ""],
    );
  }
}
