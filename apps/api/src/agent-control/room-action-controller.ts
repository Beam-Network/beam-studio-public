import { isDeepStrictEqual } from "node:util";
import {
  pgOne,
  withPostgresTransaction,
  type PgClient,
  type PgPool,
} from "@beam-studio/db";
import {
  assertRoomActionReply,
  roomActionCommandSchema,
  roomActionContentType,
  roomActionReplySchema,
  type RoomActionCommand,
} from "@beam-studio/shared";
import { AgentControlRepository } from "./repository.js";
import {
  requireWebAgentControllerBinding,
  type WebAgentControllerBinding,
} from "./web-agent-controller-config.js";
import { WebAgentControllerSession } from "./web-agent-controller-session.js";

type Row = Record<string, any>;
type RoomActionDelivery = {
  roomId: string;
  channelId: string;
  publisherMemberId: string;
  publicationId: string;
  contentType: string;
  payload: Buffer;
};
const maxPrivateActionBytes = 160 * 1024;
const reconciliationWindowMs = 24 * 60 * 60 * 1000;
const lostReplyGraceMs = 30_000;
const firstProbeRetryMs = 60_000;

/** Durable server-side owner for protected room action control. A browser has
 * no handle to these sessions or instance administration credentials. */
export class RoomActionController {
  private readonly sessions = new Map<string, WebAgentControllerSession>();
  private readonly startedAt = Date.now();
  private busy = false;

  constructor(
    private readonly pool: PgPool,
    private readonly repository: AgentControlRepository,
    private readonly bindings: readonly WebAgentControllerBinding[],
    private readonly logger: { warn(value: unknown, message: string): void },
  ) {}

  configured(organizationId: string, roomId: string, recipientMemberId: string) {
    return requireWebAgentControllerBinding(
      this.bindings, organizationId, roomId, recipientMemberId,
    );
  }

  async protectsAssignment(assignmentId: string) {
    const row = await pgOne<{ command_id: string }>(
      this.pool,
      "SELECT command_id FROM execution.room_action_deliveries WHERE assignment_id=$1 LIMIT 1",
      [assignmentId],
    );
    return Boolean(row);
  }

  /** A blocked or aged protected assignment needs operator review, not more
   * automatic cancellation/reconciliation traffic. */
  async recoveryWindowOpen(assignmentId: string): Promise<boolean | null> {
    const original = await pgOne<Row>(
      this.pool,
      `SELECT d.deadline_at,d.state FROM execution.room_action_deliveries d
       JOIN agent_control.commands c ON c.id=d.command_id
       WHERE d.assignment_id=$1 AND c.operation='action.invoke'
       ORDER BY d.created_at LIMIT 1`,
      [assignmentId],
    );
    if (!original) return null;
    return original.state !== "blocked" &&
      Date.parse(original.deadline_at) + reconciliationWindowMs > Date.now();
  }

  /** A renewal/cancel/reconcile uses the original frozen controller/channel. */
  async recordAssignmentControl(
    client: PgClient,
    commandId: string,
    assignmentId: string,
    deadline: string,
  ) {
    const original = await pgOne<Row>(
      client,
      `SELECT d.*,c.organization_id FROM execution.room_action_deliveries d
       JOIN agent_control.commands c ON c.id=d.command_id
       WHERE d.assignment_id=$1 ORDER BY d.created_at LIMIT 1`,
      [assignmentId],
    );
    if (!original) throw new Error("Protected assignment has no controller binding.");
    await this.record(client, {
      commandId,
      assignmentId,
      organizationId: original.organization_id,
      roomId: original.room_id,
      recipientMemberId: original.recipient_member_id,
      requestReplyChannelId: original.request_reply_channel_id,
      authorityGeneration: Number(original.authority_generation),
      deadline,
    });
  }

