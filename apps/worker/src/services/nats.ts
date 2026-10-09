import {
  connect,
  consumerOpts,
  RetentionPolicy,
  StorageType,
  StringCodec,
  type ConsumerInfo,
  type JetStreamPullSubscription,
  type JsMsg,
  type NatsConnection,
} from "nats";
import {
  interchangeableTaskSubject,
  taskStreamSubject,
  workerTaskSubject,
} from "@beam-studio/core";
import type { TaskProcessResult } from "./taskTypes.js";
import {
  parseTraceparent,
  type Telemetry,
} from "@beam-studio/telemetry";

type NatsLogger = {
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
  error(payload: unknown, message: string): void;
};

export type TaskMessage = {
  taskId: string;
  workflowRunId?: string;
  correlationId?: string;
  traceparent?: string;
};

export type TaskSubscriptionOptions = {
  subjectRoot: string;
  streamName: string;
  queueGroup: string;
  workerId: string;
  concurrency: number;
  fleetConcurrency: number;
  ackWaitMs: number;
  maxDeliver: number;
  redeliveryDelayMs: number;
  deadLetterSubject: string;
  logger?: NatsLogger;
  telemetry?: Telemetry;
};

export type TaskSubscriptionInput = {
  subject: string;
  durable: string;
  queueGroup?: string;
};

export async function connectNats(servers: string, logger?: NatsLogger) {
  logger?.info({ servers }, "NATS connect requested");
  const connection = await connect({ servers });
  logger?.info(
    {
      servers,
      connectedServer: connection.getServer(),
    },
    "NATS connected",
  );
  logConnectionStatus(connection, logger);
  return connection;
}

export async function subscribeToTasks(
  connection: NatsConnection,
  options: TaskSubscriptionOptions,
  handler: (message: TaskMessage) => Promise<TaskProcessResult>,
) {
  await ensureTaskStream(connection, options);
  const jetstream = connection.jetstream();
  options.logger?.info(
    {
      subjectRoot: options.subjectRoot,
      stream: options.streamName,
      queueGroup: options.queueGroup,
      workerId: options.workerId,
      concurrency: options.concurrency,
      fleetConcurrency: options.fleetConcurrency,
      ackWaitMs: options.ackWaitMs,
      maxDeliver: options.maxDeliver,
    },
    "NATS task subscription setup requested",
  );
  const subscriptionInputs: TaskSubscriptionInput[] = [
    {
      subject: interchangeableTaskSubject(options.subjectRoot),
      durable: `${options.queueGroup}_interchangeable`,
      queueGroup: options.queueGroup,
    },
    {
      subject: workerTaskSubject(options.workerId, options.subjectRoot),
      durable: `${options.queueGroup}_${options.workerId}`.replace(
        /[^a-zA-Z0-9_-]+/g,
        "_",
      ),
    },
  ];
  await removeInactiveFilterConflicts(connection, options, subscriptionInputs);
  await removeInactiveWorkerConsumers(connection, options, subscriptionInputs);
  await migrateTaskConsumersToPull(connection, options, subscriptionInputs);
  await reconcileTaskConsumerCapacity(connection, options, subscriptionInputs);
  const subscriptions = await Promise.all(
    subscriptionInputs.map((input) =>
      createSubscription(connection, options, input),
    ),
  );
  options.logger?.info(
    {
      subscriptions: subscriptions.length,
      subjects: [
        interchangeableTaskSubject(options.subjectRoot),
        workerTaskSubject(options.workerId, options.subjectRoot),
      ],
    },
    "NATS task subscriptions ready",
  );
  const active = new Set<Promise<void>>();
  const closed = subscriptions.map((subscription) =>
    consume(subscription, options, active, handler, (message, reason) =>
      publishDeadLetter(jetstream, options, message, reason),
    ),
  );
  return {
    unsubscribe() {
      options.logger?.info({}, "NATS task subscriptions unsubscribe requested");
      subscriptions.forEach((subscription) => subscription.unsubscribe());
    },
    async close() {
      options.logger?.info(
        { active: active.size },
        "NATS task subscriptions closing",
      );
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      await Promise.allSettled(closed);
      await Promise.allSettled(active);
      options.logger?.info({}, "NATS task subscriptions closed");
    },
  };
}

