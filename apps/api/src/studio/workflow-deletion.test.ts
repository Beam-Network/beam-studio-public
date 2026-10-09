import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { deleteWorkflowTemplate, getWorkflowReferences } from "./store.js";

const source = process.env.BEAM_TEST_POSTGRES_URL;

test(
  "workflow deletion respects lifecycle and nested-history constraints",
  { skip: !source },
  async (t) => {
    process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
    const database = `workflow_delete_${randomBytes(6).toString("hex")}`;
    const maintenance = createPostgresPool(source);
    const globals = globalThis as typeof globalThis & {
      __beamStudioPgPool?: PgPool;
    };
    const previous = globals.__beamStudioPgPool;
    const disconnected: Promise<unknown>[] = [];
    let pool: PgPool | undefined;
    try {
      await maintenance.query(`CREATE DATABASE ${database}`);
      const url = new URL(source!);
      url.pathname = `/${database}`;
      // Exercise the indexed DELETE used by a populated hosted database. A
      // small fixture's heap order otherwise hides reverse child-link cycles.
      url.searchParams.set(
        "options",
        `${url.searchParams.get("options") ?? ""} -c enable_seqscan=off`.trim(),
      );
      pool = createPostgresPool(url.toString());
      pool.on("connect", (client) => disconnected.push(once(client, "end")));
      globals.__beamStudioPgPool = pool;
      await ensurePostgresMigrations(pool);
      await pool.query(
        "INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Test'),('other','other','Other')",
      );
      const db = pool;
      async function fixture(id: string, status = "completed") {
        await db.query(
          "INSERT INTO workflow.templates(id,organization_id,name) VALUES($1,'org',$1)",
          [id],
        );
        await db.query(
          "INSERT INTO workflow.steps(id,workflow_template_id,action_package_name,position) VALUES($1,$2,'@test/noop',0)",
          [id + "-step", id],
        );
        await db.query(
          "INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status,template_snapshot_json) VALUES($1,'org',$2,$3,'{\"frozen\":true}')",
          [id + "-run", id, status],
        );
        await db.query(
          "INSERT INTO execution.workflow_step_runs(id,workflow_run_id,workflow_step_id,action_package_name,resolved_version,checksum,source_registry,resolved_placement,status) VALUES($1,$2,$3,'@test/noop','1.0.0','test','builtin','local-workers','completed')",
          [id + "-sr", id + "-run", id + "-step"],
        );
      }
      await t.test(
        "frozen terminal execution trees delete; child definition and unrelated history survive",
        async () => {
          await fixture("remove");
          await fixture("keep");
          await db.query(
            "UPDATE workflow.steps SET kind='workflow',called_workflow_id='keep' WHERE id='remove-step'",
          );
          await db.query(
            "UPDATE execution.workflow_runs SET root_run_id=id WHERE id='remove-run'",
          );
          await db.query(
            "UPDATE execution.workflow_runs SET parent_run_id='remove-run',root_run_id='remove-run',invoking_step_run_id='remove-sr' WHERE id='keep-run'",
          );
          await db.query(
            "UPDATE execution.workflow_step_runs SET child_run_id='keep-run' WHERE id='remove-sr'",
          );
          await db.query(
            "INSERT INTO execution.workflow_dynamic_regions(id,workflow_run_id,control_id,control_path,kind,status) VALUES('region','remove-run','fanout','fanout','fan-out','completed')",
          );
          await db.query(
            "INSERT INTO execution.workflow_dynamic_instances(id,workflow_run_id,dynamic_region_id,workflow_step_id,control_path,instance_index,status) VALUES('instance','remove-run','region','remove-step','fanout',0,'completed')",
          );
          await db.query(
            "UPDATE execution.workflow_step_runs SET dynamic_instance_id='instance' WHERE id='remove-sr'",
          );
          await db.query(
            "INSERT INTO execution.workflow_tasks(id,organization_id,workflow_run_id,workflow_step_run_id,workflow_step_id,task_kind,action_package_name,status,input_checksum) VALUES('task','org','remove-run','remove-sr','remove-step','action','@test/noop','completed','test')",
          );
          await db.query(
            "INSERT INTO execution.executor_assignments(id,organization_id,workflow_run_id,workflow_step_run_id,task_id,attempt,backend,executor_id,declared_target_json,state,lease_expires_at,executor_stopped_at,cleanup_confirmed_at) VALUES('assignment','org','remove-run','remove-sr','task',1,'studio','runner','{\"kind\":\"studio\"}','completed',now(),now(),now())",
          );
          await db.query(
            "INSERT INTO execution.executor_process_ownership(assignment_id,state) VALUES('assignment','stopped')",
          );
          await db.query(
            "INSERT INTO execution.workflow_billing_attempts(operation_key,workflow_run_id,attempt,organization_id,reservation_state,outcome,settled_at) VALUES('bill','remove-run',1,'org','reserved','completed',now())",
          );
          await db.query(
            "INSERT INTO workflow.plan_versions(id,organization_id,workflow_template_id,version) VALUES('remove-plan','org','remove',1),('keep-plan','org','keep',1)",
          );
          await db.query(
            "UPDATE execution.workflow_runs SET workflow_plan_version_id=workflow_template_id||'-plan' WHERE workflow_template_id IN ('remove','keep')",
          );
          await db.query(
            "INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,workflow_plan_version_id,status,root_run_id,template_snapshot_json) VALUES('keep-independent-run','org','keep','keep-plan','completed','keep-independent-run','{\"frozen\":true}')",
          );
          await assert.rejects(
            db.query(
              "UPDATE execution.workflow_runs SET root_run_id=NULL WHERE id='remove-run'",
            ),
            /immutable/,
          );
          await deleteWorkflowTemplate("remove", "org");
          assert.equal(
            (
              await db.query(
                "SELECT id FROM workflow.templates WHERE id='remove'",
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await db.query(
                "SELECT id FROM execution.executor_assignments WHERE id='assignment'",
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await db.query(
                "SELECT operation_key FROM execution.workflow_billing_attempts WHERE operation_key='bill'",
              )
            ).rowCount,
            0,
          );
          const child = (
            await db.query(
              "SELECT parent_run_id,root_run_id,invoking_step_run_id,template_snapshot_json FROM execution.workflow_runs WHERE id='keep-independent-run'",
            )
          ).rows[0];
          assert.deepEqual(child, {
            parent_run_id: null,
            root_run_id: "keep-independent-run",
            invoking_step_run_id: null,
            template_snapshot_json: { frozen: true },
          });
          assert.equal(
            (
              await db.query(
                "SELECT id FROM execution.workflow_step_runs WHERE id='keep-sr'",
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await db.query(
                "SELECT id FROM workflow.templates WHERE id='keep'",
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await db.query(
                "SELECT id FROM execution.workflow_runs WHERE id='keep-run'",
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        "cross-organization and missing scopes cannot delete",
        async () => {
          await assert.rejects(deleteWorkflowTemplate("keep", "other"));
          await assert.rejects(deleteWorkflowTemplate("keep"), {
            code: "organization_required",
          });
          assert.equal(
            (
              await db.query(
                "SELECT id FROM workflow.templates WHERE id='keep'",
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        "active and still-called workflows return conflicts without mutation",
        async () => {
          await fixture("active", "running");
          await assert.rejects(deleteWorkflowTemplate("active", "org"), {
            code: "workflow_delete_conflict",
          });
          await db.query(
            "UPDATE workflow.steps SET kind='workflow',called_workflow_id='keep' WHERE id='active-step'",
          );
          await assert.rejects(deleteWorkflowTemplate("keep", "org"), {
            code: "workflow_delete_conflict",
            message:
              "“active” calls this workflow. Remove that workflow step before deleting it.",
          });
          assert.equal(
            (
              await db.query(
                "SELECT id FROM execution.workflow_runs WHERE id='keep-independent-run'",
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        "callers are named, removed history calls are marked and foreign callers stay unnamed",
        async () => {
          await fixture("retired-callee");
          await fixture("retired-caller");
          await db.query(
            "UPDATE workflow.steps SET kind='workflow',called_workflow_id='retired-callee',enabled=false,retired_at=now() WHERE id='retired-caller-step'",
          );
          await assert.rejects(
            deleteWorkflowTemplate("retired-callee", "org"),
            {
              code: "workflow_delete_conflict",
              message:
                "“retired-caller” keeps a removed call to this workflow for run history. Delete that workflow first.",
            },
          );
          assert.deepEqual(
            await getWorkflowReferences("retired-callee", "org"),
            {
              callers: [
                {
                  id: "retired-caller",
                  name: "retired-caller",
                  historyOnly: true,
                },
              ],
              fixtureCampaignIds: [],
            },
          );
          assert.equal(
            await getWorkflowReferences("retired-callee", "other"),
            null,
          );

          await fixture("foreign-callee");
          await db.query(
            "INSERT INTO workflow.templates(id,organization_id,name) VALUES('foreign-caller','other','Other organization workflow')",
          );
          await db.query(
            "INSERT INTO workflow.steps(id,workflow_template_id,action_package_name,position,kind,called_workflow_id) VALUES('foreign-caller-step','foreign-caller','@test/noop',0,'workflow','foreign-callee')",
          );
          await assert.rejects(
            deleteWorkflowTemplate("foreign-callee", "org"),
            (error: Error) =>
              (error as { code?: string }).code ===
                "workflow_delete_conflict" &&
              !error.message.includes("Other organization workflow"),
          );
          assert.deepEqual(
            await getWorkflowReferences("foreign-callee", "org"),
            { callers: [], fixtureCampaignIds: [] },
          );
        },
      );
      const fixtureCampaignTables =
        (
          await db.query(
            "SELECT to_regclass('workflow.fixture_campaigns') AS relation",
          )
        ).rows[0]?.relation != null;
      await t.test(
        "fixture campaign workflows return named conflicts without mutation",
        {
          skip: fixtureCampaignTables
            ? false
            : "this schema has no fixture campaign tables",
        },
        async () => {
          await fixture("campaign-parent");
          await fixture("campaign-child");
          await db.query(
            "UPDATE workflow.steps SET kind='workflow',called_workflow_id='campaign-child' WHERE id='campaign-parent-step'",
          );
          await db.query(
            "INSERT INTO secrets.credential_types(id,slug,display_name) VALUES('delete-type','delete-type','Delete Type')",
          );
          await db.query(
            "INSERT INTO secrets.credentials(id,organization_id,credential_type_id,name) VALUES('delete-credential','org','delete-type','Delete Credential')",
          );
          await db.query(
            "INSERT INTO workflow.fixture_campaigns(id,organization_id,parent_workflow_id,managed_prefix) VALUES('delete-campaign','org','campaign-parent','fixtures/delete-campaign/')",
          );
          await db.query(
            "INSERT INTO workflow.fixture_sources(campaign_id,id,workflow_step_id,bucket,credential_id,legacy_key) VALUES('delete-campaign','source','campaign-child-step','fixture-bucket','delete-credential','legacy/object.bin')",
          );
          const campaignMessage =
            "Fixture campaign “delete-campaign” uses this workflow. An operator must retire the campaign before it can be deleted.";
          await assert.rejects(
            deleteWorkflowTemplate("campaign-parent", "org"),
            { code: "workflow_delete_conflict", message: campaignMessage },
          );
          await assert.rejects(deleteWorkflowTemplate("campaign-child", "org"), {
            code: "workflow_delete_conflict",
            message: `“campaign-parent” calls this workflow. Remove that workflow step before deleting it. ${campaignMessage}`,
          });
          assert.deepEqual(
            await getWorkflowReferences("campaign-child", "org"),
            {
              callers: [
                {
                  id: "campaign-parent",
                  name: "campaign-parent",
                  historyOnly: false,
                },
              ],
              fixtureCampaignIds: ["delete-campaign"],
            },
          );
          assert.equal(
            (
              await db.query(
                "SELECT id FROM workflow.templates WHERE id IN ('campaign-parent','campaign-child')",
              )
            ).rowCount,
            2,
          );
          assert.equal(
            (
              await db.query(
                "SELECT id FROM workflow.fixture_sources WHERE campaign_id='delete-campaign'",
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        "historical organization references return conflicts without cross-tenant deletion",
        async () => {
          await fixture("foreign-history");
          await db.query(
            "INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status) VALUES('foreign-history-old-run','other','foreign-history','completed')",
          );
          await assert.rejects(
            deleteWorkflowTemplate("foreign-history", "org"),
            {
              code: "workflow_delete_conflict",
            },
          );
          assert.equal(
            (
              await db.query(
                "SELECT id FROM execution.workflow_runs WHERE workflow_template_id='foreign-history'",
              )
            ).rowCount,
            2,
          );
          await fixture("scoped-parent");
          await fixture("foreign-child");
          await db.query(
            "UPDATE execution.workflow_runs SET organization_id='other',parent_run_id='scoped-parent-run',root_run_id='scoped-parent-run',invoking_step_run_id='scoped-parent-sr' WHERE id='foreign-child-run'",
          );
          await assert.rejects(deleteWorkflowTemplate("scoped-parent", "org"), {
            code: "workflow_delete_conflict",
          });
          assert.equal(
            (
              await db.query(
                "SELECT parent_run_id FROM execution.workflow_runs WHERE id='foreign-child-run'",
              )
            ).rows[0].parent_run_id,
            "scoped-parent-run",
          );
        },
      );
      await t.test(
        "active nested execution blocks removal of its terminal parent",
        async () => {
          await fixture("nested-parent");
          await fixture("nested-child", "running");
          await db.query(
            "UPDATE execution.workflow_runs SET parent_run_id='nested-parent-run',root_run_id='nested-parent-run',invoking_step_run_id='nested-parent-sr' WHERE id='nested-child-run'",
          );
          await assert.rejects(deleteWorkflowTemplate("nested-parent", "org"), {
            code: "workflow_delete_conflict",
          });
          assert.equal(
            (
              await db.query(
                "SELECT id FROM execution.workflow_runs WHERE id='nested-parent-run'",
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        "surviving historical step references block deletion without detachment",
        async () => {
          await fixture("historical-caller");
          await fixture("historical-child");
          await db.query(
            "UPDATE execution.workflow_step_runs SET child_run_id='historical-child-run' WHERE id='historical-caller-sr'",
          );
          await assert.rejects(
            deleteWorkflowTemplate("historical-child", "org"),
            {
              code: "workflow_delete_conflict",
            },
          );
          assert.equal(
            (
              await db.query(
                "SELECT child_run_id FROM execution.workflow_step_runs WHERE id='historical-caller-sr'",
              )
            ).rows[0].child_run_id,
            "historical-child-run",
          );
        },
      );
      await t.test("pending settlement is retained", async () => {
        await fixture("unsettled");
        await db.query(
          "INSERT INTO execution.workflow_billing_attempts(operation_key,workflow_run_id,attempt,organization_id,reservation_state,outcome) VALUES('pending-bill','unsettled-run',1,'org','reserved','completed')",
        );
        await assert.rejects(deleteWorkflowTemplate("unsettled", "org"), {
          code: "workflow_delete_conflict",
        });
        assert.equal(
          (
            await db.query(
              "SELECT operation_key FROM execution.workflow_billing_attempts WHERE operation_key='pending-bill'",
            )
          ).rowCount,
          1,
        );
      });
      await t.test("unconfirmed executor cleanup is retained", async () => {
        await fixture("cleanup");
        await db.query(
          "INSERT INTO execution.workflow_tasks(id,organization_id,workflow_run_id,workflow_step_run_id,workflow_step_id,task_kind,action_package_name,status,input_checksum) VALUES('cleanup-task','org','cleanup-run','cleanup-sr','cleanup-step','action','@test/noop','failed','test')",
        );
        await db.query(
          "INSERT INTO execution.executor_assignments(id,organization_id,workflow_run_id,workflow_step_run_id,task_id,attempt,backend,executor_id,declared_target_json,state,lease_expires_at) VALUES('cleanup-assignment','org','cleanup-run','cleanup-sr','cleanup-task',1,'studio','runner','{\"kind\":\"studio\"}','failed',now())",
        );
        await assert.rejects(deleteWorkflowTemplate("cleanup", "org"), {
          code: "workflow_delete_conflict",
        });
        assert.equal(
          (
            await db.query(
              "SELECT id FROM execution.executor_assignments WHERE id='cleanup-assignment'",
            )
          ).rowCount,
          1,
        );
      });
    } finally {
      globals.__beamStudioPgPool = previous;
      await pool?.end();
      await Promise.all(disconnected);
      await maintenance.query(
        `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
      );
      await maintenance.end();
    }
  },
);
