import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import { roomActionContentType } from "@beam-studio/shared";
import type { AgentControlRepository } from "./repository.js";
import { RoomActionController } from "./room-action-controller.js";

test("an uncertain invoke reconciles after authority advances without republishing", async () => {
  const updates: string[] = [];
  const pool = {
    async query(sql: string) {
      if (sql.includes("SELECT d.*,c.operation"))
        return { rows: [{
          command_id: "invoke_1",
          assignment_id: "assignment_1",
          operation: "action.invoke",
          state: "reconciliation_required",
          authority_generation: 4,
          current_authority_generation: 5,
          authority_lease_expires_at: new Date(Date.now() + 60_000),
          deadline_at: new Date(Date.now() - 60_000),
          reconciliation_command_id: "reconcile_1",
        }] };
      if (sql.includes("SELECT c.state,c.expires_at"))
        return { rows: [{
          state: "completed",
          assignment_state: "completed",
          cleanup_confirmed_at: new Date(),
        }] };
      updates.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PgPool;
  const controller = new RoomActionController(
    pool, {} as AgentControlRepository, [], { warn() {} },
  );
  await controller.tick();
  assert.equal(updates.length, 1);
  assert.match(updates[0]!, /state='terminal'/);
  assert.doesNotMatch(updates[0]!, /room_action_fenced/);
});

test("a published command from a previous controller process requests a journal probe", async () => {
  const updates: string[] = [];
  const pool = {
    async query(sql: string) {
      if (sql.includes("SELECT d.*,c.operation"))
        return { rows: [{
          command_id: "invoke_1", operation: "action.invoke", state: "published",
          assignment_state: "running", cleanup_confirmed_at: null,
          updated_at: new Date(Date.now() - 60_000),
          deadline_at: new Date(Date.now() + 60_000),
        }] };
      updates.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PgPool;
  const controller = new RoomActionController(
    pool, {} as AgentControlRepository, [], { warn() {} },
  );
  await controller.tick();
  assert.equal(updates.length, 1);
  assert.match(updates[0]!, /state='reconciliation_required'/);
  assert.match(updates[0]!, /room_action_reply_missing/);
});

test("a lost probe reply creates a new reconcile identity after backoff", async () => {
  const old = new Date(Date.now() - 120_000);
  const outcome = {
    state: "published", expires_at: old, updated_at: old,
    assignment_state: "running", cleanup_confirmed_at: null,
  };
  const writes: string[] = [];
  const client = {
    async query(sql: string) {
      if (sql.includes("SELECT d.reconciliation_command_id,d.reconciliation_attempts"))
        return { rows: [{
          reconciliation_command_id: "probe_1",
          reconciliation_attempts: 1,
          state: "reconciliation_required",
          assignment_state: "running",
        }] };
      if (sql.includes("SELECT state,expires_at,updated_at"))
        return { rows: [outcome] };
      if (sql.includes("SELECT d.*,c.organization_id"))
        return { rows: [{
          organization_id: "org", room_id: "room",
          recipient_member_id: "executor", request_reply_channel_id: "request",
          authority_generation: 4,
        }] };
      if (sql.startsWith("INSERT INTO execution.room_action_deliveries"))
        return { rows: [], rowCount: 1 };
      if (sql.startsWith("UPDATE execution.room_action_deliveries")) writes.push(sql);
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    async query(sql: string) {
      if (sql.includes("SELECT d.*,c.operation"))
        return { rows: [{
          command_id: "invoke_1", assignment_id: "assignment_1",
          operation: "action.invoke", state: "reconciliation_required",
          authority_generation: 4, current_authority_generation: 5,
          deadline_at: new Date(Date.now() - 60_000),
          reconciliation_command_id: "probe_1", reconciliation_attempts: 1,
          organization_id: "org", executor_id: "executor_agent", attempt: 2,
        }] };
      if (sql.includes("SELECT c.state,c.expires_at"))
        return { rows: [outcome] };
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect() { return client; },
  } as unknown as PgPool;
  let key = "";
  const repository = {
    async createCommand(input: { idempotencyKey: string }) {
      key = input.idempotencyKey;
      return { id: "probe_2", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
  } as AgentControlRepository;
  const controller = new RoomActionController(
    pool, repository, [{
      organizationId: "org", roomId: "room", agentId: "controller_agent",
      memberId: "controller", url: "wss://agent.example/v1/connect",
      origin: "https://studio.example", credential: "x".repeat(32),
      channels: new Map([["executor", "private"]]),
    }], { warn() {} },
  );
  await controller.tick();
  assert.equal(key, "assignment_1:room-reconcile:invoke_1:probe_1");
  assert.equal(writes.length, 2);
  assert.match(writes[0]!, /room_action_probe_superseded/);
  assert.match(writes[1]!, /reconciliation_attempts=LEAST/);
});

test("a probe waits for backoff and recovery stops at the 24-hour bound", async () => {
  let deadline = new Date(Date.now() - 60_000);
  const writes: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("SELECT d.*,c.operation"))
        return { rows: [{
          command_id: "invoke_1", assignment_id: "assignment_1",
          operation: "action.invoke", state: "reconciliation_required",
          deadline_at: deadline, reconciliation_command_id: "probe_1",
          reconciliation_attempts: 3, assignment_state: "running",
        }] };
      if (sql.includes("SELECT c.state,c.expires_at"))
        return { rows: [{
          state: "completed",
          expires_at: new Date(Date.now() - 60_000),
          updated_at: new Date(Date.now() - 60_000),
          assignment_state: "running",
        }] };
      writes.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
    async connect() { throw new Error("probe retried before backoff"); },
  } as unknown as PgPool;
  const controller = new RoomActionController(
    pool, {} as AgentControlRepository, [], { warn() {} },
  );
  await controller.tick();
  assert.equal(writes.length, 0);
  deadline = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await controller.tick();
  assert.equal(writes.length, 1);
  assert.match(writes[0]!.sql, /state='blocked'/);
  assert.equal(writes[0]!.values?.[1], "room_action_reconciliation_deadline");
});

test("a late duplicate cleanup reply from the original generation is idempotent", async () => {
  const deadline = new Date(Date.now() - 60_000).toISOString();
  const result = { assignmentId: "assignment_1", cleanupConfirmed: true };
  const row = {
    command_id: "reconcile_1", operation: "action.reconcile",
    controller_member_id: "controller", recipient_member_id: "executor",
    room_id: "room", control_channel_id: "private",
    request_reply_channel_id: "request",
    workflow_run_id: "run", workflow_step_run_id: "step_run",
    task_id: "task", assignment_id: "assignment_1", attempt: 1,
    authority_generation: 4, current_authority_generation: 5,
    deadline_at: deadline, payload_json: { assignmentId: "assignment_1" },
    command_state: "completed", result_json: result, error_json: null,
    state: "blocked",
  };
  const updates: string[] = [];
  const client = {
    async query(sql: string) {
      if (sql.includes("SELECT d.*,c.operation")) return { rows: [row] };
      if (sql.startsWith("UPDATE execution.room_action_deliveries")) {
        updates.push(sql);
        row.state = "terminal";
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as PgPool;
  const controller = new RoomActionController(
    pool, {} as AgentControlRepository, [], { warn() {} },
  );
  const reply = {
    version: "room-action/v1", kind: "reply", commandId: row.command_id,
    operation: row.operation, controllerMemberId: row.controller_member_id,
    recipientMemberId: row.recipient_member_id, roomId: row.room_id,
    controlChannelId: row.control_channel_id,
    requestReplyChannelId: row.request_reply_channel_id,
    workflowRunId: row.workflow_run_id, stepRunId: row.workflow_step_run_id,
    taskId: row.task_id, assignmentId: row.assignment_id,
    attempt: row.attempt, authorityGeneration: row.authority_generation,
    deadline, replyId: "late_reply", replyDeadline: new Date(Date.now() + 60_000).toISOString(),
    state: "completed", result,
  };
  const delivery = {
    roomId: "room", channelId: "private", publisherMemberId: "executor",
    publicationId: "publication_1", contentType: roomActionContentType,
    payload: Buffer.from(JSON.stringify(reply)),
  };
  const acceptReply = (controller as unknown as {
    acceptReply(input: typeof delivery): Promise<void>;
  }).acceptReply.bind(controller);
  await acceptReply(delivery);
  await acceptReply(delivery);
  assert.equal(updates.length, 1);
  assert.ok(updates.every((sql) => sql.includes("state='terminal'")));
});

test("protected cleanup stops at the invoke recovery horizon", async () => {
  let original = {
    deadline_at: new Date(Date.now() - 60_000), state: "reconciliation_required",
  };
  const updates: string[] = [];
  const pool = {
    async query(sql: string) {
      if (sql.includes("SELECT d.deadline_at,d.state"))
        return { rows: [original] };
      if (sql.includes("SELECT d.*,c.operation"))
        return { rows: [{
          command_id: "probe_1", assignment_id: "assignment_1",
          operation: "action.reconcile", payload_json: { originalCommandId: "invoke_1" },
          state: "reconciliation_required", assignment_state: "running",
          deadline_at: new Date(Date.now() + 60_000),
          invoke_deadline_at: original.deadline_at,
        }] };
      updates.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PgPool;
  const controller = new RoomActionController(
    pool, {} as AgentControlRepository, [], { warn() {} },
  );
  assert.equal(await controller.recoveryWindowOpen("assignment_1"), true);
  original = { ...original, deadline_at: new Date(Date.now() - 25 * 60 * 60 * 1000) };
  assert.equal(await controller.recoveryWindowOpen("assignment_1"), false);
  await controller.tick();
  assert.equal(updates.length, 1);
  assert.match(updates[0]!, /state='blocked'/);
});