export async function reconcileTaskConsumerCapacity(
  connection: NatsConnection,
  options: Pick<
    TaskSubscriptionOptions,
    | "streamName"
    | "concurrency"
    | "fleetConcurrency"
    | "ackWaitMs"
    | "logger"
  >,
  inputs: TaskSubscriptionInput[],
) {
  const manager = await connection.jetstreamManager();
  for (const input of inputs) {
    let consumer: ConsumerInfo;
    try {
      consumer = await manager.consumers.info(options.streamName, input.durable);
    } catch (error) {
      if (isConsumerNotFound(error)) {
        continue;
      }
      throw error;
    }
    const maxAckPending = taskConsumerMaxAckPending(options, input);
    const ackWaitNanos = options.ackWaitMs * 1_000_000;
    if (
      consumer.config.max_ack_pending === maxAckPending &&
      consumer.config.ack_wait === ackWaitNanos
    ) {
      continue;
    }
    await manager.consumers.update(options.streamName, input.durable, {
      max_ack_pending: maxAckPending,
      ack_wait: ackWaitNanos,
    });
    options.logger?.info(
      {
        stream: options.streamName,
        consumer: input.durable,
        previousMaxAckPending: consumer.config.max_ack_pending ?? null,
        previousAckWaitNanos: consumer.config.ack_wait ?? null,
        maxAckPending,
        ackWaitNanos,
      },
      "NATS task consumer delivery settings reconciled",
    );
  }
}

export async function migrateTaskConsumersToPull(
  connection: NatsConnection,
  options: Pick<TaskSubscriptionOptions, "streamName" | "logger">,
  inputs: TaskSubscriptionInput[],
) {
  const manager = await connection.jetstreamManager();
  for (const input of inputs) {
    let consumer: ConsumerInfo;
    try {
      consumer = await manager.consumers.info(options.streamName, input.durable);
    } catch (error) {
      if (isConsumerNotFound(error)) {
        continue;
      }
      throw error;
    }
    if (!consumer.config.deliver_subject) {
      continue;
    }
    if (consumer.push_bound || consumer.num_ack_pending > 0) {
      throw new Error(
        `Task consumer "${input.durable}" must be inactive before migrating from push to pull delivery.`,
      );
    }
    try {
      await manager.consumers.delete(options.streamName, input.durable);
    } catch (error) {
      if (!isConsumerNotFound(error)) {
        throw error;
      }
    }
    options.logger?.info(
      {
        stream: options.streamName,
        consumer: input.durable,
        pending: consumer.num_pending,
      },
      "NATS task consumer migrated to pull delivery",
    );
  }
}

function isConsumerNotFound(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return (
    code === 404 ||
    code === "404" ||
    (error instanceof Error && /consumer not found/i.test(error.message))
  );
}

export function taskConsumerMaxAckPending(
  options: Pick<TaskSubscriptionOptions, "concurrency" | "fleetConcurrency">,
  input: Pick<TaskSubscriptionInput, "queueGroup">,
) {
  return Math.max(
    1,
    input.queueGroup ? options.fleetConcurrency : options.concurrency,
  );
}

export function taskAckProgressIntervalMs(ackWaitMs: number) {
  return Math.max(1_000, Math.min(30_000, Math.floor(ackWaitMs / 3)));
}

export function taskPullExpiresMs(ackWaitMs: number) {
  return Math.max(1_000, Math.min(30_000, Math.floor(ackWaitMs / 3)));
}

export function taskPullRenewIntervalMs(pullExpiresMs: number) {
  return Math.max(1_000, Math.floor(pullExpiresMs / 2));
}

export type TaskPullDemandInput = {
  concurrency: number;
  active: number;
  pendingPullSlots: number;
  pullExpiresAtMs: number;
  nowMs: number;
};

export type TaskPullDemand = {
  batch: number;
  pendingPullSlots: number;
};

export function taskPullDemand(input: TaskPullDemandInput): TaskPullDemand {
  const pendingPullSlots =
    input.nowMs >= input.pullExpiresAtMs ? 0 : input.pendingPullSlots;
  const batch = Math.max(0, input.concurrency - input.active - pendingPullSlots);
  return { batch, pendingPullSlots };
}

