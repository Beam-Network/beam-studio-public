import {
  connect,
  RetentionPolicy,
  StorageType,
  StringCodec,
  type NatsConnection,
} from "nats";
import { taskStreamSubject, taskSubjectFor } from "@beam-studio/core";
import {
  formatTraceparent,
  parseTraceparent,
  type Telemetry,
} from "@beam-studio/telemetry";
import type {
  PreparedTaskPublication,
  TaskBroker,
  TaskPublishRequest,
} from "./types.js";

type NatsLogger = {
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
  error(payload: unknown, message: string): void;
};

export type TaskBrokerOptions = {
  subjectRoot: string;
  streamName: string;
  deadLetterSubject: string;
  logger?: NatsLogger;
  telemetry?: Telemetry;
  additionalStreamSubjects?: string[];
  preparePublication?: (
    request: TaskPublishRequest,
  ) => Promise<PreparedTaskPublication | null>;
};

export async function connectTaskBroker(
  servers: string,
  options: TaskBrokerOptions,
): Promise<TaskBroker & { close(): Promise<void> }> {
  options.logger?.info({ servers }, "NATS connect requested");
  const connection = await connect({ servers });
  options.logger?.info(
    {
      servers,
      connectedServer: connection.getServer(),
    },
    "NATS connected",
  );
  logConnectionStatus(connection, options.logger);
  await ensureTaskStream(connection, options);
  return natsTaskBroker(connection, options);
}

export async function ensureTaskStream(
  connection: NatsConnection,
  options: TaskBrokerOptions,
) {
  const manager = await connection.jetstreamManager();
  const subjects = streamSubjects(
    taskStreamSubject(options.subjectRoot),
    options.deadLetterSubject,
    options.additionalStreamSubjects,
  );
  options.logger?.info(
    { stream: options.streamName, subjects },
    "NATS JetStream ensure stream",
  );
  try {
    const info = await manager.streams.info(options.streamName);
    const nextSubjects = Array.from(
      new Set([...(info.config.subjects ?? []), ...subjects]),
    );
    await manager.streams.update(options.streamName, {
      ...info.config,
      subjects: nextSubjects,
    });
    options.logger?.info(
      {
        stream: options.streamName,
        subjects: nextSubjects,
      },
      "NATS JetStream stream updated",
    );
  } catch {
    await manager.streams.add({
      name: options.streamName,
      subjects,
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
    });
    options.logger?.info(
      { stream: options.streamName, subjects },
      "NATS JetStream stream created",
    );
  }
}

function streamSubjects(
  taskSubject: string,
  deadLetterSubject: string,
  additionalSubjects: string[] = [],
) {
  const wildcardRoot = taskSubject.endsWith(".>")
    ? taskSubject.slice(0, -2)
    : null;
  if (wildcardRoot && deadLetterSubject.startsWith(`${wildcardRoot}.`)) {
    return Array.from(new Set([taskSubject, ...additionalSubjects]));
  }
  return Array.from(
    new Set([taskSubject, deadLetterSubject, ...additionalSubjects]),
  );
}

