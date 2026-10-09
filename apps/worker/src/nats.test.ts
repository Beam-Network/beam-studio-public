import assert from "node:assert/strict";
import test from "node:test";
import {
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
  type ConsumerInfo,
  type NatsConnection,
} from "nats";
import {
  canReplaceInactiveConsumer,
  migrateTaskConsumersToPull,
  reconcileTaskConsumerCapacity,
  removeInactiveWorkerConsumers,
  taskAckProgressIntervalMs,
  taskConsumerMaxAckPending,
  taskPullDemand,
  taskPullExpiresMs,
  taskPullRenewIntervalMs,
} from "./services/nats.js";

test("shared task consumers use fleet capacity while direct consumers stay local", () => {
  const capacity = { concurrency: 3, fleetConcurrency: 15 };
  assert.equal(
    taskConsumerMaxAckPending(capacity, { queueGroup: "beam-workers" }),
    15,
  );
  assert.equal(taskConsumerMaxAckPending(capacity, {}), 3);
});

test("reconciles an existing shared consumer to fleet delivery settings", async () => {
  const updates: Array<{
    stream: string;
    durable: string;
    maxAckPending: number;
    ackWaitNanos: number;
  }> = [];
  const connection = {
    async jetstreamManager() {
      return {
        consumers: {
          async info() {
            return consumerInfo({ maxAckPending: 3 });
          },
          async update(
            stream: string,
            durable: string,
            config: { max_ack_pending?: number; ack_wait?: number },
          ) {
            updates.push({
              stream,
              durable,
              maxAckPending: config.max_ack_pending ?? 0,
              ackWaitNanos: config.ack_wait ?? 0,
            });
          },
        },
      };
    },
  } as unknown as NatsConnection;

  await reconcileTaskConsumerCapacity(
    connection,
    {
      streamName: "BEAM_WORKFLOW_TASKS",
      concurrency: 3,
      fleetConcurrency: 15,
      ackWaitMs: 60_000,
    },
    [
      {
        subject: "beam.workflow.tasks.interchangeable",
        durable: "beam-workers_interchangeable",
        queueGroup: "beam-workers",
      },
    ],
  );

  assert.deepEqual(updates, [
    {
      stream: "BEAM_WORKFLOW_TASKS",
      durable: "beam-workers_interchangeable",
      maxAckPending: 15,
      ackWaitNanos: 60_000_000_000,
    },
  ]);
});

test("NATS progress heartbeat cadence stays below ack wait", () => {
  assert.equal(taskAckProgressIntervalMs(60_000), 20_000);
  assert.equal(taskAckProgressIntervalMs(1_500), 1_000);
  assert.equal(taskAckProgressIntervalMs(120_000), 30_000);
});

test("idle task pulls renew before scheduled jobs collapse to one worker", () => {
  assert.equal(taskPullExpiresMs(60_000), 20_000);
  assert.equal(taskPullRenewIntervalMs(20_000), 10_000);
  assert.deepEqual(
    taskPullDemand({
      concurrency: 1,
      active: 0,
      pendingPullSlots: 1,
      pullExpiresAtMs: 2_000,
      nowMs: 1_000,
    }),
    { batch: 0, pendingPullSlots: 1 },
  );
  assert.deepEqual(
    taskPullDemand({
      concurrency: 1,
      active: 0,
      pendingPullSlots: 1,
      pullExpiresAtMs: 2_000,
      nowMs: 2_000,
    }),
    { batch: 1, pendingPullSlots: 0 },
  );
  assert.deepEqual(
    taskPullDemand({
      concurrency: 3,
      active: 1,
      pendingPullSlots: 1,
      pullExpiresAtMs: 2_000,
      nowMs: 1_000,
    }),
    { batch: 1, pendingPullSlots: 1 },
  );
});

test("migrates an inactive push consumer to pull delivery", async () => {
  const deletes: Array<{ stream: string; durable: string }> = [];
  const connection = {
    async jetstreamManager() {
      return {
        consumers: {
          async info() {
            return consumerInfo({
              deliverSubject: "_INBOX.push",
              numPending: 7,
            });
          },
          async delete(stream: string, durable: string) {
            deletes.push({ stream, durable });
          },
        },
      };
    },
  } as unknown as NatsConnection;

  await migrateTaskConsumersToPull(
    connection,
    { streamName: "BEAM_WORKFLOW_TASKS" },
    [
      {
        subject: "beam.workflow.tasks.*",
        durable: "beam-workers_interchangeable",
        queueGroup: "beam-workers",
      },
    ],
  );

  assert.deepEqual(deletes, [
    {
      stream: "BEAM_WORKFLOW_TASKS",
      durable: "beam-workers_interchangeable",
    },
  ]);
});

