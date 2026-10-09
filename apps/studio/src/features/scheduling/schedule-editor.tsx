import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CalendarClock, Save } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, Skeleton } from "@/components/data-page";
import { PageSectionHeader } from "@/components/header-primitives";
import { Button } from "@/components/ui/button";
import { apiGet, apiSend } from "@/lib/api-client";
import {
  createDefaultScheduleTriggerConfig,
  normalizeScheduleTriggerConfig,
  type ScheduleTriggerConfig,
} from "./schedule-config";
import {
  scheduleState,
  type ScheduleRecord,
  type SchedulesPayload,
  type TransferSummary,
} from "./schedule-data";
import { ScheduleTriggerSettings } from "./schedule-trigger-settings";

type ScheduleDetailPayload = { schedule: ScheduleRecord };

export function ScheduleEditorPage({ scheduleId }: { scheduleId?: string }) {
  const schedulesQuery = useQuery({
    queryKey: ["/studio/schedules"],
    queryFn: () => apiGet<SchedulesPayload>("/studio/schedules"),
  });
  const detailQuery = useQuery({
    enabled: Boolean(scheduleId),
    queryKey: [`/studio/schedules/${scheduleId ?? "new"}`],
    queryFn: () =>
      apiGet<ScheduleDetailPayload>(`/studio/schedules/${scheduleId}`),
  });
  const error = schedulesQuery.error ?? detailQuery.error;
  const pending =
    schedulesQuery.isPending || (Boolean(scheduleId) && detailQuery.isPending);

  if (error) {
    return (
      <AppShell contentClassName="px-3 py-4" title="Schedule">
        <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {String(error)}
        </div>
      </AppShell>
    );
  }
  if (pending) {
    return (
      <AppShell contentClassName="px-3 py-4" title="Schedule">
        <div className="mx-auto grid w-full max-w-3xl gap-4">
          <Skeleton className="h-20 rounded-surface" />
          <Skeleton className="h-96 rounded-surface" />
        </div>
      </AppShell>
    );
  }

  const transfers = schedulesQuery.data?.transfers ?? [];
  const schedule = detailQuery.data?.schedule;
  if (!transfers.length && !schedule) {
    return (
      <AppShell contentClassName="px-3 py-4" title="New schedule">
        <div className="mx-auto max-w-3xl">
          <EmptyState
            action={
              <Button asChild size="sm" type="button" variant="secondary">
                <Link to={"/transfers" as never}>Open transfers</Link>
              </Button>
            }
            description="A schedule needs a transfer to execute. Create a transfer first, then return here."
            icon={CalendarClock}
            title="No transfers available"
          />
        </div>
      </AppShell>
    );
  }

  return (
    <LoadedScheduleEditor
      key={`${schedule?.id ?? "new"}:${schedule?.updatedAt ?? ""}`}
      schedule={schedule}
      transfers={transfers}
    />
  );
}