async function removeInactiveFilterConflicts(
  connection: NatsConnection,
  options: TaskSubscriptionOptions,
  inputs: TaskSubscriptionInput[],
) {
  const manager = await connection.jetstreamManager();
  const consumers = await listTaskConsumers(manager, options.streamName);

  for (const input of inputs) {
    const conflict = consumers.find(
      (consumer) =>
        consumer.name !== input.durable &&
        consumerFilterSubjects(consumer).includes(input.subject),
    );
    if (!conflict) {
      continue;
    }

    if (!canReplaceInactiveConsumer(conflict)) {
      const owner = conflict.config.deliver_group
        ? ` queue group "${conflict.config.deliver_group}"`
        : "";
      throw new Error(
        `Task subject "${input.subject}" is already owned by consumer "${conflict.name}"${owner} on work-queue stream "${options.streamName}". Stop or drain that consumer before changing NATS_WORKER_QUEUE_GROUP.`,
      );
    }

    const deleted = await manager.consumers.delete(
      options.streamName,
      conflict.name,
    );
    if (deleted) {
      options.logger?.warn(
        {
          stream: options.streamName,
          subject: input.subject,
          consumer: conflict.name,
          replacement: input.durable,
        },
        "NATS inactive task consumer replaced",
      );
    }
  }
}

export function canReplaceInactiveConsumer(consumer: ConsumerInfo) {
  return (
    !consumer.push_bound &&
    consumer.num_ack_pending === 0 &&
    consumer.num_waiting === 0 &&
    consumer.num_pending === 0
  );
}

export async function removeInactiveWorkerConsumers(
  connection: NatsConnection,
  options: Pick<
    TaskSubscriptionOptions,
    "streamName" | "queueGroup" | "subjectRoot" | "logger"
  >,
  inputs: TaskSubscriptionInput[],
) {
  const manager = await connection.jetstreamManager();
  const consumers = await listTaskConsumers(manager, options.streamName);
  const activeDurables = new Set(inputs.map((input) => input.durable));
  const durablePrefix = `${options.queueGroup}_`;
  const directSubjectPrefix = `${options.subjectRoot}.worker.`;

  for (const consumer of consumers) {
    const name = consumer.name || consumer.config.durable_name || "";
    if (
      activeDurables.has(name) ||
      name === `${options.queueGroup}_interchangeable` ||
      !name.startsWith(durablePrefix)
    ) {
      continue;
    }
    if (
      !consumerFilterSubjects(consumer).some((subject) =>
        subject.startsWith(directSubjectPrefix),
      )
    ) {
      continue;
    }
    if (!canReplaceInactiveConsumer(consumer)) {
      continue;
    }

    try {
      const deleted = await manager.consumers.delete(options.streamName, name);
      if (deleted) {
        options.logger?.warn(
          {
            stream: options.streamName,
            consumer: name,
          },
          "NATS inactive direct worker consumer removed",
        );
      }
    } catch (error) {
      if (!isConsumerNotFound(error)) {
        throw error;
      }
    }
  }
}

async function listTaskConsumers(
  manager: Awaited<ReturnType<NatsConnection["jetstreamManager"]>>,
  streamName: string,
) {
  const lister = manager.consumers.list(streamName);
  const consumers: ConsumerInfo[] = [];
  for await (const consumer of lister) {
    consumers.push(consumer);
  }
  return consumers;
}

function consumerFilterSubjects(consumer: ConsumerInfo) {
  if (consumer.config.filter_subjects?.length) {
    return consumer.config.filter_subjects;
  }
  return consumer.config.filter_subject ? [consumer.config.filter_subject] : [];
}

