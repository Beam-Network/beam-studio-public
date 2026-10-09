import { pgMany, type PgPool } from "@beam-studio/db";

type Row = Record<string, unknown>;

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function timestamp(value: unknown): string | null {
  return value instanceof Date
    ? value.toISOString()
    : typeof value === "string"
      ? value
      : null;
}

export function resolvedWorkflowMembers(metadata: unknown) {
  const partitions = object(
    object(metadata).v3RoomResolution,
  ).membersByPartition;
  if (
    !partitions ||
    typeof partitions !== "object" ||
    Array.isArray(partitions)
  )
    return {} as Record<string, Array<{ memberId: string; key?: string }>>;
  return Object.fromEntries(
    Object.entries(partitions).map(([id, members]) => [
      id,
      rows(members)
        .filter((member) => optionalText(member.memberId))
        .map((member) => ({
          memberId: String(member.memberId),
          ...(optionalText(member.key) ? { key: String(member.key) } : {}),
        })),
    ]),
  ) as Record<string, Array<{ memberId: string; key?: string }>>;
}

export function workflowTaskInspectionRecord(
  row: Row,
  transferInputs?: { sourceInput: string; recipientsInput: string },
) {
  const metadata = object(row.metadata_json);
  const input = object(row.input_json);
  const partition = object(metadata.logicalPartition);
  const route = object(metadata.v3Route);
  const assignment = object(row.latest_assignment);
  const deadLetter = object(row.dead_letter);
  const attempts = rows(row.task_attempts).map((attempt) => ({
    id: String(attempt.id),
    attemptNumber: Number(attempt.attempt_number),
    workerId: optionalText(attempt.worker_id),
    status: String(attempt.status),
    error: optionalText(attempt.error),
    startedAt: timestamp(attempt.started_at),
    completedAt: timestamp(attempt.completed_at),
  }));
  const artifactManifests = rows(row.artifact_manifests).map((manifest) => ({
    id: String(manifest.id),
    attempt: Number(manifest.attempt),
    status: String(manifest.status),
    publicationId: String(manifest.publication_id),
    artifacts: rows(manifest.artifacts_json).map((artifact) => ({
      artifactId: optionalText(artifact.artifactId),
      port: optionalText(artifact.port),
      mediaType: optionalText(artifact.mediaType),
      sha256: optionalText(artifact.sha256),
      sizeBytes: artifact.sizeBytes == null ? null : Number(artifact.sizeBytes),
    })),
    error: optionalText(manifest.error),
    acceptedAt: timestamp(manifest.accepted_at),
  }));
  const artifactIds = [
    ...new Set(
      artifactManifests
        .filter((manifest) => manifest.status === "accepted")
        .flatMap((manifest) =>
          rows(manifest.artifacts)
            .map((artifact) => optionalText(artifact.artifactId))
            .filter((id): id is string => id !== null),
        ),
    ),
  ];
  const status = String(row.status);
  const waitReason =
    status === "retry_scheduled"
      ? "retry_backoff"
      : status === "queued"
        ? "queued_for_execution"
        : status === "leased"
          ? "worker_lease"
          : artifactManifests.some((manifest) => manifest.status === "pending")
            ? "artifact_acceptance"
            : null;
  const failureReason =
    optionalText(deadLetter.reason) ??
    (status === "failed" || status === "dead_letter"
      ? (optionalText(row.error) ?? "task_failed")
      : null);
  const recipients = transferInputs
    ? input[transferInputs.recipientsInput]
    : undefined;
  return {
    id: String(row.id),
    workflowStepId: String(row.workflow_step_id),
    workflowStepRunId: optionalText(row.workflow_step_run_id),
    taskKind: String(row.task_kind),
    memberId: optionalText(partition.memberId) ?? optionalText(route.memberId),
    assignedMemberId:
      optionalText(assignment.member_id) ??
      optionalText(route.assignedMemberId),
    sourceMemberId: transferInputs
      ? optionalText(input[transferInputs.sourceInput])
      : optionalText(object(metadata.v3Loop).sourceMemberId),
    recipientMemberIds: transferInputs
      ? Array.isArray(recipients)
        ? recipients.filter(
            (value): value is string => typeof value === "string",
          )
        : []
      : optionalText(object(metadata.v3Loop).targetMemberId)
        ? [String(object(metadata.v3Loop).targetMemberId)]
        : [],
    status,
    attemptCount: Number(row.attempt_count ?? row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
    attempts,
    artifactIds,
    artifactManifests,
    waitReason,
    failureReason,
    error: optionalText(row.error),
    shardIndex: row.shard_index == null ? null : Number(row.shard_index),
    shardCount: row.shard_count == null ? null : Number(row.shard_count),
    loopIteration: Number.isSafeInteger(object(metadata.v3Loop).iteration)
      ? Number(object(metadata.v3Loop).iteration)
      : null,
    aggregationLeafCount: Array.isArray(
      object(metadata.aggregation).expectedContributionIds,
    )
      ? (object(metadata.aggregation).expectedContributionIds as unknown[])
          .length
      : null,
    scheduledAt: timestamp(row.scheduled_at),
    admissionDeadlineAt: timestamp(row.admission_deadline_at),
    createdAt: timestamp(row.created_at),
    startedAt: timestamp(row.started_at),
    completedAt: timestamp(row.completed_at),
  };
}

/** Read only the run's persisted task evidence; caller has already checked its organization. */
export async function workflowRunTaskInspection(
  pool: PgPool,
  runId: string,
  distribution?: unknown,
) {
  const transferInputsByStep = new Map(
    rows(object(distribution).steps).flatMap((step) => {
      const transfer = object(step.transfer);
      return optionalText(step.stepId) &&
        optionalText(transfer.sourceInput) &&
        optionalText(transfer.recipientsInput)
        ? [
            [
              String(step.stepId),
              {
                sourceInput: String(transfer.sourceInput),
                recipientsInput: String(transfer.recipientsInput),
              },
            ] as const,
          ]
        : [];
    }),
  );
  const tasks = await pgMany<Row>(
    pool,
    `SELECT t.*,
      (SELECT to_jsonb(a) FROM execution.executor_assignments a
       WHERE a.task_id=t.id ORDER BY a.attempt DESC,a.created_at DESC LIMIT 1) AS latest_assignment,
      (SELECT to_jsonb(d) FROM execution.workflow_task_dead_letters d
       WHERE d.workflow_task_id=t.id LIMIT 1) AS dead_letter,
      COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attempt_number)
       FROM execution.workflow_task_attempts a WHERE a.workflow_task_id=t.id),'[]'::jsonb) AS task_attempts,
      COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.attempt)
       FROM execution.workflow_artifact_manifests m WHERE m.task_id=t.id),'[]'::jsonb) AS artifact_manifests
     FROM execution.workflow_tasks t
     WHERE t.workflow_run_id=$1
     ORDER BY t.created_at,t.workflow_step_id,t.shard_index,t.id`,
    [runId],
  );
  return tasks.map((task) =>
    workflowTaskInspectionRecord(
      task,
      transferInputsByStep.get(String(task.workflow_step_id)),
    ),
  );
}
