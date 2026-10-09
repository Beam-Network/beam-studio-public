import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Check,
  KeyRound,
  Power,
  Settings2,
  Trash2,
} from "lucide-react";
import { SettingsSection } from "@/components/settings-section";
import { WorkflowContractEditor } from "./workflow-contract-editor";
import { BillingKeySelect } from "@/features/billing/billing-key-select";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { apiSend } from "@/lib/api-client";
import { billingKeyEmptySelection } from "./workflow-billing-key";
import { leaveDeletedWorkflow } from "./workflow-deletion";
import type { WorkflowBundle } from "./workflow-graph-types";
import {
  workflowReferencesOptions,
  type WorkflowReferences,
} from "./workflow-queries";

type WorkflowSettingsValues = {
  apiKeyId: string;
  description: string;
  enabled: boolean;
  name: string;
};

type WorkflowListCache = {
  workflows?: Array<{
    id?: string;
    name?: string | null;
  }>;
};

export function WorkflowSettings({ workflow }: { workflow: WorkflowBundle }) {
  const { template } = workflow;
  const formId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const endpoint = `/studio/workflows/${template.id}`;
  const [values, setValues] = useState<WorkflowSettingsValues>(() =>
    settingsFromTemplate(template),
  );

  useEffect(() => {
    setValues(settingsFromTemplate(template));
  }, [
    template.apiKeyId,
    template.description,
    template.enabled,
    template.id,
    template.name,
  ]);

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: ["/studio/workflows", template.id],
    });
    queryClient.invalidateQueries({ queryKey: ["/studio/workflows"] });
  };
  const saveMutation = useMutation({
    mutationFn: () =>
      apiSend<WorkflowBundle>("PATCH", endpoint, {
        apiKeyId: values.apiKeyId,
        description: values.description,
        enabled: values.enabled,
        name: values.name,
      }),
    onSuccess: (workflow) => {
      queryClient.setQueryData(["/studio/workflows", template.id], workflow);
      updateWorkflowNameCache(
        queryClient,
        ["/studio/workflows"],
        template.id,
        workflow.template.name,
      );
      updateWorkflowNameCache(
        queryClient,
        ["/studio/workflows", "breadcrumb"],
        template.id,
        workflow.template.name,
      );
      invalidate();
    },
  });
  const referencesQuery = useQuery(workflowReferencesOptions(template.id));
  const deleteMutation = useMutation({
    mutationFn: () => apiSend("DELETE", endpoint),
    onSuccess: () =>
      leaveDeletedWorkflow({
        workflowId: template.id,
        queryClient,
        navigate: (options) => navigate(options as never),
      }),
    onError: () =>
      queryClient.invalidateQueries({
        queryKey: workflowReferencesOptions(template.id).queryKey,
      }),
  });
  const valid = values.name.trim().length > 0;

  function update(patch: Partial<WorkflowSettingsValues>) {
    saveMutation.reset();
    setValues((current) => ({ ...current, ...patch }));
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-[min(1080px,calc(100%-32px))] pb-12">
        <header className="flex flex-wrap items-start justify-between gap-4 pb-8 pt-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Workflow settings
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
              Update how this workflow is identified and whether it can run.
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {saveMutation.isSuccess ? (
              <span className="text-sm text-success" role="status">
                Changes saved.
              </span>
            ) : null}
            <Button
              disabled={saveMutation.isPending || !valid}
              form={formId}
              type="submit"
            >
              <Check className="h-4 w-4" />
              {saveMutation.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </header>

        <form
          className="border-t"
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) {
              saveMutation.mutate();
            }
          }}
        >
          <SettingsSection
            description="How the workflow is identified across Studio."
            icon={Settings2}
            title="Workflow details"
          >
            <div className="grid gap-3">
              <label className="grid gap-2 text-sm font-medium">
                Name
                <input
                  className="h-10 rounded-control border bg-background px-3 text-sm font-normal outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) => update({ name: event.target.value })}
                  placeholder="Nightly object processing"
                  value={values.name}
                />
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Description
                <textarea
                  className="min-h-20 rounded-control border bg-background px-3 py-2 text-sm font-normal outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) =>
                    update({ description: event.target.value })
                  }
                  placeholder="What this workflow does."
                  value={values.description}
                />
              </label>
            </div>
          </SettingsSection>

          <SettingsSection
            description="Runs are authorized and charged with this Beam API key. Without a selection, they use the Beam credential chosen in the workflow's Beam Transfer step."
            icon={KeyRound}
            title="Execution and billing"
          >
            <BillingKeySelect
              emptySelection={billingKeyEmptySelection(workflow.steps)}
              onChange={(apiKeyId) => update({ apiKeyId })}
              value={values.apiKeyId}
            />
          </SettingsSection>

          <SettingsSection
            description="Disabled workflows cannot start new runs."
            icon={Power}
            title="Availability"
          >
            <label className="flex items-start gap-3 rounded-control border bg-card p-4">
              <input
                checked={values.enabled}
                className="mt-0.5 h-4 w-4"
                onChange={(event) => update({ enabled: event.target.checked })}
                type="checkbox"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  Enable this workflow
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  Keep the workflow available for manual, scheduled, and
                  parent-workflow runs.
                </span>
              </span>
            </label>
          </SettingsSection>

          {saveMutation.error ? (
            <p className="mt-5 rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {String(saveMutation.error)}
            </p>
          ) : null}
        </form>

        <WorkflowContractEditor workflow={workflow} />

        <div className="border-t">
          <SettingsSection
            description="Actions here cannot be undone."
            icon={AlertTriangle}
            title="Danger zone"
          >
            <div className="flex flex-col gap-4 border border-destructive/50 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold">Delete this workflow</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Permanently delete the workflow and all of its runs.
                </p>
                <DeletionReferences references={referencesQuery.data} />
                {deleteMutation.error ? (
                  <p className="mt-2 text-sm text-destructive">
                    {String(deleteMutation.error)}
                  </p>
                ) : null}
              </div>
              <ConfirmationDialog
                confirmLabel="Delete workflow"
                description={`This permanently deletes “${template.name}” and all of its runs. This action cannot be undone.`}
                onConfirm={() => deleteMutation.mutateAsync()}
                title="Delete this workflow?"
                trigger={
                  <Button
                    className="shrink-0"
                    disabled={deleteMutation.isPending}
                    type="button"
                    variant="destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    {deleteMutation.isPending
                      ? "Deleting..."
                      : "Delete workflow"}
                  </Button>
                }
              />
            </div>
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}

