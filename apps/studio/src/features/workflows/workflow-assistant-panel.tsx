import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import type {
  AssistantProviderSummary,
  AssistantWorkflowPlan,
} from "@beam-studio/shared";
import { PanelHeader } from "@/components/header-primitives";
import { Button } from "@/components/ui/button";
import { apiGet, apiSend } from "@/lib/api-client";
import type { ActionPackage } from "./workflow-graph-types";

type ProvidersPayload = {
  providers: AssistantProviderSummary[];
};

type AssistantWorkflowPlanResponse = AssistantWorkflowPlan & {
  provider?: AssistantProviderSummary;
  degraded?: boolean;
  error?: string;
  providerMessage?: string;
};

export function WorkflowAssistantPanel({
  actions,
  hasGraphContent,
  onApplyPlan,
  onOpenChange,
  open,
  selectedNodeId,
  validationErrors,
  workflow,
  workflowId,
}: {
  actions: ActionPackage[];
  hasGraphContent: boolean;
  onApplyPlan(plan: AssistantWorkflowPlan): string[];
  onOpenChange(open: boolean): void;
  open: boolean;
  selectedNodeId: string | null;
  validationErrors: string[];
  workflow: unknown;
  workflowId: string;
}) {
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState<AssistantWorkflowPlanResponse | null>(null);
  const [applyErrors, setApplyErrors] = useState<string[]>([]);
  const providersQuery = useQuery({
    queryKey: ["/studio/ai/providers"],
    queryFn: () => apiGet<ProvidersPayload>("/studio/ai/providers"),
    enabled: open,
  });
  const provider = plan?.provider ?? providersQuery.data?.providers[0] ?? null;
  const patchErrors = useMemo(
    () => [...(plan?.patchErrors ?? []), ...applyErrors],
    [applyErrors, plan?.patchErrors],
  );

  const planMutation = useMutation({
    mutationFn: () =>
      apiSend<AssistantWorkflowPlanResponse>(
        "POST",
        `/studio/workflows/${workflowId}/assistant/plan`,
        {
          actions: actions.map((action) => ({
            name: action.name,
            version: action.version,
            manifest: action.manifest,
          })),
          prompt,
          selectedNodeId,
          validationErrors,
          workflow,
        },
      ),
    onSuccess: (response) => {
      setPlan(response);
      setApplyErrors([]);
    },
  });

  if (!open) {
    return null;
  }

  const providerReady = Boolean(
    provider?.enabled && providerModel(provider, "copilot") !== "No model",
  );
  const providerStatus = provider
    ? providerReady
      ? "ready"
      : provider.status === "missing_api_key"
        ? provider.status
        : "missing_model"
    : "Loading provider";
  const applyDisabled =
    !plan ||
    plan.patch.length === 0 ||
    patchErrors.length > 0 ||
    planMutation.isPending;

  return (
    <aside className="absolute bottom-4 right-4 top-20 z-20 flex w-[min(420px,calc(100vw-32px))] flex-col overflow-hidden rounded-surface border bg-card text-card-foreground shadow-xl">
      <PanelHeader className="justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-control bg-primary/15 text-primary">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Assistant</h2>
            <p className="truncate text-xs text-muted-foreground">
              {provider
                ? `${providerModel(provider, "copilot")} · ${providerStatus}`
                : "Loading provider"}
            </p>
          </div>
        </div>
        <Button
          aria-label="Close assistant"
          onClick={() => onOpenChange(false)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="h-4 w-4" />
        </Button>
      </PanelHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {hasGraphContent ? (
          <div className="rounded-control border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            Applying this plan replaces the current local graph after
            confirmation.
          </div>
        ) : null}

        <label className="grid gap-2 text-sm font-medium">
          Prompt
          <textarea
            className="min-h-28 resize-none rounded-control border bg-background px-3 py-2 text-sm font-normal outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="List an S3 bucket, merge CSV files, then launch a transfer"
            value={prompt}
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!prompt.trim() || planMutation.isPending}
            onClick={() => planMutation.mutate()}
            size="sm"
            type="button"
          >
            {planMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Preview
          </Button>
          <Button
            disabled={applyDisabled}
            onClick={() => {
              if (!plan) {
                return;
              }
              const errors = onApplyPlan(plan);
              setApplyErrors(errors);
              if (!errors.length) {
                setPlan(null);
              }
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            <CheckCircle2 className="h-4 w-4" />
            Apply
          </Button>
          <Button
            disabled={!plan && !prompt}
            onClick={() => {
              setPlan(null);
              setApplyErrors([]);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Discard
          </Button>
        </div>

        {planMutation.error ? (
          <AssistantError message={String(planMutation.error)} />
        ) : null}

        {plan ? (
          <div className="grid gap-3">
            {plan.degraded ? (
              <div className="rounded-control border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
                Local fallback used
                {plan.providerMessage ? `: ${plan.providerMessage}` : "."}
              </div>
            ) : null}
            <section className="grid gap-2 rounded-surface border p-3">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                Response
              </h3>
              <p className="text-sm leading-5">{plan.message}</p>
            </section>
            <AssistantList title="Plan" values={plan.plan} />
            <AssistantList title="Missing fields" values={plan.needsInput} />
            <AssistantList title="Assumptions" values={plan.assumptions} />
            <AssistantList title="Risks" values={plan.risks} tone="warning" />
            {patchErrors.length ? (
              <AssistantList
                title="Patch errors"
                values={patchErrors}
                tone="danger"
              />
            ) : null}
            <section className="grid gap-2 rounded-surface border p-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                  Patch
                </h3>
                <Button
                  onClick={() =>
                    navigator.clipboard.writeText(
                      JSON.stringify(plan.patch, null, 2),
                    )
                  }
                  size="icon"
                  title="Copy patch"
                  type="button"
                  variant="ghost"
                >
                  <ClipboardCopy className="h-4 w-4" />
                </Button>
              </div>
              <pre className="max-h-52 overflow-auto rounded-control bg-muted p-3 text-xs">
                {JSON.stringify(plan.patch, null, 2)}
              </pre>
            </section>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function providerModel(
  provider: AssistantProviderSummary,
  role: "chat" | "copilot",
) {
  return provider.models?.[role] || provider.model || "No model";
}

function AssistantError({ message }: { message: string }) {
  return (
    <div className="flex gap-2 rounded-control border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

function AssistantList({
  title,
  tone = "default",
  values,
}: {
  title: string;
  tone?: "danger" | "default" | "warning";
  values: string[];
}) {
  if (!values.length) {
    return null;
  }
  return (
    <section className="grid gap-2 rounded-surface border p-3">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">
        {title}
      </h3>
      <ul className="grid gap-1 text-sm leading-5">
        {values.map((value, index) => (
          <li
            className={
              tone === "danger"
                ? "text-destructive"
                : tone === "warning"
                  ? "text-amber-700 dark:text-amber-200"
                  : undefined
            }
            key={`${value}:${index}`}
          >
            {value}
          </li>
        ))}
      </ul>
    </section>
  );
}
