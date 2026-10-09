export type MetricLabels = Record<
  string,
  string | number | boolean | null | undefined
>;
export type MetricKind = "counter" | "gauge" | "histogram";

export type MetricDefinition = {
  name: string;
  help: string;
  kind: MetricKind;
  labels: readonly string[];
  buckets?: readonly number[];
};

export type MetricPoint = {
  name: string;
  help: string;
  kind: MetricKind;
  labels: Record<string, string>;
  value?: number;
  count?: number;
  sum?: number;
  buckets?: Array<{ le: number; count: number }>;
};

const forbiddenLabel = /(^|_)(id|uuid|email|user|credential|token|url)($|_)/i;

export const BEAM_METRICS: readonly MetricDefinition[] = [
  definition("beam_service_up", "Service telemetry availability.", "gauge", [
    "service",
  ]),
  definition("beam_api_requests_total", "API requests completed.", "counter", [
    "method",
    "route",
    "status_class",
  ]),
  definition(
    "beam_api_request_duration_seconds",
    "API request duration.",
    "histogram",
    ["method", "route", "status_class"],
    [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  ),
  definition(
    "beam_workflow_runs_total",
    "Workflow run durable transitions.",
    "counter",
    ["service", "trigger", "status"],
  ),
  definition(
    "beam_workflow_run_duration_seconds",
    "Workflow run duration.",
    "histogram",
    ["service", "status"],
    [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600],
  ),
  definition(
    "beam_workflow_tasks_queued_total",
    "Workflow tasks durably queued.",
    "counter",
    ["task_kind", "action_source", "placement"],
  ),
  definition(
    "beam_workflow_task_claims_total",
    "Workflow task claims committed.",
    "counter",
    ["task_kind", "action_source"],
  ),
  definition(
    "beam_workflow_task_duration_seconds",
    "Workflow task attempt duration.",
    "histogram",
    ["task_kind", "action_source", "status"],
    [0.01, 0.05, 0.1, 0.25, 0.5, 1, 5, 15, 60, 300, 900],
  ),
  definition(
    "beam_workflow_task_retries_total",
    "Workflow task retries durably scheduled.",
    "counter",
    ["reason", "task_kind"],
  ),
  definition(
    "beam_workflow_task_dead_letters_total",
    "Workflow tasks durably dead-lettered.",
    "counter",
    ["reason", "task_kind"],
  ),
  definition(
    "beam_workflow_action_executions_total",
    "Action execution outcomes.",
    "counter",
    ["action_source", "status"],
  ),
  definition(
    "beam_workflow_action_blocked_total",
    "Actions blocked before or during execution.",
    "counter",
    ["reason", "action_source"],
  ),
  definition(
    "beam_workflow_placements_total",
    "Task placement outcomes.",
    "counter",
    ["placement", "outcome"],
  ),
  definition(
    "beam_nats_messages_total",
    "NATS task message outcomes.",
    "counter",
    ["operation", "outcome"],
  ),
  definition(
    "beam_workflow_queue_depth",
    "Current workflow task queue depth.",
    "gauge",
    ["state"],
  ),
  definition(
    "beam_workflow_queue_oldest_age_seconds",
    "Age of the oldest queued workflow task.",
    "gauge",
    [],
  ),
  definition(
    "beam_worker_heartbeat_age_seconds",
    "Age of the stalest worker heartbeat.",
    "gauge",
    ["status"],
  ),
  definition(
    "beam_workers",
    "Current workers by bounded health status.",
    "gauge",
    ["status"],
  ),
  definition(
    "beam_orchestrator_worker_load_score",
    "Current global worker load score.",
    "gauge",
    [],
  ),
  definition(
    "beam_orchestrator_active_workers",
    "Active worker count.",
    "gauge",
    [],
  ),
  definition(
    "beam_orchestrator_command_outbox_pending",
    "Durable commands awaiting publication.",
    "gauge",
    [],
  ),
  definition(
    "beam_orchestrator_command_outbox_pending_with_error",
    "Durable commands awaiting publication after an error.",
    "gauge",
    [],
  ),
  definition(
    "beam_orchestrator_command_outbox_oldest_seconds",
    "Age of the oldest unpublished command.",
    "gauge",
    [],
  ),
] as const;

export class MetricRegistry {
  readonly #definitions = new Map<string, MetricDefinition>();
  readonly #series = new Map<string, Map<string, Series>>();

  constructor(
    definitions: readonly MetricDefinition[] = BEAM_METRICS,
    private readonly maxSeriesPerMetric = 64,
  ) {
    for (const item of definitions) {
      if (item.labels.some((label) => forbiddenLabel.test(label))) {
        throw new Error(
          `Metric ${item.name} has forbidden high-cardinality label.`,
        );
      }
      this.#definitions.set(item.name, item);
      this.#series.set(item.name, new Map());
    }
  }

  add(name: string, value = 1, labels: MetricLabels = {}) {
    const [definition, series] = this.series(name, labels, "counter");
    series.value += finite(value);
    this.#series.get(definition.name)!.set(series.key, series);
  }

  set(name: string, value: number, labels: MetricLabels = {}) {
    const [definition, series] = this.series(name, labels, "gauge");
    series.value = finite(value);
    this.#series.get(definition.name)!.set(series.key, series);
  }

  observe(name: string, value: number, labels: MetricLabels = {}) {
    const [definition, series] = this.series(name, labels, "histogram");
    const observation = finite(value);
    series.count += 1;
    series.sum += observation;
    for (const bucket of series.buckets) {
      if (observation <= bucket.le) bucket.count += 1;
    }
    this.#series.get(definition.name)!.set(series.key, series);
  }

  snapshot(): MetricPoint[] {
    return [...this.#definitions.values()].flatMap((definition) =>
      [...(this.#series.get(definition.name)?.values() ?? [])].map(
        (series) => ({
          name: definition.name,
          help: definition.help,
          kind: definition.kind,
          labels: { ...series.labels },
          ...(definition.kind === "histogram"
            ? {
                count: series.count,
                sum: series.sum,
                buckets: series.buckets.map((bucket) => ({ ...bucket })),
              }
            : { value: series.value }),
        }),
      ),
    );
  }

  renderPrometheus() {
    const lines: string[] = [];
    for (const definition of this.#definitions.values()) {
      const series = [...(this.#series.get(definition.name)?.values() ?? [])];
      if (!series.length) continue;
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.kind}`);
      for (const item of series) {
        if (definition.kind === "histogram") {
          for (const bucket of item.buckets) {
            lines.push(
              `${definition.name}_bucket${labelText(item.labels, { le: String(bucket.le) })} ${bucket.count}`,
            );
          }
          lines.push(
            `${definition.name}_bucket${labelText(item.labels, { le: "+Inf" })} ${item.count}`,
          );
          lines.push(
            `${definition.name}_sum${labelText(item.labels)} ${item.sum}`,
          );
          lines.push(
            `${definition.name}_count${labelText(item.labels)} ${item.count}`,
          );
        } else {
          lines.push(
            `${definition.name}${labelText(item.labels)} ${item.value}`,
          );
        }
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private series(
    name: string,
    labels: MetricLabels,
    kind: MetricKind,
  ): [MetricDefinition, Series] {
    const definition = this.#definitions.get(name);
    if (!definition || definition.kind !== kind) {
      throw new Error(`Unknown ${kind} metric: ${name}`);
    }
    const unknown = Object.keys(labels).filter(
      (label) => !definition.labels.includes(label),
    );
    if (unknown.length) {
      throw new Error(
        `Metric ${name} received undeclared labels: ${unknown.join(", ")}`,
      );
    }
    const normalized = Object.fromEntries(
      definition.labels.map((label) => [
        label,
        boundedLabelValue(label, labels[label]),
      ]),
    );
    let key = JSON.stringify(normalized);
    const values = this.#series.get(name)!;
    if (!values.has(key) && values.size >= this.maxSeriesPerMetric) {
      for (const label of definition.labels) normalized[label] = "overflow";
      key = JSON.stringify(normalized);
    }
    return [
      definition,
      values.get(key) ?? {
        key,
        labels: normalized,
        value: 0,
        count: 0,
        sum: 0,
        buckets: (definition.buckets ?? []).map((le) => ({ le, count: 0 })),
      },
    ];
  }
}

type Series = {
  key: string;
  labels: Record<string, string>;
  value: number;
  count: number;
  sum: number;
  buckets: Array<{ le: number; count: number }>;
};

function definition(
  name: string,
  help: string,
  kind: MetricKind,
  labels: readonly string[],
  buckets?: readonly number[],
): MetricDefinition {
  return { name, help, kind, labels, ...(buckets ? { buckets } : {}) };
}

function boundedLabelValue(label: string, raw: MetricLabels[string]) {
  const value = String(raw ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]/g, "_")
    .slice(0, 64);
  const allowlist = LABEL_VALUES[label];
  return allowlist && !allowlist.has(value) ? "other" : value || "unknown";
}

const LABEL_VALUES: Record<string, ReadonlySet<string> | undefined> = {
  service: new Set(["api", "orchestrator", "worker"]),
  method: new Set(["get", "post", "put", "patch", "delete", "options", "head"]),
  status_class: new Set(["1xx", "2xx", "3xx", "4xx", "5xx"]),
  trigger: new Set([
    "api",
    "schedule",
    "date",
    "webhook",
    "job",
    "completion",
    "manual",
    "unknown",
  ]),
  status: new Set([
    "up",
    "healthy",
    "stale",
    "stopped",
    "draining",
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "retry",
    "dead_letter",
    "ignored",
    "terminal",
    "success",
    "error",
    "unknown",
  ]),
  task_kind: new Set([
    "step",
    "step-shard",
    "step-intermediate-reduce",
    "step-reduce",
    "unknown",
  ]),
  action_source: new Set(["builtin", "registry", "unknown"]),
  placement: new Set([
    "local-workers",
    "specific-worker",
    "execution-location",
    "unassigned",
    "unknown",
  ]),
  outcome: new Set([
    "success",
    "error",
    "retry",
    "dead_letter",
    "ignored",
    "selected",
    "unavailable",
    "unknown",
  ]),
  reason: new Set([
    "action_failure",
    "expired_lease",
    "max_attempts",
    "invalid_message",
    "handler_error",
    "draining",
    "permission",
    "configuration",
    "trust",
    "sandbox",
    "unknown",
  ]),
  operation: new Set(["publish", "receive", "ack", "nak", "dead_letter"]),
  state: new Set([
    "queued",
    "retry_scheduled",
    "running",
    "dead_letter",
    "unknown",
  ]),
};

function labelText(
  labels: Record<string, string>,
  extra: Record<string, string> = {},
) {
  const entries = Object.entries({ ...labels, ...extra });
  return entries.length
    ? `{${entries.map(([key, value]) => `${key}="${value.replace(/[\\"\n]/g, "_")}"`).join(",")}}`
    : "";
}

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

export function actionSourceLabel(
  actionPackageName: string | null | undefined,
) {
  return actionPackageName?.startsWith("@beam/")
    ? "builtin"
    : actionPackageName
      ? "registry"
      : "unknown";
}

export function placementLabel(value: string | null | undefined) {
  if (!value) return "unassigned";
  if (
    value === "local-workers" ||
    value === "specific-worker" ||
    value === "execution-location"
  )
    return value;
  return "unknown";
}