/** What blocks deletion, shown before the user tries. */
function DeletionReferences({
  references,
}: {
  references: WorkflowReferences | undefined;
}) {
  if (
    !references ||
    (!references.callers.length && !references.fixtureCampaignIds.length)
  ) {
    return null;
  }
  return (
    <div className="mt-3 grid gap-2 text-sm">
      {references.callers.length ? (
        <div>
          <p className="font-medium">Called by</p>
          <ul className="mt-1 grid gap-1 text-muted-foreground">
            {references.callers.map((caller) => (
              <li key={caller.id}>
                <Link
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                  to={`/workflows/${caller.id}/editor` as never}
                >
                  {caller.name}
                </Link>
                {caller.historyOnly
                  ? " — a removed call kept for run history; delete that workflow first."
                  : " — remove its call to this workflow first."}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {references.fixtureCampaignIds.length ? (
        <p className="text-muted-foreground">
          Used by fixture{" "}
          {references.fixtureCampaignIds.length === 1
            ? "campaign"
            : "campaigns"}{" "}
          {references.fixtureCampaignIds.join(", ")}. An operator must retire
          it before this workflow can be deleted.
        </p>
      ) : null}
    </div>
  );
}

function settingsFromTemplate(
  template: WorkflowBundle["template"],
): WorkflowSettingsValues {
  return {
    apiKeyId: template.apiKeyId ?? "",
    description: template.description ?? "",
    enabled: template.enabled,
    name: template.name,
  };
}

function updateWorkflowNameCache(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: string[],
  workflowId: string,
  name: string,
) {
  queryClient.setQueryData<WorkflowListCache>(queryKey, (current) => {
    if (!current?.workflows) {
      return current;
    }
    return {
      ...current,
      workflows: current.workflows.map((workflow) =>
        workflow.id === workflowId ? { ...workflow, name } : workflow,
      ),
    };
  });
}
