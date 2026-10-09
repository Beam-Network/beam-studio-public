import { withRunEvidence, type RunEvidence } from "./run-evidence";
import { useMemo, useState, type ReactNode } from "react";
import { roomTransferRetryUnavailableReason } from "@beam-studio/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  Braces,
  Check,
  ChevronRight,
  Clipboard,
  ExternalLink,
  FileText,
  GitBranch,
  History,
  ListChecks,
  Network,
  Package,
  RefreshCw,
  Repeat,
  Send,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { EmptyState, Skeleton } from "@/components/data-page";
import { PageSectionHeader } from "@/components/header-primitives";
import { apiGet, apiSend } from "@/lib/api-client";
import { formatBytes } from "@/lib/format-bytes";
import { cn } from "@/lib/utils";
import {
  actionDisabledReason,
  activeStatuses,
  beamDetails,
  beamTransferLinks,
  buildBranchSummary,
  decisionReasonLabel,
  type DecisionEvaluationRecord,
  buildExecutionSteps,
  buildTimeline,
  canRunAction,
  durationLabel,
  failedStatuses,
  failureDetails,
  logsForStep,
  normalizeStatus,
  relativeTimeLabel,
  shortText,
  statusLabel,
  statusTone,
  stringValue,
  transferSummary,
  unreachedStatuses,
  type ArtifactRecord,
  type BeamTransferLink,
  type ConditionEvaluationRecord,
  type DynamicInstancesPage,
  type DynamicRegionRecord,
  type ExecutionStep,
  type Failure,
  type RunAction,
  type RunBundle,
  type RunLogRecord,
  type RunRecord,
  type StatusTone,
  type TimelineEvent,
  type TransferRunRecord,
  type WorkflowEdgeRecord,
  type WorkflowStepRecord,
  type WorkflowTriggerEdgeRecord,
  type WorkflowTriggerRecord,
} from "./run-detail-data";
import { WorkflowExecutionGraph } from "./run-detail-graph";
import { DistributedTasksPane } from "./distributed-tasks-pane";
import {
  DateText,
  Fact,
  JsonPanel,
  StatusBadge,
  StatusIcon,
  isEmptyValue,
} from "./run-detail-primitives";
import { useLiveRunTimer } from "./use-live-run-timer";
import {
  roomMemberKindLabel,
  roomRecipientPresentation,
  roomSourcePresentation,
} from "./room-transfer-presentation";

type RunDetailViewProps = {
  title: string;
  endpoint: string;
  actions: RunAction[];
  backLink?: {
    label: string;
    to: string;
  };
  runPath?: (runId: string) => string;
};

/** Sidebar selection: a fixed pane key, or `step:<id>` for one step. */
type Selection = string;

