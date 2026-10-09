import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Database, type LucideIcon, Settings2, Sparkles } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings-section";
import {
  type WorkflowTemplateId,
  workflowTemplates,
} from "@/features/workflows/workflow-creation";
import { apiSend } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const templateIcons: Record<WorkflowTemplateId, LucideIcon> = {
  blank: Sparkles,
  "simple-transfer": Database,
};

export const Route: any = createFileRoute("/workflows/new")({
  component: () => (
    <AppShell contentClassName="px-3 py-4">
      <NewWorkflowPage />
    </AppShell>
  ),
});

function NewWorkflowPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateId, setTemplateId] = useState<WorkflowTemplateId>("blank");
  const createMutation = useMutation({
    mutationFn: async () => {
      const result = await apiSend<{ id?: string }>(
        "POST",
        "/studio/workflows",
        { description: description.trim(), name: name.trim() },
      );
      if (!result.id) {
        throw new Error("Workflow creation did not return an id.");
      }
      return result.id;
    },
    onSuccess: (workflowId) => {
      queryClient.invalidateQueries({ queryKey: ["/studio/workflows"] });
      // The editor opens a template as an unsaved draft: its steps still need
      // a bucket and credentials before the graph can be saved.
      navigate({
        search: (templateId === "blank"
          ? {}
          : { template: templateId }) as never,
        to: `/workflows/${workflowId}/editor` as never,
      });
    },
  });
  const canSubmit = name.trim().length > 0 && !createMutation.isPending;

  function updateName(value: string) {
    createMutation.reset();
    setName(value);
  }

  function updateDescription(value: string) {
    createMutation.reset();
    setDescription(value);
  }

  function selectTemplate(value: WorkflowTemplateId) {
    createMutation.reset();
    setTemplateId(value);
  }

  return (
    <div className="mx-auto w-full max-w-6xl pb-12">
      <header className="pb-8 pt-4">
        <h1 className="text-xl font-semibold tracking-tight">
          Create workflow
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Name the workflow and choose a starting point.
        </p>
      </header>

      <form
        className="border-t"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            createMutation.mutate();
          }
        }}
      >
        <SettingsSection
          description="How the workflow is identified across Studio, and what it starts from."
          icon={Settings2}
          title="Workflow details"
        >
          <div className="grid gap-5">
            <label className="grid gap-2 text-sm font-medium">
              Title
              <input
                autoFocus
                className="h-10 rounded-control border bg-background px-3 text-sm font-normal outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => updateName(event.target.value)}
                placeholder="Daily archive transfer"
                value={name}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              Description
              <textarea
                className="min-h-20 rounded-control border bg-background px-3 py-2 text-sm font-normal outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => updateDescription(event.target.value)}
                placeholder="Move files from a source bucket to a destination bucket."
                value={description}
              />
            </label>
            <div className="grid gap-2">
              <span className="text-sm font-medium">Template</span>
              <div className="grid gap-2 sm:grid-cols-2">
                {workflowTemplates.map((template) => {
                  const Icon = templateIcons[template.id];
                  const selected = template.id === templateId;

                  return (
                    <button
                      aria-pressed={selected}
                      className={cn(
                        "grid gap-3 rounded-control border bg-background p-4 text-left outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring",
                        selected && "border-primary bg-secondary",
                      )}
                      key={template.id}
                      onClick={() => selectTemplate(template.id)}
                      type="button"
                    >
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4" />
                        <span className="font-medium">{template.title}</span>
                      </div>
                      <p className="text-sm leading-5 text-muted-foreground">
                        {template.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </SettingsSection>

        {createMutation.error ? (
          <p className="mt-5 rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {String(createMutation.error)}
          </p>
        ) : null}

        <div className="flex items-center justify-end py-5">
          <Button disabled={!canSubmit} type="submit">
            <Check className="h-4 w-4" />
            {createMutation.isPending ? "Creating..." : "Create workflow"}
          </Button>
        </div>
      </form>
    </div>
  );
}