export function natsTaskBroker(
  connection: NatsConnection,
  options: TaskBrokerOptions,
): TaskBroker & { close(): Promise<void> } {
  const codec = StringCodec();
  const jetstream = connection.jetstream();
  const pending = new Set<Promise<unknown>>();
  return {
    async publishTask(task) {
      const request = normalizeTaskRequest(task);
      const span = options.telemetry?.startSpan("nats.task.publish", {
        parent: parseTraceparent(
          request.traceparent,
          request.correlationId ?? request.workflowRunId ?? request.taskId,
        ),
        correlationId:
          request.correlationId ?? request.workflowRunId ?? request.taskId,
        attributes: {
          "messaging.system": "nats",
          "workflow.run_id": request.workflowRunId,
          "workflow.task_id": request.taskId,
        },
      });
      const prepared = options.preparePublication
        ? await options.preparePublication(request)
        : null;
      if (options.preparePublication && !prepared) {
        span?.end("ok", { "messaging.outcome": "skipped" });
        return;
      }
      const subject =
        prepared?.subject ??
        request.subject ??
        taskSubjectFor({
          root: options.subjectRoot,
          actionPackageName: request.actionPackageName,
          taskKind: request.taskKind,
          targetWorkerId: request.targetWorkerId,
        });
      const payload = prepared?.payload ?? {
        taskId: request.taskId,
        workflowRunId: request.workflowRunId,
        correlationId: request.correlationId,
        traceparent: span
          ? formatTraceparent(span.context)
          : request.traceparent,
      };
      options.logger?.info(
        {
          taskId: request.taskId,
          subject,
          taskKind: request.taskKind,
          actionPackageName: request.actionPackageName,
          targetWorkerId: request.targetWorkerId ?? null,
          workflowRunId: request.workflowRunId,
          correlationId: request.correlationId,
          traceId: span?.context.traceId,
        },
        "NATS publish task requested",
      );
      const publish = jetstream
        .publish(subject, codec.encode(JSON.stringify(payload)), {
          msgID: prepared?.messageId ?? request.messageId ?? request.taskId,
        })
        .then((ack) => {
          options.telemetry?.add("beam_nats_messages_total", 1, {
            operation: "publish",
            outcome: "success",
          });
          span?.end("ok", { "messaging.nats.duplicate": ack.duplicate });
          options.logger?.info(
            {
              taskId: request.taskId,
              subject,
              stream: ack.stream,
              sequence: ack.seq,
              duplicate: ack.duplicate,
            },
            "NATS publish task acknowledged",
          );
        })
        .catch((error) => {
          options.telemetry?.add("beam_nats_messages_total", 1, {
            operation: "publish",
            outcome: "error",
          });
          span?.end("error", {
            error: error instanceof Error ? error.message : String(error),
          });
          options.logger?.error(
            {
              taskId: request.taskId,
              subject,
              error,
            },
            "NATS publish task failed",
          );
          throw error;
        })
        .finally(() => pending.delete(publish));
      pending.add(publish);
      await publish;
    },
    async close() {
      options.logger?.info({ pending: pending.size }, "NATS broker closing");
      await Promise.allSettled(pending);
      await connection.drain();
      options.logger?.info({}, "NATS broker closed");
    },
  };
}

export function noopTaskBroker(): TaskBroker {
  return {
    async publishTask() {},
  };
}

export function resilientTaskBroker(
  servers: string,
  options: TaskBrokerOptions,
): TaskBroker & {
  close(): Promise<void>;
  isReady(): boolean;
  ready(): Promise<boolean>;
} {
  let broker: (TaskBroker & { close(): Promise<void> }) | null = null;
  let connecting: Promise<TaskBroker & { close(): Promise<void> }> | null =
    null;
  let closed = false;

  async function currentBroker() {
    if (closed) {
      throw new Error("NATS task broker is closed.");
    }
    if (broker) {
      return broker;
    }
    connecting ??= connectTaskBroker(servers, options);
    try {
      broker = await connecting;
      return broker;
    } catch (error) {
      options.logger?.warn(
        { servers, error },
        "NATS unavailable; durable task publications remain pending",
      );
      throw error;
    } finally {
      connecting = null;
    }
  }

  return {
    async publishTask(task) {
      const active = await currentBroker();
      try {
        await active.publishTask(task);
      } catch (error) {
        broker = null;
        await active.close().catch(() => undefined);
        throw error;
      }
    },
    isReady() {
      return broker !== null;
    },
    async ready() {
      try {
        await currentBroker();
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      closed = true;
      const active = broker;
      broker = null;
      if (active) {
        await active.close();
      }
    },
  };
}

function normalizeTaskRequest(task: string | TaskPublishRequest) {
  return typeof task === "string" ? { taskId: task } : task;
}

function logConnectionStatus(
  connection: NatsConnection,
  logger: NatsLogger | undefined,
) {
  if (!logger) {
    return;
  }
  void (async () => {
    for await (const status of connection.status()) {
      logger.info(
        {
          type: status.type,
          data: status.data,
        },
        "NATS connection status",
      );
    }
  })();
  void connection.closed().then((error) => {
    if (error) {
      logger.error({ error }, "NATS connection closed with error");
      return;
    }
    logger.info({}, "NATS connection closed");
  });
}