export function RunDetailView({
  actions,
  backLink,
  endpoint,
  runPath,
  title,
}: RunDetailViewProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [selection, setSelection] = useState<Selection>("summary");
  const [pendingActionLabel, setPendingActionLabel] = useState<string | null>(
    null,
  );
  const { data, error, isPending } = useQuery({
    queryKey: [endpoint],
    queryFn: ({ signal }) => apiGet<RunBundle>(endpoint, signal),
    staleTime: 5_000,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      const status = normalizeStatus(query.state.data?.run?.status);
      return activeStatuses.has(status) ? 2000 : false;
    },
  });
  // Shares the app shell's cache; only the Console URL is read here.
  const organizationsQuery = useQuery({
    queryKey: ["/studio/organizations"],
    queryFn: () => apiGet<{ consoleUrl?: string }>("/studio/organizations"),
  });
  const mutation = useMutation({
    mutationFn: (action: RunAction) =>
      apiSend<Record<string, unknown>>(action.method, action.path()),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [endpoint] });
      const nextRunId = stringValue(result.runId);
      if (nextRunId) {
        const nextPath = runPath
          ? runPath(nextRunId)
          : endpoint.includes("/workflow-runs/")
            ? `/workflows/runs/${nextRunId}`
            : `/runs/${nextRunId}`;
        navigate({ to: nextPath as never });
      }
    },
    onSettled: () => setPendingActionLabel(null),
  });

  const hasRoomEvidence = Boolean(
    data?.stepRuns?.some(
      (step) =>
        step.actionPackageName === "@beam/room-transfer" &&
        (step.state as Record<string, unknown> | undefined)?.publicationId,
    ),
  );
  const evidence = useQuery({
    queryKey: [endpoint, "evidence"],
    queryFn: ({ signal }) =>
      apiGet<RunEvidence>(`${endpoint}/evidence`, signal),
    enabled: hasRoomEvidence && endpoint.includes("/workflow-runs/"),
    retry: false,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      activeStatuses.has(normalizeStatus(data?.run?.status)) ||
      query.state.data?.steps.some(
        (step) =>
          (step.executionInspection as { status?: string } | null)?.status ===
          "pending",
      )
        ? 5_000
        : false,
    refetchIntervalInBackground: false,
  });
  const bundle = useMemo(
    () => withRunEvidence(data ?? {}, evidence.data, evidence.isError),
    [data, evidence.data, evidence.isError],
  );
  const run = bundle.run ?? {};
  const stepRuns = Array.isArray(bundle.stepRuns) ? bundle.stepRuns : [];
  const workflowSteps = Array.isArray(bundle.steps) ? bundle.steps : [];
  const workflowEdges = Array.isArray(bundle.edges) ? bundle.edges : [];
  const workflowTriggers = Array.isArray(bundle.triggers)
    ? bundle.triggers
    : [];
  const workflowTriggerEdges = Array.isArray(bundle.triggerEdges)
    ? bundle.triggerEdges
    : [];
  const transfers = Array.isArray(bundle.transfers) ? bundle.transfers : [];
  const artifacts = Array.isArray(bundle.artifacts) ? bundle.artifacts : [];
  const distributedTasks = Array.isArray(bundle.distributedTasks)
    ? bundle.distributedTasks
    : [];
  const logs = Array.isArray(bundle.logs) ? bundle.logs : [];
  const dynamicRegions = Array.isArray(bundle.dynamicRegions)
    ? bundle.dynamicRegions
    : [];
  const conditionEvaluations = Array.isArray(bundle.conditionEvaluations)
    ? bundle.conditionEvaluations
    : [];
  const executionSteps = useMemo(
    () => buildExecutionSteps(workflowSteps, stepRuns),
    [stepRuns, workflowSteps],
  );
  const events = useMemo(
    () => buildTimeline(run, executionSteps, transfers, logs),
    [executionSteps, logs, run, transfers],
  );
  const failure = failureDetails(run, executionSteps, transfers, logs);
  const annotations = buildAnnotations(run, executionSteps, transfers, logs);
  const runStatus = normalizeStatus(run.status);
  const roomRetryReason = roomTransferRetryUnavailableReason(stepRuns);
  useLiveRunTimer(activeStatuses.has(runStatus));
  const elapsed = durationLabel(
    run.startedAt ?? run.queuedAt ?? run.createdAt,
    run.completedAt,
  );
  const workflowTemplateId = stringValue(run.workflowTemplateId);
  const workflowName =
    stringValue(run.workflowName) || stringValue(bundle.template?.name);
  const transferName =
    stringValue(run.transferName) ||
    stringValue(bundle.template?.legacyTransferName);
  const runName = workflowName || transferName || title;
  const selectedStep = selection.startsWith("step:")
    ? executionSteps.find((step) => step.id === selection.slice(5))
    : undefined;

  const copyRunJson = async () => {
    if (!data) {
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="grid gap-4">
      <PageSectionHeader className="grid gap-4">
        <div>
          <Button asChild className="-ml-2 h-7 px-2" size="sm" variant="ghost">
            <Link to={(backLink?.to ?? "/runs") as never}>
              <ArrowLeft className="h-4 w-4" />
              {backLink?.label ?? "All runs"}
            </Link>
          </Button>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2.5">
              <StatusIcon className="h-5 w-5" status={run.status} />
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {runName}
              </h1>
              <StatusBadge status={run.status || "unknown"} />
              {activeStatuses.has(runStatus) ? (
                <Badge className="gap-1.5" variant="secondary">
                  <span className="size-1.5 animate-pulse rounded-full bg-warning" />
                  Live
                </Badge>
              ) : null}
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
              <span>
                Triggered by{" "}
                <span className="font-medium text-foreground">
                  {stringValue(run.trigger) || "manual"}
                </span>
              </span>
              {relativeTimeLabel(
                run.startedAt ?? run.queuedAt ?? run.createdAt,
              ) ? (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    {relativeTimeLabel(
                      run.startedAt ?? run.queuedAt ?? run.createdAt,
                    )}
                  </span>
                </>
              ) : null}
              {workflowTemplateId ? (
                <>
                  <span aria-hidden>·</span>
                  <Link
                    className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
                    to={`/workflows/${workflowTemplateId}/editor` as never}
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    Open workflow
                  </Link>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={!data}
              onClick={() => void copyRunJson()}
              size="sm"
              type="button"
              variant="outline"
            >
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Clipboard className="h-4 w-4" />
              )}
              {copied ? "Copied" : "Copy JSON"}
            </Button>
            <Button
              onClick={() =>
                queryClient.invalidateQueries({ queryKey: [endpoint] })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            {actions.map((action) => {
              const Icon = action.label.toLowerCase().includes("cancel")
                ? X
                : action.label.toLowerCase().includes("retry")
                  ? Repeat
                  : Send;
              return (
                <Button
                  disabled={
                    mutation.isPending ||
                    Boolean(run.historical) ||
                    !canRunAction(action, runStatus, stepRuns, run)
                  }
                  key={action.label}
                  onClick={() => {
                    setPendingActionLabel(action.label);
                    mutation.mutate(action);
                  }}
                  size="sm"
                  title={
                    run.historical
                      ? "Historical executions are read-only. Run the workflow again to use its current definition."
                      : actionDisabledReason(action, runStatus, stepRuns, run)
                  }
                  type="button"
                  variant="secondary"
                >
                  <Icon className="h-4 w-4" />
                  {pendingActionLabel === action.label
                    ? `${action.label}...`
                    : action.label}
                </Button>
              );
            })}
          </div>
        </div>
      </PageSectionHeader>

      {roomRetryReason &&
      ["failed", "cancelled", "dead_letter"].includes(runStatus) ? (
        <p className="text-sm text-muted-foreground">{roomRetryReason}</p>
      ) : null}

      {isPending ? (
        <RunSkeleton />
      ) : error ? (
        <div className="rounded-surface border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {String(error)}
        </div>
      ) : (
        <>
          <RunMetaBar
            artifactCount={artifacts.length}
            duration={elapsed}
            run={run}
            steps={executionSteps}
            transfers={transfers}
          />

          {workflowTemplateId ? (
            <Panel title="Workflow result">
              <div className="flex flex-wrap gap-4 text-sm">
                {run.parentRunId ? (
                  <Link
                    className="underline"
                    to={`/workflows/runs/${run.parentRunId}` as never}
                  >
                    Parent run
                  </Link>
                ) : null}
                {run.rootRunId &&
                run.rootRunId !== run.id &&
                run.rootRunId !== run.parentRunId ? (
                  <Link
                    className="underline"
                    to={`/workflows/runs/${run.rootRunId}` as never}
                  >
                    Root run
                  </Link>
                ) : null}
                <span>
                  Output validation: {run.outputValidation || "pending"}
                </span>
                {run.room && (
                  <span>
                    Room: {run.room.environmentTemplateKey} / {run.room.roomId}
                  </span>
                )}
              </div>
              {run.historical ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Historical execution preserved during migration. Its output
                    was not checked against the new public contract.
                  </p>
                  <details>
                    <summary className="cursor-pointer text-sm">
                      Original execution snapshot
                    </summary>
                    <JsonPanel value={run.historicalSnapshot} />
                  </details>
                </>
              ) : run.outputValidation === "valid" &&
                runStatus === "completed" ? (
                <JsonPanel value={run.output} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  This run has no validated public output.
                </p>
              )}
            </Panel>
          ) : null}

          {bundle.childRuns?.length ? (
            <details className="rounded-surface border p-4">
              <summary className="cursor-pointer text-sm font-medium">
                Child runs and invocation attempts ({bundle.childRuns.length})
              </summary>
              <ul className="mt-3 grid gap-2 text-sm">
                {bundle.childRuns.map((child) => (
                  <li
                    className="flex flex-wrap items-center gap-3"
                    key={child.id}
                  >
                    <Link
                      className="underline"
                      to={`/workflows/runs/${child.id}` as never}
                    >
                      {child.id}
                    </Link>
                    <span>Attempt {child.invocationAttempt}</span>
                    <StatusBadge status={child.status} />
                    {child.error ? (
                      <span className="text-destructive">{child.error}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="grid items-start gap-4 lg:grid-cols-[264px_minmax(0,1fr)]">
            <RunSidebar
              annotationCount={annotations.length}
              artifactCount={artifacts.length}
              eventCount={events.length}
              regionCount={dynamicRegions.length}
              distributedTaskCount={distributedTasks.length}
              hasDistribution={
                bundle.template?.graphVersion === "workflow-graph/v3"
              }
              selection={selection}
              steps={executionSteps}
              transferCount={transfers.length}
              onSelect={setSelection}
            />

            <main className="grid min-w-0 gap-4">
              {selectedStep ? (
                <StepPane logs={logs} step={selectedStep} />
              ) : selection === "timeline" ? (
                <Timeline events={events} />
              ) : selection === "artifacts" ? (
                <ArtifactsPane artifacts={artifacts} />
              ) : selection === "distributed-tasks" ? (
                <DistributedTasksPane
                  artifacts={artifacts}
                  membersByPartition={bundle.resolvedMembersByPartition ?? {}}
                  tasks={distributedTasks}
                />
              ) : selection === "transfers" ? (
                <TransfersPane transfers={transfers} />
              ) : selection === "payload" ? (
                <PayloadPane bundle={bundle} run={run} />
              ) : selection === "regions" ? (
                <DynamicRegionsPane
                  conditions={conditionEvaluations}
                  endpoint={endpoint}
                  regions={dynamicRegions}
                  runId={stringValue(run.id)}
                />
              ) : (
                <SummaryPane
                  annotations={annotations}
                  artifacts={artifacts}
                  beamTransfers={beamTransferLinks(
                    executionSteps,
                    organizationsQuery.data?.consoleUrl,
                  )}
                  decisionEvaluations={data?.decisionEvaluations ?? []}
                  edges={workflowEdges}
                  failure={failure}
                  stepRuns={stepRuns}
                  steps={executionSteps}
                  triggerEdges={workflowTriggerEdges}
                  triggers={workflowTriggers}
                  workflowSteps={workflowSteps}
                  onSelect={setSelection}
                />
              )}
            </main>
          </div>
        </>
      )}
    </div>
  );
}

function RunMetaBar({
  artifactCount,
  duration,
  run,
  steps,
  transfers,
}: {
  artifactCount: number;
  duration: string;
  run: RunRecord;
  steps: ExecutionStep[];
  transfers: TransferRunRecord[];
}) {
  const completed = steps.filter(
    (step) => normalizeStatus(step.status) === "completed",
  ).length;

  return (
    <dl className="grid overflow-hidden rounded-surface border bg-card sm:grid-cols-2 lg:grid-cols-5">
      <MetaCell
        label="Status"
        value={
          <span className="flex items-center gap-1.5">
            <StatusIcon className="h-3.5 w-3.5" status={run.status} />
            {statusLabel(run.status)}
          </span>
        }
      />
      <MetaCell label="Total duration" value={duration} />
      <MetaCell
        label={steps.length ? "Steps" : "Transfers"}
        value={
          steps.length
            ? `${completed}/${steps.length} completed`
            : transferSummary(transfers)
        }
      />
      <MetaCell
        label="Started"
        value={
          <DateText value={run.startedAt ?? run.queuedAt ?? run.createdAt} />
        }
      />
      <MetaCell label="Artifacts" value={String(artifactCount)} />
    </dl>
  );
}

function MetaCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 border-b px-4 py-3 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate text-sm font-medium tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function RunSidebar({
  annotationCount,
  artifactCount,
  eventCount,
  regionCount,
  distributedTaskCount,
  hasDistribution,
  selection,
  steps,
  transferCount,
  onSelect,
}: {
  annotationCount: number;
  artifactCount: number;
  eventCount: number;
  regionCount: number;
  distributedTaskCount: number;
  hasDistribution: boolean;
  selection: Selection;
  steps: ExecutionStep[];
  transferCount: number;
  onSelect(selection: Selection): void;
}) {
  return (
    <aside className="grid gap-3 lg:sticky lg:top-4">
      <nav className="rounded-surface border bg-card p-1.5">
        <NavItem
          badge={annotationCount ? String(annotationCount) : undefined}
          badgeTone="danger"
          icon={ListChecks}
          label="Summary"
          selected={selection === "summary"}
          onSelect={() => onSelect("summary")}
        />
      </nav>

      <div className="overflow-hidden rounded-surface border bg-card">
        <div className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Steps
        </div>
        {steps.length ? (
          <div className="grid gap-0.5 overflow-y-auto p-1.5 lg:max-h-[calc(100vh-22rem)]">
            {steps.map((step) => (
              <button
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm transition-colors hover:bg-secondary/70",
                  selection === `step:${step.id}` && "bg-secondary",
                )}
                key={step.id}
                onClick={() => onSelect(`step:${step.id}`)}
                title={step.name}
                type="button"
              >
                <StatusIcon status={step.status} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    unreachedStatuses.has(normalizeStatus(step.status)) &&
                      "text-muted-foreground",
                    selection === `step:${step.id}` && "font-medium",
                  )}
                >
                  {step.name}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {step.startedAt
                    ? durationLabel(step.startedAt, step.completedAt)
                    : ""}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            No steps recorded.
          </p>
        )}
      </div>

      <nav className="grid gap-0.5 rounded-surface border bg-card p-1.5">
        <div className="px-1.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Run details
        </div>
        <NavItem
          badge={eventCount ? String(eventCount) : undefined}
          icon={History}
          label="Timeline"
          selected={selection === "timeline"}
          onSelect={() => onSelect("timeline")}
        />
        {regionCount ? (
          <NavItem
            badge={String(regionCount)}
            icon={GitBranch}
            label="Dynamic regions"
            selected={selection === "regions"}
            onSelect={() => onSelect("regions")}
          />
        ) : null}
        {hasDistribution || distributedTaskCount > 0 ? (
          <NavItem
            badge={String(distributedTaskCount)}
            icon={Network}
            label="Distributed tasks"
            selected={selection === "distributed-tasks"}
            onSelect={() => onSelect("distributed-tasks")}
          />
        ) : null}
        <NavItem
          badge={artifactCount ? String(artifactCount) : undefined}
          icon={Package}
          label="Artifacts"
          selected={selection === "artifacts"}
          onSelect={() => onSelect("artifacts")}
        />
        {transferCount ? (
          <NavItem
            badge={String(transferCount)}
            icon={ArrowRightLeft}
            label="Transfers"
            selected={selection === "transfers"}
            onSelect={() => onSelect("transfers")}
          />
        ) : null}
        <NavItem
          icon={Braces}
          label="Payload"
          selected={selection === "payload"}
          onSelect={() => onSelect("payload")}
        />
      </nav>
    </aside>
  );
}

function NavItem({
  badge,
  badgeTone,
  icon: Icon,
  label,
  selected,
  onSelect,
}: {
  badge?: string;
  badgeTone?: "danger";
  icon: LucideIcon;
  label: string;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm transition-colors hover:bg-secondary/70",
        selected && "bg-secondary font-medium",
      )}
      onClick={onSelect}
      type="button"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
            badgeTone === "danger"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function SummaryPane({
  annotations,
  artifacts,
  beamTransfers,
  decisionEvaluations,
  edges,
  failure,
  stepRuns,
  steps,
  triggerEdges,
  triggers,
  workflowSteps,
  onSelect,
}: {
  annotations: Annotation[];
  artifacts: ArtifactRecord[];
  beamTransfers: BeamTransferLink[];
  decisionEvaluations: DecisionEvaluationRecord[];
  edges: WorkflowEdgeRecord[];
  failure: Failure | null;
  stepRuns: RunBundle["stepRuns"];
  steps: ExecutionStep[];
  triggerEdges: WorkflowTriggerEdgeRecord[];
  triggers: WorkflowTriggerRecord[];
  workflowSteps: WorkflowStepRecord[];
  onSelect(selection: Selection): void;
}) {
  const branches = buildBranchSummary(
    edges,
    stepRuns ?? [],
    workflowSteps,
    triggerEdges,
    triggers,
  ).filter((branch) => branch.condition !== null);

  return (
    <>
      {failure ? (
        <div
          className={cn(
            "rounded-surface border p-4",
            statusTone(failure.status) === "danger"
              ? "border-destructive/40 bg-destructive/5"
              : "border-border bg-muted/40",
          )}
        >
          <div
            className={cn(
              "flex items-center gap-2 text-sm font-semibold",
              statusTone(failure.status) === "danger"
                ? "text-destructive"
                : "text-foreground",
            )}
          >
            <AlertTriangle className="h-4 w-4" />
            {`${failure.stepName ?? "Run"} ${statusLabel(failure.status).toLowerCase()}`}
          </div>
          <p
            className={cn(
              "mt-2 break-words text-sm",
              statusTone(failure.status) === "danger"
                ? "text-destructive/90"
                : "text-muted-foreground",
            )}
          >
            {failure.message}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>
              <DateText value={failure.timestamp} />
            </span>
            {failure.action ? (
              <Link
                className="font-medium text-foreground underline underline-offset-4"
                to={failure.action.href as never}
              >
                {failure.action.label}
              </Link>
            ) : null}
            {failure.stepRunId ? (
              <button
                className="font-medium text-foreground underline underline-offset-4"
                onClick={() => onSelect(`step:${failure.stepRunId}`)}
                type="button"
              >
                View step
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {beamTransfers.length ? (
        <Panel
          description="The Beam transfers this run started. The Console shows their delivery and charge."
          title="Beam transfers"
        >
          <div className="grid gap-2">
            {beamTransfers.map((transfer) => (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-control border p-3"
                key={transfer.stepRunId}
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <StatusIcon
                      className="h-3.5 w-3.5"
                      status={transfer.status}
                    />
                    {transfer.stepName}
                  </p>
                  <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                    {transfer.transferId}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs">
                  {transfer.consoleHref ? (
                    <a
                      className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
                      href={transfer.consoleHref}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open in Console
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                  <button
                    className="font-medium text-foreground underline underline-offset-4"
                    onClick={() => onSelect(`step:${transfer.stepRunId}`)}
                    type="button"
                  >
                    View step
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {annotations.length ? (
        <Panel
          description={`${annotations.length} error${annotations.length > 1 ? "s" : ""} recorded during this run`}
          title="Annotations"
        >
          <div className="grid gap-2">
            {annotations.map((annotation, index) => (
              <div
                className="rounded-control border border-destructive/30 bg-destructive/5 p-3"
                key={`${annotation.id}-${index}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-destructive">
                    {annotation.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <DateText value={annotation.at} />
                  </span>
                </div>
                <p className="mt-1.5 break-words text-sm text-muted-foreground">
                  {shortText(annotation.message, 360)}
                </p>
                {annotation.stepId ? (
                  <button
                    className="mt-2 text-xs font-medium underline underline-offset-4"
                    onClick={() => onSelect(`step:${annotation.stepId}`)}
                    type="button"
                  >
                    View step
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {workflowSteps.length ? (
        <WorkflowExecutionGraph
          edges={edges}
          stepRuns={stepRuns ?? []}
          steps={workflowSteps}
          triggerEdges={triggerEdges}
          triggers={triggers}
        />
      ) : null}

      {steps.length ? (
        <Panel
          description="Every step in workflow order. Select one to inspect its payload."
          title="Steps"
        >
          <div className="overflow-hidden rounded-control">
            <div className="divide-y divide-border/60">
              {steps.map((step) => (
                <button
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-secondary/60"
                  key={step.id}
                  onClick={() => onSelect(`step:${step.id}`)}
                  type="button"
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded-control bg-muted font-mono text-xs">
                    {step.order + 1}
                  </span>
                  <StatusIcon status={step.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {step.name}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {step.actionPackageName}
                    </span>
                  </span>
                  {step.error ? (
                    <span className="hidden max-w-56 truncate text-xs text-destructive md:block">
                      {shortText(step.error, 60)}
                    </span>
                  ) : null}
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {step.startedAt
                      ? durationLabel(step.startedAt, step.completedAt)
                      : "-"}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        </Panel>
      ) : null}

      {decisionEvaluations.length ? (
        <Panel
          description="How each decision resolved, and any failure it absorbed."
          title="Decisions"
        >
          <div className="overflow-hidden rounded-control border">
            <div className="divide-y">
              {decisionEvaluations.map((evaluation) => (
                <div
                  className="flex items-center justify-between gap-4 px-3 py-2.5"
                  key={evaluation.id ?? evaluation.decisionId}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {evaluation.decisionId}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {evaluation.joinMode === "any_settled"
                          ? "any input"
                          : "every input"}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {decisionReasonLabel(evaluation.reason)}
                      {evaluation.takenBranch
                        ? ` · ${evaluation.takenBranch}`
                        : ""}
                      {evaluation.handledFailures?.length
                        ? ` · absorbed ${evaluation.handledFailures.join(", ")}`
                        : ""}
                    </div>
                  </div>
                  <StatusBadge
                    status={evaluation.takenBranch ? "completed" : "skipped"}
                    withIcon
                  />
                </div>
              ))}
            </div>
          </div>
        </Panel>
      ) : null}

      {branches.length ? (
        <Panel
          description="Conditional edges evaluated during this run."
          title="Branches taken"
        >
          <div className="overflow-hidden rounded-control border">
            <div className="divide-y">
              {branches.map((branch) => (
                <div
                  className="flex items-center justify-between gap-4 px-3 py-2.5"
                  key={branch.id}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {branch.from} → {branch.to}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      conditional edge
                    </div>
                  </div>
                  <StatusBadge
                    status={branch.taken ? "completed" : "skipped"}
                    withIcon
                  />
                </div>
              ))}
            </div>
          </div>
        </Panel>
      ) : null}

      {artifacts.length ? (
        <Panel
          description={`${artifacts.length} produced by this run`}
          title="Artifacts"
        >
          <ArtifactList artifacts={artifacts} />
        </Panel>
      ) : null}
    </>
  );
}

function StepPane({
  logs,
  step,
}: {
  logs: RunLogRecord[];
  step: ExecutionStep;
}) {
  const beam = step.run ? beamDetails(step.run) : null;
  const roomState = (step.run?.state ?? {}) as Record<string, unknown>;
  const assignmentValues = valueRecord(step.run?.metadata).executorAssignments;
  const executorAssignments = Array.isArray(assignmentValues)
    ? assignmentValues
    : [];
  const rejectionValues = valueRecord(step.run?.metadata).executorRejections;
  const executorRejections = Array.isArray(rejectionValues)
    ? rejectionValues
    : [];
  const roomRecipients = Array.isArray(roomState.recipients)
    ? (roomState.recipients as Record<string, unknown>[])
    : [];
  const roomSource = roomSourcePresentation(roomState.source);
  const roomChildren = Array.isArray(roomState.childExecutions)
    ? (roomState.childExecutions as Record<string, unknown>[])
    : [];
  const roomChildByRecipient = new Map(
    roomChildren.map((child) => [
      String(valueRecord(child.target).member_id ?? ""),
      child,
    ]),
  );
  const roomLabels: Record<string, string> = {
    environmentTemplateKey: "Beam environment",
    roomId: "Room",
    channelId: "Channel",
    publicationId: "Publication",
    beamStatus: "Transfer status",
    destinationsCompleted: "Recipients completed",
    chunksCompleted: "Chunks delivered",
    chunkSizeBytes: "Chunk size",
    chunkCount: "Chunks total",
    expiresAt: "Expires",
    cancellationStatus: "Cancellation",
    cancellationError: "Cancellation detail",
  };
  const isBeamTransfer = step.actionPackageName === "@beam/transfer";
  const stepLogs = logsForStep(logs, step);
  const progress = step.run?.progress;

  return (
    <>
      <div className="rounded-surface border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2.5">
              <StatusIcon className="h-[18px] w-[18px]" status={step.status} />
              <h2 className="truncate text-base font-semibold tracking-tight">
                {step.name}
              </h2>
              <StatusBadge status={step.status} />
            </div>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {step.actionPackageName}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Duration{" "}
              <span className="font-medium tabular-nums text-foreground">
                {step.startedAt
                  ? durationLabel(step.startedAt, step.completedAt)
                  : "-"}
              </span>
            </span>
            <span>
              Attempt{" "}
              <span className="font-medium tabular-nums text-foreground">
                {step.attempt ?? "-"}
              </span>
            </span>
          </div>
        </div>

        <dl className="grid sm:grid-cols-3">
          <MetaCell
            label="Started"
            value={<DateText value={step.startedAt} />}
          />
          <MetaCell
            label="Completed"
            value={<DateText value={step.completedAt} />}
          />
          <MetaCell
            label="Step ID"
            value={
              <code className="text-xs">{step.workflowStepId || step.id}</code>
            }
          />
        </dl>
      </div>

      {step.error ? (
        <div className="rounded-surface border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Step error
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-destructive/90">
            {step.error}
          </p>
        </div>
      ) : null}

      {progress && progress.total ? (
        <Panel title="Progress">
          <div className="grid gap-2">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-success transition-all"
                style={{
                  width: `${Math.min(100, Math.round(((progress.completed ?? 0) / progress.total) * 100))}%`,
                }}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
              <span>{progress.completed ?? 0} completed</span>
              <span>{progress.running ?? 0} running</span>
              <span>{progress.failed ?? 0} failed</span>
              <span>{progress.total} total</span>
            </div>
          </div>
        </Panel>
      ) : null}

      {step.actionPackageName === "@beam/room-transfer" ? (
        <Panel title="Room transfer">
          <div className="grid gap-3 rounded-control border p-3 md:grid-cols-2">
            <Fact label="Source member" value={String(roomSource.memberId)} />
            <Fact
              label="Source type"
              value={roomMemberKindLabel(roomSource.kind)}
            />
            {Object.entries(step.run?.state ?? {})
              .filter(([key]) =>
                [
                  "environmentTemplateKey",
                  "roomId",
                  "channelId",
                  "publicationId",
                  "beamStatus",
                  "destinationsCompleted",
                  "chunksCompleted",
                  "chunkSizeBytes",
                  "chunkCount",
                  "expiresAt",
                  "cancellationStatus",
                  "cancellationError",
                ].includes(key),
              )
              .map(([key, value]) => (
                <Fact
                  key={key}
                  label={roomLabels[key] ?? key}
                  value={
                    key === "chunkSizeBytes"
                      ? (formatBytes(Number(value)) ?? "-")
                      : String(value ?? "-")
                  }
                />
              ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Recipient delivery progress</caption>
              <thead>
                <tr>
                  <th className="p-2 text-left">Recipient</th>
                  <th className="p-2 text-left">Type</th>
                  <th className="p-2 text-left">Protection</th>
                  <th className="p-2 text-left">Status</th>
                  <th className="p-2 text-right">Chunks</th>
                  <th className="p-2 text-left">Destination</th>
                  <th className="p-2 text-left">Detail</th>
                </tr>
              </thead>
              <tbody>
                {roomRecipients.map((recipient) => {
                  const child = roomChildByRecipient.get(
                    String(recipient.member_id),
                  );
                  const presentation = roomRecipientPresentation(
                    roomState,
                    recipient,
                    valueRecord(child),
                  );
                  const { destination } = presentation;
                  return (
                    <tr key={String(recipient.member_id)}>
                      <td className="p-2">{String(recipient.member_id)}</td>
                      <td className="p-2">
                        {roomMemberKindLabel(presentation.kind)}
                      </td>
                      <td className="p-2">
                        {roomProtectionLabel(presentation.protection)}
                      </td>
                      <td className="p-2">{String(recipient.state)}</td>
                      <td className="p-2 text-right">
                        {String(recipient.completed_chunks ?? 0)}
                      </td>
                      <td className="p-2">
                        {String(
                          destination.resource_id ??
                            destination.agent_id ??
                            destination.member_id ??
                            "-",
                        )}
                      </td>
                      <td className="p-2">
                        {String(recipient.unavailable_reason ?? "")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <RoomExecutionEvidence
            evidence={valueRecord(roomState.execution)}
            inspection={valueRecord(roomState.executionInspection)}
          />
        </Panel>
      ) : null}

      {isBeamTransfer && beam ? (
        <Panel title="Beam transfer">
          <div className="grid gap-3 rounded-control border p-3 md:grid-cols-2 xl:grid-cols-3">
            <Fact label="Source" value={beam.source || "-"} />
            <Fact label="Destination" value={beam.destination || "-"} />
            <Fact label="Transfer id" value={beam.transferId || "-"} />
            <Fact
              label="Beam status"
              value={
                beam.beamStatus === "integrity_check"
                  ? "Integrity check"
                  : beam.beamStatus || "-"
              }
            />
            {beam.integrityCheckWarning ? (
              <Fact
                label="Integrity check"
                value={beam.integrityCheckWarning}
              />
            ) : null}
            <Fact
              label="SDK errors"
              value={beam.sdkErrors.length ? beam.sdkErrors.join("; ") : "-"}
            />
          </div>
        </Panel>
      ) : null}

      {executorAssignments.length > 0 && (
        <Panel title="Execution attempts">
          {executorAssignments.map((entry: unknown) => {
            const assignment = valueRecord(entry);
            return (
              <div
                key={String(assignment.id)}
                className="grid gap-2 rounded-control border p-3"
              >
                <Fact
                  label="Target"
                  value={String(
                    valueRecord(assignment.declaredTarget).kind ??
                      assignment.backend,
                  )}
                />
                <Fact
                  label="Executor"
                  value={`${assignment.executorId} / ${assignment.memberId ?? ""}`}
                />
                <Fact label="Attempt" value={String(assignment.attempt)} />
                <Fact label="State" value={String(assignment.state)} />
                <Fact
                  label="Cleanup"
                  value={
                    assignment.cleanupConfirmedAt
                      ? "Confirmed"
                      : assignment.cancelRequestedAt
                        ? "Requested; awaiting confirmation"
                        : "Not requested"
                  }
                />
                {Boolean(assignment.error) && (
                  <p role="alert" className="text-sm text-destructive">
                    {String(
                      valueRecord(assignment.error).message ??
                        valueRecord(assignment.error).code,
                    )}
                  </p>
                )}
                {!isEmptyValue(assignment.progress) && (
                  <JsonPanel value={assignment.progress} />
                )}
              </div>
            );
          })}
        </Panel>
      )}
      {executorRejections.length > 0 && (
        <Panel title="Executor availability">
          {executorRejections.map((entry: unknown) => {
            const rejection = valueRecord(entry);
            return (
              <p key={String(rejection.memberId)} className="text-sm">
                {String(rejection.memberId)}: {String(rejection.message)}
              </p>
            );
          })}
        </Panel>
      )}

      <div className="overflow-hidden rounded-surface border bg-card">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold tracking-tight">Step payload</h3>
          {step.run?.childRunId ? (
            <div className="grid gap-2 py-2">
              <Link
                className="text-sm underline"
                to={`/workflows/runs/${step.run.childRunId}` as never}
              >
                Open child run {step.run.childRunId}
              </Link>
              <p className="text-xs text-muted-foreground">
                Invocation attempt {step.run.attempt ?? 1}. The step output is
                the child’s public result.
              </p>
            </div>
          ) : null}
          <p className="mt-0.5 text-xs text-muted-foreground">
            Expand a section to read the recorded values.
          </p>
        </div>
        <div className="divide-y">
          <LogSection
            defaultOpen={!isEmptyValue(step.run?.input)}
            empty={isEmptyValue(step.run?.input)}
            title="Input"
          >
            <JsonPanel className="max-h-96" value={step.run?.input} />
          </LogSection>
          <LogSection
            defaultOpen={!isEmptyValue(step.run?.output)}
            empty={isEmptyValue(step.run?.output)}
            title="Output"
          >
            <JsonPanel className="max-h-96" value={step.run?.output} />
          </LogSection>
          <LogSection empty={isEmptyValue(step.run?.metadata)} title="Metadata">
            <JsonPanel className="max-h-96" value={step.run?.metadata} />
          </LogSection>
          <LogSection empty={isEmptyValue(step.run?.state)} title="State">
            <JsonPanel className="max-h-96" value={step.run?.state} />
          </LogSection>
          {step.step ? (
            <LogSection empty={isEmptyValue(step.step.config)} title="Config">
              <JsonPanel className="max-h-96" value={step.step.config} />
            </LogSection>
          ) : null}
        </div>
      </div>

      {stepLogs.length ? (
        <Panel
          description={`${stepLogs.length} event${stepLogs.length > 1 ? "s" : ""} referencing this step`}
          title="Log events"
        >
          <div className="grid gap-2">
            {stepLogs.map((log) => (
              <details className="group rounded-surface border" key={log.id}>
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {log.event}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <DateText value={log.createdAt} />
                  </span>
                </summary>
                <div className="px-3 pb-3">
                  <JsonPanel value={log.payload} />
                </div>
              </details>
            ))}
          </div>
        </Panel>
      ) : null}
    </>
  );
}

function valueRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function roomProtectionLabel(value: unknown) {
  if (value === "room_mls_e2ee") return "Room E2EE";
  if (value === "provider_tls") return "Provider TLS";
  return String(value ?? "-");
}

/** Collapsible section styled after a CI log group. */
function LogSection({
  children,
  defaultOpen,
  empty,
  title,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  empty?: boolean;
  title: string;
}) {
  return (
    <details className="group" open={defaultOpen && !empty}>
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm transition-colors hover:bg-secondary/50",
          empty && "text-muted-foreground",
        )}
      >
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="flex-1 font-medium">{title}</span>
        {empty ? <span className="text-xs">empty</span> : null}
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) {
    return (
      <EmptyState
        description="Events appear here as the run progresses."
        title="No events recorded"
      />
    );
  }

  return (
    <Panel description="Run events in chronological order." title="Timeline">
      <ol className="relative grid gap-3 before:absolute before:bottom-3 before:left-[9px] before:top-3 before:w-px before:bg-border">
        {events.map((event, index) => (
          <li
            className="relative grid grid-cols-[20px_minmax(0,1fr)] gap-3"
            key={`${event.at}:${event.title}:${index}`}
          >
            <span className="z-10 mt-1.5 grid size-5 place-items-center rounded-full border bg-background">
              <span
                className={cn("size-2 rounded-full", timelineDot(event.tone))}
              />
            </span>
            <div className="min-w-0 rounded-control border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{event.title}</div>
                <span className="text-xs text-muted-foreground">
                  <DateText value={event.at} />
                </span>
              </div>
              {event.detail ? (
                <p
                  className={cn(
                    "mt-1 break-words text-sm text-muted-foreground",
                    event.tone === "danger" && "text-destructive",
                  )}
                >
                  {event.detail}
                </p>
              ) : null}
              {isEmptyValue(event.payload) ? null : (
                <details className="group mt-2">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground">
                    <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                    Payload
                  </summary>
                  <JsonPanel className="mt-1.5" value={event.payload} />
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function timelineDot(tone: StatusTone) {
  switch (tone) {
    case "success":
      return "bg-success";
    case "danger":
      return "bg-destructive";
    case "active":
    case "pending":
      return "bg-warning";
    default:
      return "bg-muted-foreground";
  }
}

function ArtifactsPane({ artifacts }: { artifacts: ArtifactRecord[] }) {
  if (!artifacts.length) {
    return (
      <EmptyState
        description="Files produced by this run will be listed here."
        icon={Package}
        title="No artifacts yet"
      />
    );
  }

  return (
    <Panel
      description={`${artifacts.length} recorded artifact${artifacts.length > 1 ? "s" : ""}`}
      title="Artifacts"
    >
      <ArtifactList artifacts={artifacts} />
    </Panel>
  );
}

function ArtifactList({ artifacts }: { artifacts: ArtifactRecord[] }) {
  return (
    <div className="grid gap-2">
      {artifacts.map((artifact) => (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-control border p-3"
          key={artifact.id}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{artifact.name ?? artifact.id}</span>
            </div>
            <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {artifact.uri}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Badge variant="outline">{artifact.type ?? "artifact"}</Badge>
            {artifact.mediaType ? (
              <Badge variant="secondary">{artifact.mediaType}</Badge>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function TransfersPane({ transfers }: { transfers: TransferRunRecord[] }) {
  if (!transfers.length) {
    return (
      <EmptyState
        description="This run recorded no legacy transfer activity."
        icon={ArrowRightLeft}
        title="No transfers"
      />
    );
  }

  return (
    <Panel
      description="Legacy transfer activity for this run."
      title="Transfers"
    >
      <div className="overflow-hidden rounded-control border">
        <div className="divide-y">
          {transfers.map((transfer) => (
            <div
              className="flex flex-wrap items-center gap-3 px-3 py-2.5"
              key={transfer.id}
            >
              <StatusIcon status={transfer.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {transfer.sourceName ?? "-"} →{" "}
                  {transfer.destinationName ?? "-"}
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                  {transfer.destinationObjectKey ?? transfer.id}
                </div>
                {transfer.error ? (
                  <div className="mt-1.5 break-words text-xs text-destructive">
                    {transfer.error}
                  </div>
                ) : null}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                <DateText value={transfer.createdAt} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function DynamicRegionsPane({
  conditions,
  endpoint,
  regions,
  runId,
}: {
  conditions: ConditionEvaluationRecord[];
  endpoint: string;
  regions: DynamicRegionRecord[];
  runId: string;
}) {
  const queryClient = useQueryClient();
  const [selectedControlId, setSelectedControlId] = useState("");
  const [offset, setOffset] = useState(0);
  const selectedRegion =
    regions.find(
      (region) => stringValue(region.controlId) === selectedControlId,
    ) ?? regions[0];
  const controlId = stringValue(selectedRegion?.controlId);
  const instancesPath =
    runId && controlId
      ? `/studio/workflow-runs/${encodeURIComponent(runId)}/regions/${encodeURIComponent(controlId)}/instances?offset=${offset}&limit=50`
      : "";
  const instancesQuery = useQuery({
    queryKey: ["workflow-dynamic-instances", runId, controlId, offset],
    queryFn: () => apiGet<DynamicInstancesPage>(instancesPath),
    enabled: Boolean(instancesPath),
  });
  const regionMutation = useMutation({
    mutationFn: (operation: "cancel" | "retry") =>
      apiSend(
        "POST",
        `/studio/workflow-runs/${encodeURIComponent(runId)}/regions/${encodeURIComponent(controlId)}/${operation}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [endpoint] });
      queryClient.invalidateQueries({
        queryKey: ["workflow-dynamic-instances", runId, controlId],
      });
    },
  });
  const page = instancesQuery.data;
  const pageEnd = Math.min(
    (page?.offset ?? offset) + (page?.instances.length ?? 0),
    page?.total ?? 0,
  );
  const regionStatus = normalizeStatus(selectedRegion?.status);

  if (!regions.length) {
    return (
      <EmptyState
        description="This run did not expand a loop or fan-out region."
        icon={GitBranch}
        title="No dynamic regions"
      />
    );
  }

  return (
    <div className="grid gap-4">
      <Panel
        description="Loops and fan-outs stay compact on the canvas. Inspect their aggregate state and open individual action instances here."
        title="Dynamic regions"
      >
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {regions.map((region) => {
            const regionControlId = stringValue(region.controlId);
            const total = Number(region.instanceCount ?? 0);
            const completed = Number(region.completedCount ?? 0);
            const pending = Number(region.pendingCount ?? 0);
            const running = Number(region.runningCount ?? 0);
            const failed = Number(region.failedCount ?? 0);
            const cancelled = Number(region.cancelledCount ?? 0);
            return (
              <button
                className={cn(
                  "rounded-control border p-3 text-left transition-colors hover:bg-secondary/50",
                  controlId === regionControlId &&
                    "border-primary bg-primary/5",
                )}
                key={region.id ?? regionControlId}
                onClick={() => {
                  setSelectedControlId(regionControlId);
                  setOffset(0);
                }}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <code className="truncate text-xs font-semibold">
                    {regionControlId}
                  </code>
                  <StatusBadge status={region.status ?? "unknown"} />
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {region.kind === "fan-out"
                    ? "Fan-out/fan-in"
                    : "Bounded loop"}
                  {region.concurrencyLimit
                    ? ` · concurrency ${region.concurrencyLimit}`
                    : ""}
                </div>
                <div className="mt-3 grid grid-cols-5 gap-1 text-center text-[11px] tabular-nums">
                  <RegionCount label="Done" value={completed} />
                  <RegionCount label="Running" value={running} />
                  <RegionCount label="Pending" value={pending} />
                  <RegionCount label="Failed" value={failed} />
                  <RegionCount label="Cancelled" value={cancelled} />
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      {selectedRegion ? (
        <Panel
          description={`${Number(selectedRegion.instanceCount ?? 0)} action instance${Number(selectedRegion.instanceCount ?? 0) === 1 ? "" : "s"}, ordered by shard/iteration then body step.`}
          title={`Instances · ${controlId}`}
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {page?.total
                ? `Showing ${page.offset + 1}–${pageEnd} of ${page.total}`
                : "No expanded instances yet"}
            </div>
            <div className="flex gap-2">
              <ConfirmationDialog
                confirmLabel="Cancel region"
                description={`This cancels pending and active instances in ${controlId}. Completed instances and unrelated regions are preserved.`}
                onConfirm={() => regionMutation.mutateAsync("cancel")}
                title="Cancel this region?"
                trigger={
                  <Button
                    disabled={
                      regionMutation.isPending ||
                      !["pending", "expanding", "running", "queued"].includes(
                        regionStatus,
                      )
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <X className="h-4 w-4" /> Cancel region
                  </Button>
                }
              />
              <ConfirmationDialog
                confirmLabel="Retry instances"
                description={`This retries failed or unfinished instances in ${controlId}. Completed instances will not run again.`}
                onConfirm={() => regionMutation.mutateAsync("retry")}
                title="Retry failed instances?"
                trigger={
                  <Button
                    disabled={
                      regionMutation.isPending ||
                      !["failed", "cancelled"].includes(regionStatus)
                    }
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    <Repeat className="h-4 w-4" /> Retry failed instances
                  </Button>
                }
              />
            </div>
          </div>
          {regionMutation.error ? (
            <div className="mb-3 rounded-control border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {String(regionMutation.error)}
            </div>
          ) : null}
          {instancesQuery.isPending ? (
            <div className="grid gap-2">
              <Skeleton className="h-12 rounded-control" />
              <Skeleton className="h-12 rounded-control" />
            </div>
          ) : instancesQuery.error ? (
            <div className="rounded-control border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {String(instancesQuery.error)}
            </div>
          ) : page?.instances.length ? (
            <div className="overflow-hidden rounded-control border">
              <div className="divide-y">
                {page.instances.map((instance) => {
                  const instanceConditions = conditions.filter(
                    (condition) =>
                      stringValue(condition.dynamicInstanceId) ===
                      stringValue(instance.id),
                  );
                  return (
                    <details className="group" key={instance.id}>
                      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 hover:bg-secondary/50">
                        <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                          #{Number(instance.instanceIndex ?? 0) + 1}
                        </span>
                        <StatusIcon status={instance.status} />
                        <code className="min-w-0 flex-1 truncate text-xs">
                          {instance.workflowStepId}
                        </code>
                        <Badge variant="outline">
                          attempt {instance.currentAttempt ?? 1}
                        </Badge>
                        <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
                      </summary>
                      <div className="grid gap-3 border-t bg-muted/20 p-3 lg:grid-cols-3">
                        <JsonPanel value={instance.context ?? {}} />
                        <JsonPanel value={instance.input ?? {}} />
                        <JsonPanel value={instance.output ?? {}} />
                        {instance.error ? (
                          <p className="text-sm text-destructive lg:col-span-3">
                            {instance.error}
                          </p>
                        ) : null}
                        {instanceConditions.length ? (
                          <div className="grid gap-1 text-xs lg:col-span-3">
                            <strong>Condition traces</strong>
                            {instanceConditions.map((condition) => (
                              <div
                                className="flex flex-wrap items-center gap-2 rounded-control-compact border bg-background px-2 py-1.5"
                                key={condition.id}
                              >
                                <StatusBadge
                                  status={condition.outcome ?? "unknown"}
                                />
                                <code>
                                  {condition.fromNodeId} → {condition.toNodeId}
                                </code>
                                <span className="ml-auto text-muted-foreground">
                                  {conditionReasonLabel(condition.reason)}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="rounded-control border p-4 text-sm text-muted-foreground">
              The region has no materialized action instances yet.
            </p>
          )}
          {(page?.total ?? 0) > 50 ? (
            <div className="mt-3 flex justify-end gap-2">
              <Button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(offset - 50, 0))}
                size="sm"
                type="button"
                variant="outline"
              >
                Previous
              </Button>
              <Button
                disabled={pageEnd >= (page?.total ?? 0)}
                onClick={() => setOffset(offset + 50)}
                size="sm"
                type="button"
                variant="outline"
              >
                Next
              </Button>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {conditions.length ? (
        <Panel
          description="Persisted decisions explain why a conditional edge was taken, skipped, or never reached without exposing raw condition values."
          title="Condition traces"
        >
          <div className="overflow-hidden rounded-control border">
            <div className="divide-y">
              {conditions.map((condition) => (
                <div
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                  key={condition.id}
                >
                  <StatusBadge status={condition.outcome ?? "unknown"} />
                  <code className="min-w-0 flex-1 truncate text-xs">
                    {condition.fromNodeId} → {condition.toNodeId}
                  </code>
                  <span className="text-xs text-muted-foreground">
                    {conditionReasonLabel(condition.reason)}
                  </span>
                  <DateText value={condition.createdAt} />
                </div>
              ))}
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function RegionCount({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-control-compact bg-muted px-1.5 py-1">
      <strong className="block text-foreground">{value}</strong>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function conditionReasonLabel(reason: unknown) {
  const labels: Record<string, string> = {
    condition_false: "condition evaluated false",
    condition_true: "condition evaluated true",
    unconditional: "unconditional edge",
    upstream_cancelled: "upstream was cancelled",
    upstream_failed: "upstream failed",
    upstream_not_reached: "upstream was not reached",
    upstream_skipped: "upstream was skipped",
  };
  const normalized = stringValue(reason);
  return labels[normalized] ?? statusLabel(normalized || "unknown");
}

function PayloadPane({ bundle, run }: { bundle: RunBundle; run: RunRecord }) {
  const templateId = stringValue(
    run.workflowTemplateId || run.transferTemplateId,
  );

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Panel
        description="The full API response for this run."
        title="Run payload"
      >
        <JsonPanel className="max-h-[60vh]" value={bundle} />
      </Panel>
      <Panel title="Run facts">
        <div className="grid gap-3">
          <Fact
            label="Run ID"
            value={<code className="text-xs">{run.id}</code>}
          />
          <Fact
            label={run.workflowTemplateId ? "Workflow" : "Template"}
            value={
              templateId ? (
                run.workflowTemplateId ? (
                  <Link
                    className="underline underline-offset-4"
                    to={`/workflows/${templateId}/editor` as never}
                  >
                    <code className="text-xs">{templateId}</code>
                  </Link>
                ) : (
                  <code className="text-xs">{templateId}</code>
                )
              ) : (
                "-"
              )
            }
          />
          <Fact
            label="Queued"
            value={<DateText value={run.queuedAt ?? run.createdAt} />}
          />
          <Fact label="Started" value={<DateText value={run.startedAt} />} />
          <Fact
            label="Completed"
            value={<DateText value={run.completedAt} />}
          />
          <Fact label="Updated" value={<DateText value={run.updatedAt} />} />
        </div>
      </Panel>
    </div>
  );
}

function Panel({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="rounded-surface border bg-card">
      <div className="border-b border-border/60 px-4 py-3">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function RunSkeleton() {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[264px_minmax(0,1fr)]">
      <div className="grid gap-3">
        <Skeleton className="h-12 rounded-surface" />
        <Skeleton className="h-56 rounded-surface" />
      </div>
      <div className="grid gap-4">
        <Skeleton className="h-20 rounded-surface" />
        <Skeleton className="h-96 rounded-surface" />
      </div>
    </div>
  );
}

type Annotation = {
  id: string;
  title: string;
  message: string;
  at?: string | null;
  stepId?: string;
};

function buildAnnotations(
  run: RunRecord,
  steps: ExecutionStep[],
  transfers: TransferRunRecord[],
  logs: RunLogRecord[],
): Annotation[] {
  return [
    ...steps
      .filter((step) => stringValue(step.error))
      .map((step) => ({
        id: step.id,
        title: step.name,
        message: stringValue(step.error),
        at: step.completedAt ?? step.startedAt ?? step.createdAt,
        stepId: step.id,
      })),
    ...steps
      .filter(
        (step) =>
          !stringValue(step.error) &&
          failedStatuses.has(normalizeStatus(step.status)),
      )
      .map((step) => ({
        id: `${step.id}-status`,
        title: step.name,
        message: `Step ended with status ${step.status}.`,
        at: step.completedAt ?? step.startedAt,
        stepId: step.id,
      })),
    ...transfers
      .filter((transfer) => stringValue(transfer.error))
      .map((transfer) => ({
        id: stringValue(transfer.id),
        title: `Transfer ${stringValue(transfer.id).slice(0, 8)}`,
        message: stringValue(transfer.error),
        at: transfer.createdAt,
      })),
    ...logs
      .filter((log) => normalizeStatus(log.level) === "error")
      .map((log) => ({
        id: stringValue(log.id),
        title: stringValue(log.event) || "Error event",
        message: JSON.stringify(log.payload ?? {}),
        at: log.createdAt,
      })),
  ];
}

function RoomExecutionEvidence({
  evidence,
  inspection,
}: {
  evidence: Record<string, unknown>;
  inspection: Record<string, unknown>;
}) {
  const [page, setPage] = useState(0);
  const attempts = Array.isArray(evidence.attempts)
    ? evidence.attempts.map(valueRecord)
    : [];
  if (!attempts.length)
    return (
      <p className="p-3 text-sm text-muted-foreground">
        {inspection.status === "access_denied"
          ? "Execution evidence is unavailable with current room permissions."
          : "Execution evidence is pending or unavailable. Refresh to check again."}{" "}
        Missing evidence does not mean zero source reads.
      </p>
    );
  const size = 20;
  return (
    <details className="rounded-control border p-3">
      <summary className="cursor-pointer text-sm font-semibold">
        Worker execution · {attempts.length} range attempts
      </summary>
      <p className="my-3 break-all text-xs text-muted-foreground">
        Runtime execution: {String(evidence.transfer_id ?? "-")}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <caption className="sr-only">
            Runtime assigned ranges and measured source payload
          </caption>
          <thead>
            <tr>
              {[
                "Orchestrator",
                "Worker",
                "Chunks",
                "Attempt",
                "Recipients",
                "Source bytes",
                "Delivered chunks",
                "State",
              ].map((label) => (
                <th key={label} className="p-2 text-left">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {attempts.slice(page * size, (page + 1) * size).map((attempt) => {
              const reads = Array.isArray(attempt.source_reads)
                ? attempt.source_reads.map(valueRecord)
                : [];
              const bytes = reads.reduce(
                (total, read) => total + Number(read.payload_bytes ?? 0),
                0,
              );
              return (
                <tr
                  key={String(attempt.lane_id) + ":" + String(attempt.attempt)}
                  title={String(attempt.lane_id)}
                >
                  <td className="p-2">
                    {String(attempt.orchestrator_id ?? "-")}
                  </td>
                  <td className="p-2">{String(attempt.worker_id ?? "-")}</td>
                  <td className="p-2">
                    {String(attempt.chunk_start)}–{String(attempt.chunk_end)}
                  </td>
                  <td className="p-2">{String(attempt.attempt)}</td>
                  <td className="p-2">
                    {Array.isArray(attempt.target_member_ids)
                      ? attempt.target_member_ids.length
                      : 0}
                  </td>
                  <td className="p-2 tabular-nums">
                    {reads.length ? bytes.toLocaleString() : "Pending"}
                  </td>
                  <td className="p-2">
                    {Array.isArray(attempt.delivered)
                      ? attempt.delivered.length
                      : 0}
                  </td>
                  <td className="p-2">{String(attempt.state)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {attempts.length > size ? (
        <div className="mt-2 flex items-center justify-end gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span className="text-xs">
            Page {page + 1} of {Math.ceil(attempts.length / size)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * size >= attempts.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </details>
  );
}
