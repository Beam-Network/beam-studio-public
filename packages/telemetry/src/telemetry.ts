import {
  MetricRegistry,
  type MetricLabels,
  type MetricPoint,
} from "./metrics.js";
import {
  redactTelemetryAttributes,
  redactTelemetryValue,
} from "./redaction.js";
import {
  activeTraceContext,
  createTraceContext,
  type TraceContext,
} from "./trace-context.js";

export type SpanData = {
  name: string;
  service: string;
  context: TraceContext;
  parentSpanId: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  attributes: Record<string, unknown>;
};

export type LogData = {
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
  traceId: string | null;
  spanId: string | null;
  correlationId: string | null;
  attributes: Record<string, unknown>;
};

export interface MetricExporter {
  export(metrics: MetricPoint[]): void | Promise<void>;
  check?(): void | Promise<void>;
}

export interface TraceExporter {
  export(span: SpanData): void | Promise<void>;
  check?(): void | Promise<void>;
}

export interface LogExporter {
  export(log: LogData): void | Promise<void>;
  check?(): void | Promise<void>;
}

type StructuredLogger = {
  debug(payload: unknown, message: string): void;
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
  error(payload: unknown, message: string): void;
};

export class LoggerTraceExporter implements TraceExporter {
  constructor(private readonly logger: StructuredLogger) {}
  export(span: SpanData) {
    this.logger.debug(
      { telemetry: "trace", span },
      "Distributed span completed",
    );
  }
}

export class LoggerLogExporter implements LogExporter {
  constructor(private readonly logger: StructuredLogger) {}
  export(log: LogData) {
    this.logger[log.level]({ telemetry: "log", ...log }, log.message);
  }
}

export class InMemoryMetricExporter implements MetricExporter {
  readonly exports: MetricPoint[][] = [];
  failure: Error | null = null;
  export(metrics: MetricPoint[]) {
    if (this.failure) throw this.failure;
    this.exports.push(structuredClone(metrics));
  }
  check() {
    if (this.failure) throw this.failure;
  }
}

export class InMemoryTraceExporter implements TraceExporter {
  readonly spans: SpanData[] = [];
  failure: Error | null = null;
  export(span: SpanData) {
    if (this.failure) throw this.failure;
    this.spans.push(structuredClone(span));
  }
  check() {
    if (this.failure) throw this.failure;
  }
}

export class InMemoryLogExporter implements LogExporter {
  readonly logs: LogData[] = [];
  failure: Error | null = null;
  export(log: LogData) {
    if (this.failure) throw this.failure;
    this.logs.push(structuredClone(log));
  }
  check() {
    if (this.failure) throw this.failure;
  }
}

export class Telemetry {
  readonly metrics: MetricRegistry;
  readonly #metricExporter?: MetricExporter;
  readonly #traceExporter?: TraceExporter;
  readonly #logExporter?: LogExporter;

  constructor(
    readonly service: "api" | "orchestrator" | "worker",
    options: {
      metrics?: MetricRegistry;
      metricExporter?: MetricExporter;
      traceExporter?: TraceExporter;
      logExporter?: LogExporter;
    } = {},
  ) {
    this.metrics = options.metrics ?? new MetricRegistry();
    this.#metricExporter = options.metricExporter;
    this.#traceExporter = options.traceExporter;
    this.#logExporter = options.logExporter;
    this.metrics.set("beam_service_up", 1, { service });
  }

  startSpan(
    name: string,
    options: {
      parent?: TraceContext | null;
      correlationId?: string;
      attributes?: Record<string, unknown>;
    } = {},
  ) {
    const parent =
      options.parent === undefined ? activeTraceContext() : options.parent;
    const correlationId =
      options.correlationId ?? parent?.correlationId ?? "uncorrelated";
    const context = createTraceContext(correlationId, parent);
    const started = Date.now();
    const attributes: Record<string, unknown> = {
      ...(options.attributes ?? {}),
    };
    let ended = false;
    return {
      context,
      setAttribute(key: string, value: unknown) {
        attributes[key] = value;
      },
      end: (
        status: "ok" | "error" = "ok",
        finalAttributes: Record<string, unknown> = {},
      ) => {
        if (ended) return;
        ended = true;
        const endedAt = Date.now();
        const span: SpanData = {
          name,
          service: this.service,
          context,
          parentSpanId: parent?.spanId ?? null,
          startedAt: new Date(started).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          durationMs: Math.max(0, endedAt - started),
          status,
          attributes: redactTelemetryAttributes({
            ...attributes,
            ...finalAttributes,
          }),
        };
        try {
          void Promise.resolve(this.#traceExporter?.export(span)).catch(
            () => undefined,
          );
        } catch {
          // Trace export is best effort and cannot change runtime semantics.
        }
      },
    };
  }

  log(
    level: LogData["level"],
    message: string,
    attributes: Record<string, unknown> = {},
    context = activeTraceContext(),
  ) {
    const log: LogData = {
      service: this.service,
      level,
      message: String(redactTelemetryValue(message)),
      timestamp: new Date().toISOString(),
      traceId: context?.traceId ?? null,
      spanId: context?.spanId ?? null,
      correlationId: context?.correlationId ?? null,
      attributes: redactTelemetryAttributes(attributes),
    };
    try {
      void Promise.resolve(this.#logExporter?.export(log)).catch(
        () => undefined,
      );
    } catch {
      // Log export is best effort and cannot change runtime semantics.
    }
  }

  add(name: string, value = 1, labels: MetricLabels = {}) {
    this.metrics.add(name, value, labels);
  }
  set(name: string, value: number, labels: MetricLabels = {}) {
    this.metrics.set(name, value, labels);
  }
  observe(name: string, value: number, labels: MetricLabels = {}) {
    this.metrics.observe(name, value, labels);
  }

  async check() {
    await Promise.all([
      this.#metricExporter?.check?.(),
      this.#traceExporter?.check?.(),
      this.#logExporter?.check?.(),
    ]);
  }

  async exportMetrics() {
    await this.check();
    const snapshot = this.metrics.snapshot();
    await this.#metricExporter?.export(snapshot);
    return this.metrics.renderPrometheus();
  }
}