  /** Called in the assignment transaction immediately after createCommand. */
  async record(
    client: PgClient,
    input: {
      commandId: string;
      assignmentId: string;
      organizationId: string;
      roomId: string;
      recipientMemberId: string;
      requestReplyChannelId: string;
      authorityGeneration: number;
      deadline: string;
    },
  ) {
    const { binding, controlChannelId } = this.configured(
      input.organizationId, input.roomId, input.recipientMemberId,
    );
    const result = await client.query(
      `INSERT INTO execution.room_action_deliveries
       (command_id,assignment_id,controller_agent_id,controller_member_id,
        recipient_member_id,room_id,control_channel_id,request_reply_channel_id,
        authority_generation,deadline_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz
       FROM agent_control.commands c
       WHERE c.id=$1 AND c.transport='room-mls/v1'
       ON CONFLICT (command_id) DO NOTHING`,
      [
        input.commandId, input.assignmentId, binding.agentId, binding.memberId,
        input.recipientMemberId, input.roomId, controlChannelId,
        input.requestReplyChannelId, input.authorityGeneration, input.deadline,
      ],
    );
    if (!result.rowCount) {
      const existing = await pgOne<Row>(
        client,
        "SELECT * FROM execution.room_action_deliveries WHERE command_id=$1",
        [input.commandId],
      );
      if (
        !existing || existing.assignment_id !== input.assignmentId ||
        existing.controller_agent_id !== binding.agentId ||
        existing.controller_member_id !== binding.memberId ||
        existing.recipient_member_id !== input.recipientMemberId ||
        existing.room_id !== input.roomId ||
        existing.control_channel_id !== controlChannelId ||
        existing.request_reply_channel_id !== input.requestReplyChannelId ||
        Number(existing.authority_generation) !== input.authorityGeneration ||
        Date.parse(existing.deadline_at) !== Date.parse(input.deadline)
      ) throw new Error("Protected room command identity changed.");
    }
  }

