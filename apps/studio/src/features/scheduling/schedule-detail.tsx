import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CalendarClock,
  Clock3,
  Coins,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Skeleton, StatusDot } from "@/components/data-page";
import { PageSectionHeader } from "@/components/header-primitives";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { apiGet, apiSend } from "@/lib/api-client";
import { formatCredits } from "@/lib/format-credits";
import {
  executionWindowLabel,
  formatDateTime,
  formatDuration,
  overlapPolicyLabel,
  scheduleBudget,
  scheduleHistory,
  scheduleProjection,
  scheduleRunProgress,
  scheduleSignals,
  scheduleState,
  type ScheduleRecord,
  type ScheduleRunRecord,
  type SchedulesPayload,
} from "./schedule-data";
import {
  MetaItem,
  ProgressMeter,
  SchedulePanel,
  ScheduleStateBadge,
  SignalCard,
} from "./schedule-primitives";

type ScheduleDetailPayload = { schedule: ScheduleRecord };
type RunsPayload = { runs: ScheduleRunRecord[] };

export function ScheduleDetailPage({ scheduleId }: { scheduleId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const endpoint = `/studio/schedules/${scheduleId}`;
  const detailQuery = useQuery({
    queryKey: [endpoint],
    queryFn: () => apiGet<ScheduleDetailPayload>(endpoint),
  });
  const schedulesQuery = useQuery({
    queryKey: ["/studio/schedules"],
    queryFn: () => apiGet<SchedulesPayload>("/studio/schedules"),
  });
  const schedule = detailQuery.data?.schedule;
  const runsEndpoint = schedule
    ? `/studio/runs?transferId=${encodeURIComponent(schedule.transferTemplateId)}`
    : "/studio/runs";
  const runsQuery = useQuery({
    enabled: Boolean(schedule),
    queryKey: [runsEndpoint],
    queryFn: () => apiGet<RunsPayload>(runsEndpoint),
  });
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [endpoint] });
    queryClient.invalidateQueries({ queryKey: ["/studio/schedules"] });
    queryClient.invalidateQueries({ queryKey: [runsEndpoint] });
  };
  const toggleMutation = useMutation({
    mutationFn: () => apiSend("POST", `${endpoint}/toggle`),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: () => apiSend("DELETE", endpoint),
    onSuccess: () => {
      invalidate();
      navigate({ to: "/schedules" as never });
    },
  });

  if (detailQuery.error) {
    return (
      <AppShell contentClassName="px-3 py-4" title="Schedule">
        <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {String(detailQuery.error)}
        </div>
      </AppShell>
    );
  }
  if (detailQuery.isPending || !schedule) {
    return (
      <AppShell contentClassName="px-3 py-4" title="Schedule">
        <div className="grid gap-4">
          <Skeleton className="h-20 rounded-surface" />
          <Skeleton className="h-28 rounded-surface" />
          <Skeleton className="h-72 rounded-surface" />
        </div>
      </AppShell>
    );
  }

  const state = scheduleState(schedule);
  const progress = scheduleRunProgress(schedule);
  const budget = scheduleBudget(schedule);
  const signals = scheduleSignals(schedule);
  const projection = scheduleProjection(schedule);
  const history = scheduleHistory(
    schedule,
    schedulesQuery.data?.schedules ?? [schedule],
    runsQuery.data?.runs ?? [],
  );

  return (
    <AppShell
      contentClassName="px-3 py-4"
      headerActions={
        <>
          {!state.terminal ? (
            <Button
              className="min-w-24"
              disabled={toggleMutation.isPending}
              onClick={() => toggleMutation.mutate()}
              size="sm"
              type="button"
              variant="secondary"
            >
              {schedule.enabled ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
              {schedule.enabled ? "Pause" : "Resume"}
            </Button>
          ) : null}
          <Button asChild size="sm" type="button" variant="outline">
            <Link to={`/schedules/${schedule.id}/edit` as never}>
              <Pencil className="size-4" />
              Edit
            </Link>
          </Button>
          <ConfirmationDialog
            confirmLabel="Delete schedule"
            description={`This permanently deletes the schedule for “${schedule.transferName ?? schedule.transferTemplateId}”.`}
            onConfirm={() => deleteMutation.mutateAsync()}
            title="Delete this schedule?"
            trigger={
              <Button disabled={deleteMutation.isPending} size="sm" type="button" variant="ghost">
                <Trash2 className="size-4" />
                Delete
              </Button>
            }
          />
        </>
      }
      title={`Schedule / ${schedule.transferName ?? schedule.id}`}
    >
      <div className="mx-auto grid w-full max-w-7xl gap-4 pb-10">
        <PageSectionHeader className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CalendarClock className="size-5 text-muted-foreground" />
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {schedule.transferName ?? "Transfer schedule"}
              </h1>
              <ScheduleStateBadge state={state} />
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {schedule.frequency} · {schedule.timezone} · {state.reason}
            </p>
          </div>
          <code className="rounded-control-compact bg-muted px-2 py-1 text-xs text-muted-foreground">
            {schedule.id}
          </code>
        </PageSectionHeader>

        {(toggleMutation.error || deleteMutation.error) && (
          <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {String(toggleMutation.error ?? deleteMutation.error)}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <SchedulePanel
            description="Completed occurrences and the configured maximum."
            title="Run progress"
          >
            <div className="grid gap-4 p-4">
              <ProgressMeter
                label={progress.label}
                percentage={progress.percentage}
                tone={state.key === "completed" ? "success" : "muted"}
              />
              <dl className="grid grid-cols-2 divide-x rounded-surface border">
                <MetaItem label="Successful" value={schedule.successCount} />
                <MetaItem label="Failed" value={schedule.failureCount} />
              </dl>
            </div>
          </SchedulePanel>

          <SchedulePanel
            description="Estimated and consumed credits for this schedule."
            title="Credit budget"
          >
            <div className="grid gap-4 p-4">
              <ProgressMeter
                label={
                  budget.limit === null
                    ? `${budget.consumedLabel} consumed`
                    : `${budget.consumedLabel} / ${budget.limitLabel}`
                }
                percentage={budget.percentage}
                tone={
                  state.key === "budget_terminal" ? "destructive" : "warning"
                }
              />
              <dl className="grid grid-cols-3 divide-x rounded-surface border max-sm:grid-cols-1 max-sm:divide-x-0 max-sm:divide-y">
                <MetaItem
                  label="Est. per run"
                  value={budget.estimatedPerRunLabel}
                />
                <MetaItem label="Projected" value={budget.projectedLabel} />
                <MetaItem label="Remaining" value={budget.remainingLabel} />
              </dl>
            </div>
          </SchedulePanel>
        </div>

        <SchedulePanel
          description="Budget, overlap, failure, timeout, end-date, and projection notices."
          title="Signals"
        >
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {signals.map(({ detail, key, title, tone }) => (
              <SignalCard detail={detail} key={key} title={title} tone={tone} />
            ))}
          </div>
        </SchedulePanel>

        <SchedulePanel
          description="Timing, limits, and upcoming projected occurrences."
          title="Schedule behavior"
        >
          <dl className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
            <MetaItem
              hint={schedule.timezone}
              label="Next run"
              value={formatDateTime(schedule.nextRunAt, schedule.timezone)}
            />
            <MetaItem
              hint={schedule.endAt ? "Stops automatically" : "No end date"}
              label="Ends"
              value={formatDateTime(schedule.endAt, schedule.timezone)}
            />
            <MetaItem
              hint="Maximum execution time"
              label="Run timeout"
              value={formatDuration(schedule.maxRunDurationSeconds)}
            />
            <MetaItem
              hint="When a previous run is active"
              label="Overlap"
              value={overlapPolicyLabel(schedule.overlapPolicy)}
            />
          </dl>
          <dl className="grid border-t divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <MetaItem
              hint={schedule.timezone}
              label="Execution window"
              value={executionWindowLabel(schedule)}
            />
            <MetaItem
              hint={projection.horizonLabel}
              label="Projection"
              value={`${projection.estimatedRunLabel} · ${projection.estimatedCreditCostLabel}`}
            />
          </dl>
          {projection.occurrenceLabels.length ? (
            <div className="border-t p-4">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Upcoming occurrences
              </div>
              <div className="flex flex-wrap gap-2">
                {projection.occurrenceLabels.map((occurrence, index) => (
                  <span
                    className="rounded-control border bg-muted/30 px-2 py-1 text-xs tabular-nums"
                    key={schedule.previewRunAt[index] ?? occurrence}
                  >
                    {occurrence}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </SchedulePanel>

        <SchedulePanel
          description="Most recent executions attributed to this schedule."
          title="Execution history"
        >
          {runsQuery.error ? (
            <div className="p-4 text-sm text-destructive">
              {String(runsQuery.error)}
            </div>
          ) : runsQuery.isPending ? (
            <div className="grid gap-2 p-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : (
            <>
              {history.notice ? (
                <div className="border-b bg-muted/30 px-4 py-2 text-xs leading-5 text-muted-foreground">
                  {history.notice}
                </div>
              ) : null}
              {history.runs.length ? (
                <div className="divide-y">
                  {history.runs.slice(0, 20).map((run) => (
                    <HistoryRow key={run.id} run={run} />
                  ))}
                </div>
              ) : (
                <div className="p-4">
                  <EmptyState
                    description={
                      history.mode === "unavailable"
                        ? "Run history cannot be safely attributed until schedule IDs are included in the Studio run payload."
                        : "Completed and attempted executions will appear here."
                    }
                    icon={Clock3}
                    title={
                      history.mode === "unavailable"
                        ? "History attribution unavailable"
                        : "No executions yet"
                    }
                  />
                </div>
              )}
            </>
          )}
        </SchedulePanel>
      </div>
    </AppShell>
  );
}

function HistoryRow({ run }: { run: ScheduleRunRecord }) {
  const timedOut = Boolean(
    run.timedOutAt || /timed?\s*out|timeout/i.test(run.error ?? ""),
  );
  return (
    <div className="grid min-h-16 grid-cols-[minmax(160px,1fr)_150px_120px_100px] items-center gap-4 px-4 py-3 text-sm max-md:grid-cols-[minmax(0,1fr)_120px]">
      <div className="min-w-0">
        <StatusDot status={timedOut ? "timed out" : run.status} />
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {run.id}
        </div>
      </div>
      <div className="min-w-0 max-md:hidden">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Started
        </div>
        <div className="mt-1 truncate text-xs">
          {formatDateTime(run.startedAt ?? run.queuedAt ?? run.createdAt)}
        </div>
      </div>
      <div className="min-w-0 max-md:hidden">
        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          <Coins className="size-3" /> Credits
        </div>
        <div className="mt-1 truncate text-xs">
          {formatCredits(run.creditCost ?? 0)}
        </div>
      </div>
      <div className="min-w-0 text-right text-xs text-muted-foreground">
        {run.attempts
          ? `${run.attempts} ${run.attempts === 1 ? "attempt" : "attempts"}`
          : "—"}
      </div>
      {run.error || run.cancelReason ? (
        <div className="col-span-full truncate text-xs text-destructive">
          {run.error ?? run.cancelReason}
        </div>
      ) : null}
    </div>
  );
}
