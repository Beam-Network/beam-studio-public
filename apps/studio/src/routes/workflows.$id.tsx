import { workflowDefinitionOptions } from "@/features/workflows/workflow-queries";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Navigate,
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  Boxes,
  Check,
  Clipboard,
  Copy,
  Ellipsis,
  Eraser,
  Play,
  Save,
  Trash2,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { WorkflowCreditEstimatePill } from "@/features/workflows/workflow-credit-estimate-pill";
import { leaveDeletedWorkflow } from "@/features/workflows/workflow-deletion";
import {
  WorkflowGraphEditor,
  type WorkflowEditorHeaderControls,
} from "@/features/workflows/workflow-graph-editor";
import type {
  WorkflowBundle,
  WorkflowTab,
} from "@/features/workflows/workflow-graph-types";
import { apiGet, apiSend } from "@/lib/api-client";

export const Route: any = createFileRoute("/workflows/$id")({
  component: WorkflowRoute,
});

function WorkflowRoute() {
  const { id } = Route.useParams();
  const location = useLocation();

  if (location.pathname !== `/workflows/${id}`) {
    return <Outlet />;
  }

  return <Navigate replace to={`/workflows/${id}/editor` as never} />;
}

export function WorkflowDetailView({
  activeTab,
  workflowId,
}: {
  activeTab: WorkflowTab;
  workflowId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [headerControls, setHeaderControls] =
    useState<WorkflowEditorHeaderControls | null>(null);
  const deleteTemplateMutation = useMutation({
    mutationFn: () => apiSend("DELETE", `/studio/workflows/${workflowId}`),
    onSuccess: () =>
      leaveDeletedWorkflow({
        workflowId,
        queryClient,
        navigate: (options) => navigate(options as never),
      }),
  });
  const duplicateTemplateMutation = useMutation({
    mutationFn: () =>
      apiSend<{ id: string }>(
        "POST",
        `/studio/workflows/${workflowId}/duplicate`,
        {},
      ),
    onSuccess: ({ id }) => {
      queryClient.invalidateQueries({ queryKey: ["/studio/workflows"] });
      navigate({ to: `/workflows/${id}/editor` as never });
    },
  });
  useEffect(() => {
    setHeaderControls(null);
  }, [workflowId]);

  function openTab(tab: WorkflowTab) {
    navigate({ to: `/workflows/${workflowId}/${tab}` as never });
  }

  return (
    <WorkflowContextShell
      headerActions={
        <WorkflowHeaderActions
          activeTab={activeTab}
          controls={headerControls}
        />
      }
      headerBreadcrumbActions={
        activeTab === "editor" ? (
          <WorkflowMoreMenu
            controls={headerControls}
            deletePending={deleteTemplateMutation.isPending}
            duplicatePending={duplicateTemplateMutation.isPending}
            onDeleteTemplate={() => deleteTemplateMutation.mutateAsync()}
            onDuplicateTemplate={() => duplicateTemplateMutation.mutate()}
          />
        ) : null
      }
      workflowId={workflowId}
    >
      <WorkflowGraphEditor
        activeTab={activeTab}
        onHeaderControlsChange={setHeaderControls}
        onOpenEditor={() => openTab("editor")}
        workflowId={workflowId}
      />
    </WorkflowContextShell>
  );
}

export function WorkflowContextShell({
  children,
  contentClassName = "flex h-full max-w-none px-0 py-0",
  headerActions,
  headerBreadcrumbActions,
  workflowId,
}: {
  children: ReactNode;
  contentClassName?: string;
  headerActions?: ReactNode;
  headerBreadcrumbActions?: ReactNode;
  workflowId: string;
}) {
  const workflowQuery = useQuery({
    ...workflowDefinitionOptions(workflowId),
  });
  const workflowName = workflowQuery.data?.template.name;
  const title = workflowName ? `Workflow / ${workflowName}` : "Workflow";

  return (
    <AppShell
      contentClassName={contentClassName}
      headerActions={headerActions}
      headerBreadcrumbActions={headerBreadcrumbActions}
      title={title}
    >
      {children}
    </AppShell>
  );
}

function WorkflowHeaderActions({
  activeTab,
  controls,
}: {
  activeTab: WorkflowTab;
  controls: WorkflowEditorHeaderControls | null;
}) {
  const saveLabel = !controls
    ? "Save changes"
    : controls.savePending
      ? "Saving..."
      : controls.hasUnsavedChanges
        ? "Save changes"
        : "Saved";

  return (
    <>
      {activeTab === "editor" && controls?.positionSaveState &&
      (controls.positionSaveState.pending || controls.positionSaveState.error) ? (
        <span role={controls.positionSaveState.error ? "alert" : "status"} className="inline-flex items-center gap-2 text-sm text-muted-foreground" title={controls.positionSaveState.error || undefined}>
          {controls.positionSaveState.error ? (controls.positionSaveState.pending ? "Positions not saved" : "Position sync unavailable") : "Saving positions…"}
          {controls.positionSaveState.error ? <Button size="sm" variant="outline" onClick={controls.onRetryPositions}>Retry</Button> : null}
        </span>
      ) : null}
      {activeTab === "editor" &&
      controls &&
      !controls.hasUnsavedChanges &&
      !controls.savePending &&
      !controls.positionSaveState?.pending &&
      !controls.positionSaveState?.error ? (
        <span
          aria-label="Saved"
          className="hidden items-center gap-1.5 whitespace-nowrap px-2 text-sm text-muted-foreground sm:inline-flex"
          role="status"
        >
          <Check aria-hidden="true" className="size-4" />
          Saved
        </span>
      ) : activeTab === "editor" && (!controls || controls.hasUnsavedChanges || controls.savePending) ? (
        <Button
          aria-label={saveLabel}
          className="px-2 sm:px-3"
          disabled={
            !controls ||
            controls.savePending ||
            controls.saveDisabled ||
            !controls.hasUnsavedChanges
          }
          onClick={controls?.onSave}
          size="sm"
          title={
            controls?.saveDisabled
              ? "Fix the issues marked on the canvas before saving"
              : saveLabel
          }
          type="button"
          variant="secondary"
        >
          <Save className="h-4 w-4" />
          <span className="hidden sm:inline">{saveLabel}</span>
        </Button>
      ) : null}
      {activeTab === "editor" && controls ? (
        <WorkflowCreditEstimatePill {...controls.creditEstimate} />
      ) : null}
      <Button
        className="min-w-20"
        disabled={!controls || controls.runPending}
        onClick={controls?.onRun}
        size="sm"
        type="button"
      >
        <Play className="h-4 w-4" />
        {controls?.runPending ? "Running" : "Run"}
      </Button>
    </>
  );
}

function WorkflowMoreMenu({
  controls,
  deletePending,
  duplicatePending,
  onDeleteTemplate,
  onDuplicateTemplate,
}: {
  controls: WorkflowEditorHeaderControls | null;
  deletePending: boolean;
  duplicatePending: boolean;
  onDeleteTemplate(): Promise<unknown>;
  onDuplicateTemplate(): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedAction, setCopiedAction] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    function closeOnOutsideClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", closeOnOutsideClick);
    return () => window.removeEventListener("mousedown", closeOnOutsideClick);
  }, [menuOpen]);

  function copyAction(label: string, action: () => void) {
    action();
    setCopiedAction(label);
    window.setTimeout(() => setCopiedAction(null), 1600);
  }

  function cleanTemplate() {
    controls?.onCleanTemplate();
    setMenuOpen(false);
  }

  // The dialog lives in this menu: keep both open until the request settles so
  // a refusal (such as the workflows still calling this one) stays readable.
  async function deleteTemplate() {
    await onDeleteTemplate();
    setMenuOpen(false);
  }

  function duplicateTemplate() {
    onDuplicateTemplate();
    setMenuOpen(false);
  }

  function openTemplates() {
    controls?.onOpenTemplates();
    setMenuOpen(false);
  }

  return (
    <div className="relative" ref={menuRef}>
      <Button
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        disabled={!controls}
        onClick={() => setMenuOpen((open) => !open)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Ellipsis className="h-4 w-4" />
        <span className="sr-only">More workflow actions</span>
      </Button>
      {menuOpen && controls ? (
        <div
          className="absolute left-1/2 top-[calc(100%+0.5rem)] z-50 grid w-56 -translate-x-1/2 gap-0.5 rounded-surface border bg-popover p-1.5 text-popover-foreground shadow-xl lg:left-auto lg:right-0 lg:translate-x-0"
          role="menu"
        >
          <button
            className="flex h-8 items-center gap-2.5 rounded-control px-2.5 text-left text-[13px] font-normal outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={openTemplates}
            role="menuitem"
            type="button"
          >
            <Boxes className="size-4 text-muted-foreground" />
            Templates
          </button>
          <button
            className="flex h-8 items-center gap-2.5 rounded-control px-2.5 text-left text-[13px] font-normal outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={duplicatePending}
            onClick={duplicateTemplate}
            role="menuitem"
            type="button"
          >
            <Copy className="size-4 text-muted-foreground" />
            {duplicatePending ? "Duplicating workflow" : "Duplicate workflow"}
          </button>
          <button
            className="flex h-8 items-center gap-2.5 rounded-control px-2.5 text-left text-[13px] font-normal outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => copyAction("definition", controls.onCopyDefinition)}
            role="menuitem"
            type="button"
          >
            {copiedAction === "definition" ? (
              <Check className="size-4 text-success" />
            ) : (
              <Clipboard className="size-4 text-muted-foreground" />
            )}
            {copiedAction === "definition"
              ? "Copied definition"
              : "Copy definition"}
          </button>
          <button
            className="flex h-8 items-center gap-2.5 rounded-control px-2.5 text-left text-[13px] font-normal outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => copyAction("full-json", controls.onCopyFullJson)}
            role="menuitem"
            type="button"
          >
            {copiedAction === "full-json" ? (
              <Check className="size-4 text-success" />
            ) : (
              <Clipboard className="size-4 text-muted-foreground" />
            )}
            {copiedAction === "full-json" ? "Copied JSON" : "Copy full JSON"}
          </button>
          <div className="my-1 h-px bg-border" role="separator" />
          <ConfirmationDialog
            confirmLabel="Clean workflow"
            description="This removes every step from the workflow."
            onConfirm={cleanTemplate}
            title="Clean this workflow?"
            trigger={
              <button
                className="flex h-8 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-[13px] font-normal outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                disabled={controls.cleanPending}
                role="menuitem"
                type="button"
              >
                <Eraser className="size-4 text-muted-foreground" />
                {controls.cleanPending ? "Cleaning workflow" : "Clean workflow"}
              </button>
            }
          />
          <ConfirmationDialog
            confirmLabel="Delete workflow"
            description="This permanently deletes the workflow and all of its runs. This action cannot be undone."
            onConfirm={deleteTemplate}
            title="Delete this workflow?"
            trigger={
              <button
                className="flex h-8 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-[13px] font-normal text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                disabled={deletePending}
                role="menuitem"
                type="button"
              >
                <Trash2 className="size-4" />
                {deletePending ? "Deleting workflow" : "Delete workflow"}
              </button>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