async function ensureTaskStream(
  connection: NatsConnection,
  options: TaskSubscriptionOptions,
) {
  const manager = await connection.jetstreamManager();
  const subjects = streamSubjects(
    taskStreamSubject(options.subjectRoot),
    options.deadLetterSubject,
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

function streamSubjects(taskSubject: string, deadLetterSubject: string) {
  const wildcardRoot = taskSubject.endsWith(".>")
    ? taskSubject.slice(0, -2)
    : null;
  if (wildcardRoot && deadLetterSubject.startsWith(`${wildcardRoot}.`)) {
    return [taskSubject];
  }
  return [taskSubject, deadLetterSubject];
}

async function createSubscription(
  connection: NatsConnection,
  options: TaskSubscriptionOptions,
  input: TaskSubscriptionInput,
) {
  const opts = consumerOpts();
  opts.durable(input.durable);
  opts.manualAck();
  opts.ackExplicit();
  opts.deliverAll();
  opts.ackWait(options.ackWaitMs);
  opts.maxDeliver(options.maxDeliver);
  opts.maxAckPending(taskConsumerMaxAckPending(options, input));
  opts.filterSubject(input.subject);
  options.logger?.info(
    {
      subject: input.subject,
      durable: input.durable,
      queueGroup: input.queueGroup ?? null,
    },
    "NATS subscribe requested",
  );
  const subscription = await connection
    .jetstream()
    .pullSubscribe(input.subject, opts);
  options.logger?.info(
    {
      subject: input.subject,
      durable: input.durable,
      queueGroup: input.queueGroup ?? null,
    },
    "NATS subscribe ready",
  );
  return subscription;
}

async function consume(
  subscription: JetStreamPullSubscription,
  options: TaskSubscriptionOptions,
  active: Set<Promise<void>>,
  handler: (message: TaskMessage) => Promise<TaskProcessResult>,
  publishDeadLetter: (message: JsMsg, reason: string) => Promise<unknown>,
) {
  const pullExpiresMs = taskPullExpiresMs(options.ackWaitMs);
  const pullRenewIntervalMs = taskPullRenewIntervalMs(pullExpiresMs);
  let pendingPullSlots = 0;
  let pullExpiresAtMs = 0;

  const requestPull = () => {
    const demand = taskPullDemand({
      concurrency: options.concurrency,
      active: active.size,
      pendingPullSlots,
      pullExpiresAtMs,
      nowMs: Date.now(),
    });
    pendingPullSlots = demand.pendingPullSlots;
    if (demand.batch <= 0 || subscription.isClosed()) {
      return;
    }
    try {
      subscription.pull({
        batch: demand.batch,
        expires: pullExpiresMs,
        idle_heartbeat: Math.floor(pullExpiresMs / 2),
      });
      pendingPullSlots += demand.batch;
      pullExpiresAtMs = Date.now() + pullExpiresMs;
    } catch (error) {
      options.logger?.warn(
        { error, pullExpiresMs },
        "NATS task pull request failed",
      );
      pendingPullSlots = 0;
      pullExpiresAtMs = Date.now() + pullRenewIntervalMs;
    }
  };

  requestPull();
  const pullRenewal = setInterval(requestPull, pullRenewIntervalMs);
  pullRenewal.unref();

  try {
    for await (const message of subscription) {
      pendingPullSlots = Math.max(0, pendingPullSlots - 1);
      options.logger?.info(
        messageLogPayload(message, { active: active.size }),
        "NATS message received",
      );
      while (active.size >= options.concurrency) {
        options.logger?.info(
          messageLogPayload(message, {
            active: active.size,
            concurrency: options.concurrency,
          }),
          "NATS message waiting for worker concurrency",
        );
        await Promise.race(active);
      }
      let task: Promise<void>;
      task = handleMessage(message, options, handler, publishDeadLetter).finally(
        () => {
          active.delete(task);
          requestPull();
        },
      );
      active.add(task);
    }
  } finally {
    clearInterval(pullRenewal);
  }
}

async function handleMessage(
  message: JsMsg,
  options: TaskSubscriptionOptions,
  handler: (message: TaskMessage) => Promise<TaskProcessResult>,
  publishDeadLetter: (message: JsMsg, reason: string) => Promise<unknown>,
) {
  const payload = parseMessage(message);
  options.telemetry?.add("beam_nats_messages_total", 1, {
    operation: "receive",
    outcome: payload?.taskId ? "success" : "error",
  });
  if (!payload?.taskId) {
    options.logger?.warn(
      messageLogPayload(message),
      "NATS message invalid task payload",
    );
    await publishDeadLetter(message, "invalid");
    options.telemetry?.add("beam_nats_messages_total", 1, {
      operation: "dead_letter",
      outcome: "error",
    });
    options.logger?.warn(
      messageLogPayload(message, { reason: "invalid" }),
      "NATS message terminal ack requested",
    );
    message.term("invalid task payload");
    return;
  }
  const receiveSpan = options.telemetry?.startSpan("nats.task.receive", {
    parent: parseTraceparent(
      payload.traceparent,
      payload.correlationId ?? payload.workflowRunId ?? payload.taskId,
    ),
    correlationId:
      payload.correlationId ?? payload.workflowRunId ?? payload.taskId,
    attributes: {
      "messaging.system": "nats",
      "workflow.run_id": payload.workflowRunId,
      "workflow.task_id": payload.taskId,
    },
  });
  options.logger?.info(
    messageLogPayload(message, {
      taskId: payload.taskId,
      workflowRunId: payload.workflowRunId,
      correlationId: payload.correlationId,
      traceId: receiveSpan?.context.traceId,
    }),
    "NATS task handler started",
  );
  const progressHeartbeat = startNatsProgressHeartbeat(
    message,
    options,
    payload,
  );
  try {
    const result = await handler(payload);
    options.logger?.info(
      messageLogPayload(message, {
        taskId: payload.taskId,
        status: result.status,
        retryDelayMs: result.retryDelayMs ?? null,
      }),
      "NATS task handler finished",
    );
    if (result.status === "retry") {
      options.telemetry?.add("beam_nats_messages_total", 1, {
        operation: "nak",
        outcome: "retry",
      });
      receiveSpan?.end("ok", { "messaging.outcome": "retry" });
      options.logger?.warn(
        messageLogPayload(message, {
          taskId: payload.taskId,
          retryDelayMs: result.retryDelayMs || options.redeliveryDelayMs,
        }),
        "NATS message nak requested",
      );
      message.nak(result.retryDelayMs || options.redeliveryDelayMs);
      return;
    }
    if (result.status === "dead_letter") {
      await publishDeadLetter(message, "terminal");
      options.logger?.warn(
        messageLogPayload(message, {
          taskId: payload.taskId,
          reason: "terminal",
        }),
        "NATS message terminal ack requested",
      );
      message.term("terminal workflow task failure");
      options.telemetry?.add("beam_nats_messages_total", 1, {
        operation: "dead_letter",
        outcome: "dead_letter",
      });
      receiveSpan?.end("error", { "messaging.outcome": "dead_letter" });
      return;
    }
    options.logger?.info(
      messageLogPayload(message, { taskId: payload.taskId }),
      "NATS message ack requested",
    );
    message.ack();
    options.telemetry?.add("beam_nats_messages_total", 1, {
      operation: "ack",
      outcome: result.status === "ignored" ? "ignored" : "success",
    });
    receiveSpan?.end("ok", { "messaging.outcome": result.status });
  } catch (error) {
    options.logger?.error(
      messageLogPayload(message, {
        taskId: payload.taskId,
        retryDelayMs: options.redeliveryDelayMs,
        error,
      }),
      "NATS task handler crashed; message nak requested",
    );
    message.nak(options.redeliveryDelayMs);
    options.telemetry?.add("beam_nats_messages_total", 1, {
      operation: "nak",
      outcome: "error",
    });
    receiveSpan?.end("error", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    progressHeartbeat.stop();
  }
}

function startNatsProgressHeartbeat(
  message: JsMsg,
  options: TaskSubscriptionOptions,
  payload: TaskMessage,
) {
  const intervalMs = taskAckProgressIntervalMs(options.ackWaitMs);
  const timer = setInterval(() => {
    try {
      message.working();
      options.telemetry?.add("beam_nats_messages_total", 1, {
        operation: "working",
        outcome: "success",
      });
    } catch (error) {
      options.logger?.warn(
        messageLogPayload(message, {
          taskId: payload.taskId,
          error,
        }),
        "NATS task progress ack failed",
      );
      options.telemetry?.add("beam_nats_messages_total", 1, {
        operation: "working",
        outcome: "error",
      });
    }
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function parseMessage(message: JsMsg) {
  try {
    return JSON.parse(StringCodec().decode(message.data)) as TaskMessage;
  } catch {
    return null;
  }
}

async function publishDeadLetter(
  jetstream: ReturnType<NatsConnection["jetstream"]>,
  options: TaskSubscriptionOptions,
  message: JsMsg,
  reason: string,
) {
  const msgID = `dlq-${message.info.streamSequence}-${reason}`;
  options.logger?.warn(
    messageLogPayload(message, {
      deadLetterSubject: options.deadLetterSubject,
      msgID,
      reason,
    }),
    "NATS dead-letter publish requested",
  );
  const ack = await jetstream.publish(options.deadLetterSubject, message.data, {
    msgID,
  });
  options.logger?.warn(
    messageLogPayload(message, {
      deadLetterSubject: options.deadLetterSubject,
      msgID,
      reason,
      stream: ack.stream,
      sequence: ack.seq,
      duplicate: ack.duplicate,
    }),
    "NATS dead-letter publish acknowledged",
  );
}

function messageLogPayload(
  message: JsMsg,
  extra: Record<string, unknown> = {},
) {
  return {
    subject: message.subject,
    stream: message.info.stream,
    consumer: message.info.consumer,
    streamSequence: message.info.streamSequence,
    deliverySequence: message.info.deliverySequence,
    redelivered: message.info.redelivered,
    pending: message.info.pending,
    ...extra,
  };
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