function LoadedScheduleEditor({
  schedule,
  transfers,
}: {
  schedule?: ScheduleRecord;
  transfers: TransferSummary[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const initialTransferId =
    schedule?.transferTemplateId ?? transfers[0]?.id ?? "";
  const [transferTemplateId, setTransferTemplateId] =
    useState(initialTransferId);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [config, setConfig] = useState<ScheduleTriggerConfig>(() =>
    configForSchedule(schedule, transfers, initialTransferId),
  );
  const endpoint = schedule
    ? `/studio/schedules/${schedule.id}`
    : "/studio/schedules";
  const saveMutation = useMutation({
    mutationFn: () =>
      apiSend<{ id?: string }>(schedule ? "PATCH" : "POST", endpoint, {
        ...config,
        transferTemplateId,
        enabled,
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/studio/schedules"] });
      queryClient.invalidateQueries({ queryKey: [endpoint] });
      const id = schedule?.id ?? result.id;
      navigate({ to: (id ? `/schedules/${id}` : "/schedules") as never });
    },
  });
  const state = schedule ? scheduleState(schedule) : null;
  const transferEstimate = transfers.find(
    (transfer) => transfer.id === transferTemplateId,
  )?.estimatedCreditCost;

  return (
    <AppShell
      contentClassName="px-3 py-4"
      title={schedule ? "Edit schedule" : "New schedule"}
    >
      <form
        className="mx-auto grid w-full max-w-3xl gap-4 pb-12"
        onSubmit={(event) => {
          event.preventDefault();
          saveMutation.mutate();
        }}
      >
        <PageSectionHeader>
          <Button asChild size="sm" type="button" variant="ghost">
            <Link
              to={
                (schedule ? `/schedules/${schedule.id}` : "/schedules") as never
              }
            >
              <ArrowLeft className="size-4" />
              {schedule ? "Schedule" : "Schedules"}
            </Link>
          </Button>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {schedule ? "Edit schedule" : "Create schedule"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Configure timing, limits, projected cost, and overlap behavior.
          </p>
        </PageSectionHeader>

        {state?.terminal ? (
          <div className="rounded-control border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
            This schedule is {state.label.toLowerCase()}. Saving changes updates
            its configuration but does not erase its run or credit history.
          </div>
        ) : null}

        <section className="grid gap-4 rounded-surface border bg-card p-4">
          <div>
            <h2 className="text-sm font-semibold">Schedule target</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose the transfer and whether automatic execution starts
              enabled.
            </p>
          </div>
          <label className="grid gap-2 text-sm font-medium">
            Transfer
            <select
              className="h-10 rounded-control border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              required
              value={transferTemplateId}
              onChange={(event) => {
                const nextTransferId = event.target.value;
                const transfer = transfers.find(
                  (candidate) => candidate.id === nextTransferId,
                );
                setTransferTemplateId(nextTransferId);
                setConfig((current) => ({
                  ...current,
                  estimatedCreditCost: transfer?.estimatedCreditCost ?? 0,
                }));
              }}
            >
              {transfers.map((transfer) => (
                <option key={transfer.id} value={transfer.id}>
                  {transfer.name || transfer.id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm font-medium">
            Enable automatic execution
            <input
              checked={enabled}
              className="size-4 accent-primary"
              type="checkbox"
              onChange={(event) => setEnabled(event.target.checked)}
            />
          </label>
        </section>

        <ScheduleTriggerSettings
          completedRunCount={schedule?.runCount ?? 0}
          creditsConsumed={schedule?.creditsConsumed ?? 0}
          estimatedCreditCostReadOnly
          estimatedCreditCostUnavailable={typeof transferEstimate !== "number"}
          value={config}
          onChange={setConfig}
        />

        {saveMutation.error ? (
          <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {String(saveMutation.error)}
          </div>
        ) : null}

        <div className="sticky bottom-3 flex items-center justify-end gap-2 rounded-surface border bg-background/95 p-3 shadow-lg backdrop-blur">
          <Button asChild type="button" variant="ghost">
            <Link
              to={
                (schedule ? `/schedules/${schedule.id}` : "/schedules") as never
              }
            >
              Cancel
            </Link>
          </Button>
          <Button
            disabled={saveMutation.isPending || !transferTemplateId}
            type="submit"
          >
            <Save className="size-4" />
            {saveMutation.isPending
              ? "Saving..."
              : schedule
                ? "Save changes"
                : "Create schedule"}
          </Button>
        </div>
      </form>
    </AppShell>
  );
}

function configForSchedule(
  schedule: ScheduleRecord | undefined,
  transfers: TransferSummary[],
  transferTemplateId: string,
) {
  if (schedule) {
    const config = normalizeScheduleTriggerConfig(
      schedule as unknown as Record<string, unknown>,
    );
    const transfer = transfers.find((item) => item.id === transferTemplateId);
    return {
      ...config,
      estimatedCreditCost: transfer?.estimatedCreditCost ?? 0,
    };
  }
  const config = createDefaultScheduleTriggerConfig();
  const transfer = transfers.find((item) => item.id === transferTemplateId);
  return {
    ...config,
    estimatedCreditCost: transfer?.estimatedCreditCost ?? 0,
  };
}
