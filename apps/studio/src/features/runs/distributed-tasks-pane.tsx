import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ArtifactRecord, DistributedTaskRecord } from "./run-detail-data";
import { DateText, JsonPanel, StatusBadge } from "./run-detail-primitives";

export function DistributedTasksPane({
  artifacts,
  membersByPartition,
  tasks,
}: {
  artifacts: ArtifactRecord[];
  membersByPartition: Record<string, Array<{ memberId: string; key?: string }>>;
  tasks: DistributedTaskRecord[];
}) {
  const [stepFilter, setStepFilter] = useState("");
  const [limit, setLimit] = useState(100);
  const stepIds = [...new Set(tasks.map((task) => task.workflowStepId))];
  const filtered = stepFilter
    ? tasks.filter((task) => task.workflowStepId === stepFilter)
    : tasks;
  const shown = filtered.slice(0, limit);

  return (
    <div className="grid gap-4">
      {Object.keys(membersByPartition).length ? (
        <section className="rounded-surface border bg-card p-4">
          <h2 className="font-semibold">Frozen run members</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The cohort resolved when this run started. Task placement below
            shows where each action actually ran.
          </p>
          <div className="mt-3 grid gap-2">
            {Object.entries(membersByPartition).map(
              ([partitionId, members]) => (
                <div
                  className="flex flex-wrap items-center gap-2 text-xs"
                  key={partitionId}
                >
                  <code className="font-semibold">{partitionId}</code>
                  <Badge variant="outline">{members.length} members</Badge>
                  <span className="break-all text-muted-foreground">
                    {members.map((member) => member.memberId).join(" · ")}
                  </span>
                </div>
              ),
            )}
          </div>
        </section>
      ) : null}
      <section className="rounded-surface border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Distributed tasks</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {tasks.length} materialized task{tasks.length === 1 ? "" : "s"}{" "}
              across {stepIds.length} action{stepIds.length === 1 ? "" : "s"}.
            </p>
          </div>
          {stepIds.length > 1 ? (
            <label className="grid gap-1 text-xs">
              <span>Action</span>
              <select
                className="h-9 rounded-control border bg-background px-2 text-sm"
                value={stepFilter}
                onChange={(event) => {
                  setStepFilter(event.target.value);
                  setLimit(100);
                }}
              >
                <option value="">All actions</option>
                {stepIds.map((id) => (
                  <option key={id} value={id}>
                    {id} ·{" "}
                    {tasks.filter((task) => task.workflowStepId === id).length}{" "}
                    tasks
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {tasks.length ? (
          <div className="mt-4 overflow-hidden rounded-surface border divide-y">
            {shown.map((task) => (
              <details className="group" key={task.id}>
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-3 hover:bg-secondary/50">
                  <StatusBadge status={task.status} />
                  <code className="font-semibold text-xs">
                    {task.workflowStepId}
                  </code>
                  {task.memberId ? (
                    <>
                      <span className="text-xs text-muted-foreground">
                        member
                      </span>
                      <code className="text-xs">{task.memberId}</code>
                    </>
                  ) : null}
                  {task.assignedMemberId &&
                  task.assignedMemberId !== task.memberId ? (
                    <span className="text-xs text-muted-foreground">
                      → actual{" "}
                      <code className="text-foreground">
                        {task.assignedMemberId}
                      </code>
                    </span>
                  ) : null}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {task.id}
                  </span>
                </summary>
                <div className="grid gap-4 border-t bg-muted/20 p-4 text-xs">
                  <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    <Fact label="Task ID" value={task.id} />
                    {task.taskKind ? (
                      <Fact label="Task kind" value={task.taskKind} />
                    ) : null}
                    <Fact label="Logical member" value={task.memberId ?? "-"} />
                    <Fact
                      label="Actual member"
                      value={task.assignedMemberId || task.memberId || "-"}
                    />
                    <Fact
                      label="Attempts"
                      value={`${task.attemptCount ?? task.attempts?.length ?? 0}${task.maxAttempts ? ` / ${task.maxAttempts}` : ""}`}
                    />
                    {task.shardIndex != null ? (
                      <Fact
                        label="Shard"
                        value={`${task.shardIndex + 1}${task.shardCount ? ` / ${task.shardCount}` : ""}`}
                      />
                    ) : null}
                    {task.loopIteration != null ? (
                      <Fact
                        label="Loop iteration"
                        value={String(task.loopIteration)}
                      />
                    ) : null}
                    {task.aggregationLeafCount != null ? (
                      <Fact
                        label="Aggregation contributions"
                        value={String(task.aggregationLeafCount)}
                      />
                    ) : null}
                    {task.sourceMemberId ? (
                      <Fact
                        label="Transfer source"
                        value={task.sourceMemberId}
                      />
                    ) : null}
                    {task.recipientMemberIds?.length ? (
                      <Fact
                        label="Recipients"
                        value={task.recipientMemberIds.join(", ")}
                      />
                    ) : null}
                    {task.scheduledAt ? (
                      <Fact
                        label="Scheduled for"
                        value={<DateText value={task.scheduledAt} />}
                      />
                    ) : null}
                    {task.admissionDeadlineAt ? (
                      <Fact
                        label="Admission deadline"
                        value={<DateText value={task.admissionDeadlineAt} />}
                      />
                    ) : null}
                  </dl>
                  {task.waitReason ? (
                    <p className="rounded-control border border-amber-400/40 bg-amber-400/10 p-3">
                      <strong>Waiting:</strong>{" "}
                      {waitReasonLabel(task.waitReason)}
                    </p>
                  ) : null}
                  {task.failureReason || task.error ? (
                    <p className="rounded-control border border-destructive/40 bg-destructive/5 p-3 text-destructive">
                      <strong>Failure:</strong>{" "}
                      {failureReasonLabel(
                        task.failureReason || task.error || "",
                      )}
                    </p>
                  ) : null}
                  {task.attempts?.length ? (
                    <div className="grid gap-2">
                      <strong>Attempts</strong>
                      {task.attempts.map((attempt, index) => (
                        <div
                          className="grid gap-1 rounded-control border bg-background p-3"
                          key={String(attempt.id ?? index)}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">
                              Attempt {attempt.attemptNumber ?? index + 1}
                            </Badge>
                            {attempt.status ? (
                              <StatusBadge status={attempt.status} />
                            ) : null}
                            {attempt.workerId ? (
                              <span>
                                worker <code>{attempt.workerId}</code>
                              </span>
                            ) : null}
                          </div>
                          {attempt.id ? (
                            <code className="break-all text-muted-foreground">
                              {String(attempt.id)}
                            </code>
                          ) : null}
                          {attempt.error ? (
                            <span className="text-destructive">
                              {attempt.error}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {task.artifactIds?.length ||
                  task.artifactManifests?.length ? (
                    <div className="grid gap-2">
                      <strong>Artifacts and publications</strong>
                      {task.artifactIds?.map((id) => {
                        const artifact = artifacts.find(
                          (item) => item.id === id,
                        );
                        return (
                          <div
                            className="rounded-control border bg-background p-2"
                            key={id}
                          >
                            <code>{artifact?.name ?? id}</code>
                            {artifact?.uri ? (
                              <p className="break-all text-muted-foreground">
                                {artifact.uri}
                              </p>
                            ) : null}
                          </div>
                        );
                      })}
                      {task.artifactManifests?.map((manifest, index) => (
                        <div
                          className="rounded-control border bg-background p-2"
                          key={String(manifest.id ?? index)}
                        >
                          <JsonPanel value={manifest} />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            No distributed tasks have materialized yet.
          </p>
        )}
        {filtered.length > shown.length ? (
          <Button
            className="mt-3"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setLimit((current) => current + 100)}
          >
            Show more ({filtered.length - shown.length} remaining)
          </Button>
        ) : null}
      </section>
    </div>
  );
}

function waitReasonLabel(reason: string) {
  switch (reason) {
    case "retry_backoff":
      return "Waiting for the scheduled retry.";
    case "queued_for_execution":
      return "Queued for an executor.";
    case "worker_lease":
      return "Assigned to a worker; waiting for completion.";
    case "artifact_acceptance":
      return "Waiting for artifact publication to be accepted.";
    default:
      return reason;
  }
}

function failureReasonLabel(reason: string) {
  return reason === "admission_deadline"
    ? "Task was not admitted before its deadline."
    : reason;
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono text-foreground">{value}</dd>
    </div>
  );
}
