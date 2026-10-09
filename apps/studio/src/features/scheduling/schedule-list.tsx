import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, ChevronRight, Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import {
  EmptyState,
  FilterBar,
  FilterSelect,
  ResultCounter,
  SearchInput,
  TableSkeleton,
} from "@/components/data-page";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api-client";
import { formatCredits } from "@/lib/format-credits";
import {
  formatDateTime,
  scheduleBudget,
  scheduleRunProgress,
  scheduleState,
  type ScheduleRecord,
  type SchedulesPayload,
} from "./schedule-data";
import { ProgressMeter, ScheduleStateBadge } from "./schedule-primitives";

export function ScheduleListPage() {
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const { data, error, isPending } = useQuery({
    queryKey: ["/studio/schedules"],
    queryFn: () => apiGet<SchedulesPayload>("/studio/schedules"),
  });
  const schedules = data?.schedules ?? [];
  const filteredSchedules = useMemo(
    () =>
      schedules.filter((schedule) => {
        const state = scheduleState(schedule);
        const haystack = [
          schedule.transferName,
          schedule.transferTemplateId,
          schedule.id,
          schedule.frequency,
          state.label,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return (
          haystack.includes(search.trim().toLowerCase()) &&
          (stateFilter === "all" || state.key === stateFilter)
        );
      }),
    [schedules, search, stateFilter],
  );

  return (
    <AppShell
      contentClassName="px-3 py-4"
      headerActions={
        <Button asChild size="sm" type="button" variant="default">
          <Link to={"/schedules/new" as never}>
            <Plus className="size-4" />
            Create schedule
          </Link>
        </Button>
      }
    >
      <div className="grid gap-3">
        <FilterBar>
          <SearchInput
            placeholder="All schedules..."
            value={search}
            onChange={setSearch}
          />
          <FilterSelect
            label="State"
            options={[
              ["all", "All states"],
              ["active", "Active"],
              ["paused", "Paused"],
              ["completed", "Completed"],
              ["expired", "Expired"],
              ["budget_terminal", "Budget reached"],
            ]}
            value={stateFilter}
            onChange={setStateFilter}
          />
          <ResultCounter
            isPending={isPending}
            totalCount={schedules.length}
            visibleCount={filteredSchedules.length}
          />
        </FilterBar>

        {error ? (
          <div className="rounded-control border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {String(error)}
          </div>
        ) : isPending ? (
          <TableSkeleton />
        ) : !filteredSchedules.length ? (
          <EmptyState
            action={
              schedules.length ? null : (
                <Button asChild size="sm" type="button" variant="secondary">
                  <Link to={"/schedules/new" as never}>
                    <Plus className="size-4" />
                    Create schedule
                  </Link>
                </Button>
              )
            }
            description={
              schedules.length
                ? "No schedules match the current search and state filter."
                : "Create a schedule to run a transfer automatically with explicit limits."
            }
            icon={CalendarClock}
            title={schedules.length ? "No schedules match" : "No schedules yet"}
          />
        ) : (
          <div className="overflow-hidden rounded-control border bg-card">
            <div className="divide-y">
              {filteredSchedules.map((schedule) => (
                <ScheduleRow key={schedule.id} schedule={schedule} />
              ))}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ScheduleRow({ schedule }: { schedule: ScheduleRecord }) {
  const state = scheduleState(schedule);
  const progress = scheduleRunProgress(schedule);
  const budget = scheduleBudget(schedule);
  return (
    <Link
      className="grid min-h-20 grid-cols-[minmax(220px,1.2fr)_130px_150px_150px_140px_140px_32px] items-center gap-4 px-3 py-3 text-sm transition-colors hover:bg-secondary/60 max-xl:grid-cols-[minmax(200px,1fr)_130px_140px_140px_32px] max-lg:grid-cols-[minmax(0,1fr)_130px_32px]"
      to={`/schedules/${schedule.id}` as never}
    >
      <div className="min-w-0">
        <div className="truncate font-medium">
          {schedule.transferName?.trim() || "Unnamed transfer"}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {schedule.frequency} · {schedule.timezone}
        </div>
      </div>
      <ScheduleStateBadge state={state} />
      <ListValue
        label="Next run"
        value={formatDateTime(schedule.nextRunAt, schedule.timezone)}
      />
      <div className="max-xl:hidden">
        <ListValue
          label="Ends"
          value={formatDateTime(schedule.endAt, schedule.timezone)}
        />
      </div>
      <div className="max-lg:hidden">
        <ProgressMeter
          label={progress.label}
          percentage={progress.percentage}
          tone={state.key === "completed" ? "success" : "muted"}
        />
      </div>
      <div className="max-xl:hidden">
        <ProgressMeter
          label={
            budget.limit === null
              ? `${formatCredits(budget.consumed)} used`
              : `${formatCredits(budget.consumed)} / ${formatCredits(budget.limit)}`
          }
          percentage={budget.percentage}
          tone={state.key === "budget_terminal" ? "destructive" : "warning"}
        />
      </div>
      <ChevronRight className="size-4 text-muted-foreground" />
    </Link>
  );
}

function ListValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 max-lg:hidden">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-xs">{value}</div>
    </div>
  );
}