test("refuses to migrate a push consumer with an active subscriber", async () => {
  const connection = {
    async jetstreamManager() {
      return {
        consumers: {
          async info() {
            return consumerInfo({
              deliverSubject: "_INBOX.push",
              push_bound: true,
            });
          },
        },
      };
    },
  } as unknown as NatsConnection;

  await assert.rejects(
    migrateTaskConsumersToPull(
      connection,
      { streamName: "BEAM_WORKFLOW_TASKS" },
      [
        {
          subject: "beam.workflow.tasks.*",
          durable: "beam-workers_interchangeable",
          queueGroup: "beam-workers",
        },
      ],
    ),
    /must be inactive/,
  );
});

test("replaces only inactive consumers without queued work", () => {
  assert.equal(canReplaceInactiveConsumer(consumerInfo()), true);
  assert.equal(
    canReplaceInactiveConsumer(consumerInfo({ push_bound: true })),
    false,
  );
  assert.equal(
    canReplaceInactiveConsumer(consumerInfo({ num_ack_pending: 1 })),
    false,
  );
  assert.equal(
    canReplaceInactiveConsumer(consumerInfo({ num_waiting: 1 })),
    false,
  );
  assert.equal(
    canReplaceInactiveConsumer(consumerInfo({ num_pending: 1 })),
    false,
  );
});

test("removes only inactive direct worker consumers", async () => {
  const deletes: Array<{ stream: string; durable: string }> = [];
  const connection = {
    async jetstreamManager() {
      return {
        consumers: {
          list() {
            return asyncItems([
              [
                consumerInfo({
                  name: "beam-workers_interchangeable",
                  filterSubject: "beam.workflow.tasks.*",
                }),
                consumerInfo({
                  name: "beam-workers_current-worker",
                  filterSubject: "beam.workflow.tasks.worker.current-worker",
                }),
                consumerInfo({
                  name: "beam-workers_stale-worker",
                  filterSubject: "beam.workflow.tasks.worker.stale-worker",
                }),
                consumerInfo({
                  name: "beam-workers_live-worker",
                  filterSubject: "beam.workflow.tasks.worker.live-worker",
                  num_waiting: 1,
                }),
                consumerInfo({
                  name: "beam-workers_other-subject",
                  filterSubject: "beam.workflow.other.worker.stale-worker",
                }),
              ],
            ]);
          },
          async delete(stream: string, durable: string) {
            deletes.push({ stream, durable });
            return true;
          },
        },
      };
    },
  } as unknown as NatsConnection;

  await removeInactiveWorkerConsumers(
    connection,
    {
      streamName: "BEAM_WORKFLOW_TASKS",
      queueGroup: "beam-workers",
      subjectRoot: "beam.workflow.tasks",
    },
    [
      {
        subject: "beam.workflow.tasks.*",
        durable: "beam-workers_interchangeable",
        queueGroup: "beam-workers",
      },
      {
        subject: "beam.workflow.tasks.worker.current-worker",
        durable: "beam-workers_current-worker",
      },
    ],
  );

  assert.deepEqual(deletes, [
    {
      stream: "BEAM_WORKFLOW_TASKS",
      durable: "beam-workers_stale-worker",
    },
  ]);
});

function consumerInfo(
  overrides: Partial<
    Pick<
      ConsumerInfo,
      "push_bound" | "num_ack_pending" | "num_pending" | "num_waiting"
    >
  > & {
    name?: string;
    filterSubject?: string;
    maxAckPending?: number;
    deliverSubject?: string;
    numPending?: number;
  } = {},
): ConsumerInfo {
  const {
    name,
    filterSubject,
    maxAckPending,
    deliverSubject,
    numPending,
    ...infoOverrides
  } = overrides;
  return {
    stream_name: "BEAM_WORKFLOW_TASKS",
    name: name ?? "beam-workers_interchangeable",
    created: "2026-07-30T00:00:00.000Z",
    config: {
      durable_name: name ?? "beam-workers_interchangeable",
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.Explicit,
      ack_wait: 900_000_000_000,
      max_deliver: 5,
      max_ack_pending: maxAckPending,
      filter_subject: filterSubject ?? "beam.workflow.tasks.*",
      replay_policy: ReplayPolicy.Instant,
      ...(deliverSubject ? { deliver_subject: deliverSubject } : {}),
    },
    delivered: {
      consumer_seq: 0,
      stream_seq: 0,
      last_active: 0,
    },
    ack_floor: {
      consumer_seq: 0,
      stream_seq: 0,
      last_active: 0,
    },
    num_ack_pending: 0,
    num_redelivered: 0,
    num_waiting: 0,
    num_pending: numPending ?? 0,
    push_bound: false,
    pause_remaining: 0,
    ...infoOverrides,
  };
}

function asyncItems<T>(pages: T[][]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) {
        yield* page;
      }
    },
  };
}