  /** Runs from the API service timer, independently of Studio tabs. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const pending = await this.pool.query<Row>(
        `SELECT d.*,c.operation,c.payload_json,c.result_json,c.error_json,
                c.state AS command_state,
                c.organization_id,a.workflow_run_id,a.workflow_step_run_id,
                a.task_id,a.attempt,a.executor_id,a.session_generation,
                a.state AS assignment_state,a.cleanup_confirmed_at,
                origin.deadline_at AS invoke_deadline_at,
                authority.generation AS current_authority_generation,
                authority.lease_expires_at AS authority_lease_expires_at
         FROM execution.room_action_deliveries d
         JOIN agent_control.commands c ON c.id=d.command_id
         JOIN execution.executor_assignments a ON a.id=d.assignment_id
         JOIN execution.workflow_run_authority authority
           ON authority.workflow_run_id=a.workflow_run_id
         LEFT JOIN LATERAL (
           SELECT initial_delivery.deadline_at
           FROM execution.room_action_deliveries initial_delivery
           JOIN agent_control.commands initial_command
             ON initial_command.id=initial_delivery.command_id
           WHERE initial_delivery.assignment_id=d.assignment_id
             AND initial_command.operation='action.invoke'
           ORDER BY initial_delivery.created_at LIMIT 1
         ) origin ON true
         WHERE d.state NOT IN ('terminal','blocked')
         ORDER BY CASE d.state
           WHEN 'reconciliation_required' THEN 0
           WHEN 'queued' THEN 1
           WHEN 'publishing' THEN 2
           ELSE 3 END,
           (c.operation='action.reconcile' AND c.payload_json ? 'originalCommandId'),
           d.updated_at LIMIT 100`,
      );
      for (const row of pending.rows) {
        try {
          await this.advance(row);
        } catch (error) {
          this.logger.warn({
            commandId: row.command_id,
            code: (error as { code?: string }).code ?? "room_action_control_unavailable",
          }, "Protected room command requires reconciliation");
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async close() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  wake() {
    void this.tick().catch((error: unknown) =>
      this.logger.warn({ code: (error as { code?: string }).code ?? "room_action_tick_failed" },
        "Protected room control tick failed"),
    );
  }

  private async advance(row: Row) {
    const cleanup = cleanupOperation(row.operation);
    if (row.operation === "action.reconcile" &&
        typeof row.payload_json?.originalCommandId === "string" &&
        ["completed", "failed", "cancelled"].includes(row.assignment_state) &&
        row.cleanup_confirmed_at) {
      await this.pool.query(
        `UPDATE execution.room_action_deliveries SET state='terminal',
           last_error_code='room_action_reconciled',updated_at=now()
         WHERE command_id=$1 AND state NOT IN ('terminal','blocked')`,
        [row.command_id],
      );
      return;
    }
    if (row.state === "queued" && row.command_state === "expired") {
      // A row expired by an older Agent poller cannot be published or apply
      // its reply. Reconcile it through the member journal instead.
      await this.pool.query(
        `UPDATE execution.room_action_deliveries
         SET state='reconciliation_required',
             last_error_code='room_action_command_expired',updated_at=now()
         WHERE command_id=$1 AND state='queued'`,
        [row.command_id],
      );
      return;
    }
    if (row.state === "published" || row.state === "accepted") {
      if (["completed", "failed", "cancelled"].includes(row.assignment_state) &&
          row.cleanup_confirmed_at) {
        await this.pool.query(
          `UPDATE execution.room_action_deliveries SET state='terminal',
             last_error_code='room_action_settled_by_assignment',updated_at=now()
           WHERE command_id=$1 AND state IN ('published','accepted')`,
          [row.command_id],
        );
        return;
      }
      if (
        Date.parse(row.updated_at) < this.startedAt ||
        Math.max(Date.parse(row.deadline_at), Date.parse(row.updated_at)) +
          lostReplyGraceMs <= Date.now()
      ) {
        await this.pool.query(
          `UPDATE execution.room_action_deliveries SET state='reconciliation_required',
             last_error_code='room_action_reply_missing',updated_at=now()
           WHERE command_id=$1 AND state IN ('published','accepted')`,
          [row.command_id],
        );
        return;
      }
    }
    // Once publication is uncertain, an old-generation invoke may only be
    // resolved through a cleanup probe. Do that before fencing new work.
    if (row.state === "reconciliation_required") {
      await this.queueReconciliation(row);
      return;
    }
    if (
      !cleanup &&
      (Number(row.authority_generation) !==
        Number(row.current_authority_generation) ||
        Date.parse(row.authority_lease_expires_at) <= Date.now())
    ) {
      await this.pool.query(
        `UPDATE execution.room_action_deliveries
         SET state='reconciliation_required',last_error_code='room_action_fenced',updated_at=now()
         WHERE command_id=$1 AND state<>'terminal'`,
        [row.command_id],
      );
      return;
    }
    if (
      (row.state === "queued" || row.state === "publishing") &&
      Date.parse(row.deadline_at) <= Date.now()
    ) {
      await this.pool.query(
        `UPDATE execution.room_action_deliveries
         SET state='reconciliation_required',last_error_code='room_action_deadline_expired',updated_at=now()
         WHERE command_id=$1 AND state<>'terminal'`,
        [row.command_id],
      );
      return;
    }
    const { binding, controlChannelId } = this.configured(
      row.organization_id, row.room_id, row.recipient_member_id,
    );
    if (
      binding.agentId !== row.controller_agent_id ||
      binding.memberId !== row.controller_member_id ||
      controlChannelId !== row.control_channel_id
    ) throw new Error("Stored Web Agent identity differs from current binding.");
    const session = this.session(binding);
    await session.subscribe(row.control_channel_id, row.recipient_member_id);
    if (row.state === "published" || row.state === "accepted") return;
    if (row.state === "publishing") {
      await this.pool.query(
        `UPDATE execution.room_action_deliveries SET state='reconciliation_required',
           last_error_code='room_action_publication_uncertain',updated_at=now()
         WHERE command_id=$1 AND state='publishing'`,
        [row.command_id],
      );
      return;
    }
    // An uncertain command is never republished. The member-side journal must
    // first answer a separately identified reconciliation request.
    if (row.state !== "queued") return;
    const command = commandFromRow(row);
    const payload = Buffer.from(JSON.stringify(command));
    if (payload.byteLength > maxPrivateActionBytes)
      throw new Error("Protected room action exceeds the Web Agent message limit.");
    try {
      const result = await session.publishPrivate({
        channelId: row.control_channel_id,
        recipientMemberId: row.recipient_member_id,
        payload,
        idempotencyKey: row.command_id,
        // publishPrivate may have to restore its subscription after the first
        // check above. Claim only after that wait, using the current durable
        // deadline, authority and assignment admission state instead of the
        // earlier tick snapshot. Cleanup remains possible after cancellation.
        beforeSend: async () => {
          const claimed = await this.pool.query(
            `UPDATE execution.room_action_deliveries d
             SET state='publishing',updated_at=now()
             FROM agent_control.commands c,
                  execution.executor_assignments a,
                  execution.workflow_run_authority authority,
                  execution.workflow_runs run,
                  execution.workflow_tasks task,
                  agent_control.agents agent
             WHERE d.command_id=$1 AND d.state='queued'
               AND c.id=d.command_id AND c.transport='room-mls/v1'
               AND c.state='queued' AND a.id=d.assignment_id
               AND authority.workflow_run_id=a.workflow_run_id
               AND run.id=a.workflow_run_id AND task.id=a.task_id
               AND agent.id=a.executor_id
               AND d.deadline_at>now()
               AND ($2::boolean OR (
                 authority.generation=d.authority_generation
                 AND authority.lease_expires_at>now()
                 AND a.state IN ('assigned','dispatching','running')
                 AND a.cancel_requested_at IS NULL
                 AND a.lease_expires_at>now()
                 AND run.status IN ('queued','running')
                 AND task.status='running' AND task.attempt_count=a.attempt
                 AND task.leased_by=a.executor_id
                 AND agent.revoked_at IS NULL
                 AND agent.session_generation=a.session_generation
               ))
             RETURNING d.command_id`,
            [row.command_id, cleanup],
          );
          return Boolean(claimed.rowCount);
        },
      });
      if (!result) return;
      const publicationId = result.publicationId ?? result.publication_id;
      if (typeof publicationId !== "string" || !publicationId)
        throw new Error("Protected room publication identity is missing.");
      await this.pool.query(
        `UPDATE execution.room_action_deliveries
           SET state='published',publication_id=$2,updated_at=now()
         WHERE command_id=$1 AND state='publishing'`,
        [row.command_id, publicationId],
      );
      await this.pool.query(
        `UPDATE agent_control.commands SET state='dispatched',dispatched_at=COALESCE(dispatched_at,now()),updated_at=now()
         WHERE id=$1 AND state='queued' AND transport='room-mls/v1'`,
        [row.command_id],
      );
    } catch (error) {
      await this.pool.query(
        `UPDATE execution.room_action_deliveries
           SET state='reconciliation_required',
               last_error_code='room_action_publication_uncertain',updated_at=now()
         WHERE command_id=$1 AND state='publishing'`,
        [row.command_id],
      );
      throw error;
    }
  }

  private async queueReconciliation(row: Row) {
    if (["completed", "failed", "cancelled"].includes(row.assignment_state) &&
        row.cleanup_confirmed_at) {
      await this.pool.query(
        `UPDATE execution.room_action_deliveries SET state='terminal',
           last_error_code='room_action_reconciled',updated_at=now()
         WHERE command_id=$1 AND state='reconciliation_required'`,
        [row.command_id],
      );
      return;
    }
    const horizonOrigin = row.operation === "action.artifact.release"
      ? row.deadline_at
      : row.invoke_deadline_at ?? row.deadline_at;
    if (Date.parse(horizonOrigin) + reconciliationWindowMs <= Date.now()) {
      await this.blockReconciliation(row.command_id, "room_action_reconciliation_deadline");
      return;
    }
    // A child probe is never probed recursively. Its parent retains the
    // original command identity and schedules the next distinct probe.
    if (row.operation === "action.reconcile" &&
        typeof row.payload_json?.originalCommandId === "string") return;
    let previousOutcome: Row | undefined;
    if (row.reconciliation_command_id) {
      previousOutcome = await pgOne<Row>(
        this.pool,
        `SELECT c.state,c.expires_at,c.updated_at,a.state AS assignment_state,
                a.cleanup_confirmed_at
         FROM agent_control.commands c
         JOIN execution.executor_assignments a ON a.id=$2
        WHERE c.id=$1`,
        [row.reconciliation_command_id, row.assignment_id],
      );
      if (!previousOutcome) {
        await this.blockReconciliation(row.command_id, "room_action_reconciliation_missing");
        return;
      }
      if (["completed", "failed", "cancelled"].includes(previousOutcome.assignment_state) &&
          previousOutcome.cleanup_confirmed_at) {
        await this.pool.query(
          `UPDATE execution.room_action_deliveries SET state='terminal',
             last_error_code='room_action_reconciled',updated_at=now()
           WHERE command_id=$1 AND state='reconciliation_required'`,
          [row.command_id],
        );
        return;
      }
      if (!probeRetryDue(previousOutcome, Number(row.reconciliation_attempts), Date.now()))
        return;
    }
    const deadline = new Date(Date.now() + 60_000).toISOString();
    await withPostgresTransaction(this.pool, async (client) => {
      const current = await pgOne<Row>(
        client,
        `SELECT d.reconciliation_command_id,d.reconciliation_attempts,d.state,
                a.state AS assignment_state,a.cleanup_confirmed_at
         FROM execution.room_action_deliveries d
         JOIN execution.executor_assignments a ON a.id=d.assignment_id
         WHERE d.command_id=$1 FOR UPDATE OF d`,
        [row.command_id],
      );
      if (!current || current.state !== "reconciliation_required" ||
          current.reconciliation_command_id !== row.reconciliation_command_id) return;
      if (["completed", "failed", "cancelled"].includes(current.assignment_state) &&
          current.cleanup_confirmed_at) {
        await client.query(
          `UPDATE execution.room_action_deliveries SET state='terminal',
             last_error_code='room_action_reconciled',updated_at=now()
           WHERE command_id=$1 AND state='reconciliation_required'`,
          [row.command_id],
        );
        return;
      }
      if (current.reconciliation_command_id) {
        const latest = await pgOne<Row>(
          client,
          `SELECT state,expires_at,updated_at FROM agent_control.commands
           WHERE id=$1`,
          [current.reconciliation_command_id],
        );
        if (!latest || !probeRetryDue(
          latest, Number(current.reconciliation_attempts), Date.now(),
        )) return;
      }
      const previousId = current.reconciliation_command_id as string | null;
      const command = await this.repository.createCommand({
        organizationId: row.organization_id,
        agentId: row.executor_id,
        operation: "action.reconcile",
        transport: "room-mls/v1",
        idempotencyKey: `${row.assignment_id}:room-reconcile:${row.command_id}` +
          (previousId ? `:${previousId}` : ""),
        ttlSeconds: 60,
        payload: {
          assignmentId: row.assignment_id,
          attempt: Number(row.attempt),
          authorityGeneration: Number(row.authority_generation),
          originalCommandId: row.command_id,
        },
      }, client);
      await this.recordAssignmentControl(
        client, command.id, row.assignment_id, command.expiresAt ?? deadline,
      );
      if (previousId)
        await client.query(
          `UPDATE execution.room_action_deliveries SET state='blocked',
             last_error_code='room_action_probe_superseded',updated_at=now()
           WHERE command_id=$1 AND state NOT IN ('terminal','blocked')`,
          [previousId],
        );
      await client.query(
        `UPDATE execution.room_action_deliveries
         SET reconciliation_command_id=$2,
             reconciliation_attempts=LEAST(reconciliation_attempts+1,64),
             updated_at=now() WHERE command_id=$1 AND state='reconciliation_required'`,
        [row.command_id, command.id],
      );
    });
  }

  private async blockReconciliation(commandId: string, code: string) {
    await this.pool.query(
      `WITH parent AS (
         SELECT reconciliation_command_id FROM execution.room_action_deliveries
         WHERE command_id=$1
       )
       UPDATE execution.room_action_deliveries SET state='blocked',
         last_error_code=$2,updated_at=now()
       WHERE (command_id=$1 AND state='reconciliation_required')
          OR (command_id=(SELECT reconciliation_command_id FROM parent)
              AND state NOT IN ('terminal','blocked'))`,
      [commandId, code],
    );
  }

  private session(binding: WebAgentControllerBinding) {
    const key = `${binding.organizationId}\0${binding.roomId}\0${binding.agentId}\0${binding.memberId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = new WebAgentControllerSession(binding, async (delivery) => {
        try {
          await this.acceptReply(delivery);
        } catch (error) {
          this.logger.warn({
            publicationId: delivery.publicationId,
            code: (error as { code?: string }).code ?? "room_action_reply_rejected",
          }, "Rejected protected room action reply");
        }
      });
      this.sessions.set(key, session);
    }
    return session;
  }

  private async acceptReply(delivery: RoomActionDelivery) {
    if (delivery.contentType !== roomActionContentType ||
        delivery.payload.byteLength > maxPrivateActionBytes) return;
    const parsed = roomActionReplySchema.safeParse(
      JSON.parse(delivery.payload.toString("utf8")),
    );
    if (!parsed.success) return;
    const reply = parsed.data;
    await withPostgresTransaction(this.pool, async (client) => {
      const row = await pgOne<Row>(
        client,
        `SELECT d.*,c.operation,c.payload_json,c.result_json,c.error_json,
                c.state AS command_state,
                a.workflow_run_id,a.workflow_step_run_id,a.task_id,a.attempt,
                authority.generation AS current_authority_generation,
                authority.lease_expires_at AS authority_lease_expires_at
         FROM execution.room_action_deliveries d
         JOIN agent_control.commands c ON c.id=d.command_id
         JOIN execution.executor_assignments a ON a.id=d.assignment_id
         JOIN execution.workflow_run_authority authority
           ON authority.workflow_run_id=a.workflow_run_id
         WHERE d.command_id=$1 FOR UPDATE OF d,c`,
        [reply.commandId],
      );
      if (!row) return;
      if (!cleanupOperation(row.operation) &&
          Date.parse(row.authority_lease_expires_at) <= Date.now()) return;
      const command = commandFromRow(row);
      assertRoomActionReply(reply, command, {
        ...delivery,
        currentAuthorityGeneration: cleanupOperation(row.operation)
          ? Number(row.authority_generation)
          : Number(row.current_authority_generation),
      });
      if (["completed", "failed", "cancelled"].includes(row.command_state)) {
        if (row.command_state !== reply.state ||
            !isDeepStrictEqual(row.result_json ?? null, reply.result ?? null) ||
            !isDeepStrictEqual(row.error_json ?? null, reply.error ?? null))
          throw new Error("Conflicting terminal room action reply.");
        if (row.state !== "terminal")
          await client.query(
            `UPDATE execution.room_action_deliveries SET state='terminal',
               reply_id=COALESCE(reply_id,$2),
               reply_publication_id=COALESCE(reply_publication_id,$3),
               updated_at=now() WHERE command_id=$1`,
            [reply.commandId, reply.replyId, delivery.publicationId],
          );
        return;
      }
      if (row.command_state === "expired") {
        // Older deployments could expire protected commands through the
        // regular Agent poller. Keep their outcome uncertain until the member
        // journal is reconciled instead of treating an unapplied reply as final.
        await client.query(
          `UPDATE execution.room_action_deliveries
           SET state='reconciliation_required',
               last_error_code='room_action_command_expired',updated_at=now()
           WHERE command_id=$1 AND state IN
             ('queued','publishing','published','accepted')`,
          [reply.commandId],
        );
        return;
      }
      if (
        row.command_state === "running" && reply.state === "accepted"
      ) return;
      const terminal = ["completed", "failed", "cancelled"].includes(reply.state);
      await client.query(
        `UPDATE agent_control.commands
         SET state=$2,result_json=$3::jsonb,error_json=$4::jsonb,
             accepted_at=COALESCE(accepted_at,now()),
             started_at=CASE WHEN $2='running' THEN COALESCE(started_at,now()) ELSE started_at END,
             completed_at=CASE WHEN $5 THEN COALESCE(completed_at,now()) ELSE completed_at END,
             updated_at=now()
         WHERE id=$1 AND transport='room-mls/v1'
           AND state NOT IN ('completed','failed','cancelled','expired')`,
        [
          reply.commandId, reply.state,
          reply.result ? JSON.stringify(reply.result) : null,
          reply.error ? JSON.stringify(reply.error) : null,
          terminal,
        ],
      );
      await client.query(
        `UPDATE execution.room_action_deliveries
         SET state=$2,reply_id=$3,reply_publication_id=$4,updated_at=now()
         WHERE command_id=$1 AND state<>'terminal'`,
        [reply.commandId, terminal ? "terminal" : "accepted", reply.replyId,
          delivery.publicationId],
      );
    });
  }
}

function cleanupOperation(operation: string) {
  return operation === "action.cancel" || operation === "action.reconcile" ||
    operation === "action.artifact.release";
}

function probeRetryDue(outcome: Row, attempts: number, now: number) {
  const expiresAt = Date.parse(outcome.expires_at);
  const updatedAt = Date.parse(outcome.updated_at);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(updatedAt)) return false;
  const exponent = Math.min(6, Math.max(0, attempts - 1));
  const delay = firstProbeRetryMs * 2 ** exponent;
  return now >= Math.max(expiresAt, updatedAt + delay);
}

function commandFromRow(row: Row): RoomActionCommand {
  return roomActionCommandSchema.parse({
    version: "room-action/v1",
    kind: "command",
    commandId: row.command_id,
    operation: row.operation,
    controllerMemberId: row.controller_member_id,
    recipientMemberId: row.recipient_member_id,
    roomId: row.room_id,
    controlChannelId: row.control_channel_id,
    requestReplyChannelId: row.request_reply_channel_id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.workflow_step_run_id,
    taskId: row.task_id,
    assignmentId: row.assignment_id,
    attempt: Number(row.attempt),
    authorityGeneration: Number(row.authority_generation),
    deadline: new Date(row.deadline_at).toISOString(),
    payload: row.payload_json,
  });
}
