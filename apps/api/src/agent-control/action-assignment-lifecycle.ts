import {
  pgOne,
  createExecutorBackend,
  acknowledgeWorkflowArtifactReleasePg,
  WorkflowAuthorizationError,
  WorkflowAuthorityUnavailableError,
  type ExecutorBackend,
  withPostgresTransaction,
  type PgPool,
  type PgClient,
} from "@beam-studio/db";
import { assignmentOutcome } from "./action-outcome.js";
import { readCoreArtifactEvidence } from "./action-artifact-core-evidence.js";
import { readProviderArtifactEvidence } from "./action-artifact-provider-evidence.js";
import {
  actionArtifactPortsRequired,
  assertArtifactPortResult,
} from "@beam-studio/action-runtime";
import type { RoomMemberActionAssignments } from "./action-assignments.js";
import type { AgentControlRepository } from "./repository.js";
import type { AgentGateway } from "./gateway.js";
import type { RoomStorageTransferManager } from "./room-storage-transfer-manager.js";
import type { RoomActionController } from "./room-action-controller.js";

type Row = Record<string, any>;
const active = [
  "assigned",
  "dispatching",
  "running",
  "cancel_requested",
  "reconciliation_required",
];
const terminal = ["completed", "failed", "cancelled"];

export function trustedRoomAssignmentDeadline(
  step: Row,
  stepRun: Row,
  task: Row,
  assignment: Row,
): number | null {
  const manifest = step.manifestSnapshot;
  if (
    step.actionPackage !== "@beam/room-transfer" ||
    manifest?.apiVersion !== "workflow-actions/v1" ||
    manifest?.name !== "@beam/room-transfer" ||
    manifest?.execution?.isolation !== "trusted-node" ||
    !["builtin", "verified"].includes(manifest?.trustLevel) ||
    step.sourceRegistry !== "public-registry"
  )
    return null;
  const initial = new Date(assignment.created_at).getTime() + 300_000;
  const lease = stepRun.resource_execution_json?.trusted_idle_lease;
  const deadline = Date.parse(String(lease?.idleExpiresAt ?? ""));
  if (
    stepRun.resource_execution_json?.state === "active" &&
    lease?.taskId === task.id &&
    Number(lease?.attempt) === Number(task.attempt_count) &&
    lease?.publicationId === stepRun.state_json?.publicationId &&
    Number.isFinite(deadline)
  )
    return deadline;
  return initial;
}

function commandSessionMatches(command: Row, currentGeneration: unknown) {
  // Protected replies were authenticated on the pairwise MLS channel by the
  // controller; the unrelated direct-control socket may reconnect meanwhile.
  return (
    command.transport === "room-mls/v1" ||
    String(command.session_generation) === String(currentGeneration)
  );
}

export function artifactReleaseReceiptMatches(
  command: Row | undefined,
  obligation: Row,
) {
  return (
    command?.state === "completed" &&
    commandSessionMatches(command, obligation.current_generation) &&
    command.operation === "action.artifact.release" &&
    command.payload_json?.assignmentId === obligation.assignment_id &&
    Number(command.payload_json?.attempt) === Number(obligation.attempt) &&
    Number(command.payload_json?.authorityGeneration ?? 1) ===
      Number(obligation.authority_generation ?? 1) &&
    command.payload_json?.retentionObligationId === obligation.obligation_id &&
    command.result_json?.assignmentId === obligation.assignment_id &&
    command.result_json?.retentionObligationId === obligation.obligation_id &&
    command.result_json?.released === true
  );
}

export class RoomMemberAssignmentLifecycle {
  private backend: ExecutorBackend;
  constructor(
    private pool: PgPool,
    private assignments: RoomMemberActionAssignments,
    private readonly repository: AgentControlRepository,
    private gateway: AgentGateway,
    private cleanupResource?: (
      assignment: Row,
      capability: string,
    ) => Promise<void>,
    private storageTransfers?: RoomStorageTransferManager,
    private roomActionController?: RoomActionController,
  ) {
    this.backend = createExecutorBackend(pool, "room-member", {
      dispatch: async (taskId) => {
        await assignments.dispatch(taskId);
      },
    });
  }

  private async assignmentUsesProtectedTransport(
    assignmentId: string,
    client: PgPool | PgClient = this.pool,
  ) {
    const invocation = await pgOne<{
      transport: string;
      graph_version: string | null;
    }>(
      client,
      `SELECT command.transport,
              run.template_snapshot_json->>'graphVersion' AS graph_version
       FROM execution.executor_assignments assignment
       JOIN agent_control.commands command ON command.id=assignment.command_id
       JOIN execution.workflow_runs run ON run.id=assignment.workflow_run_id
       WHERE assignment.id=$1`,
      [assignmentId],
    );
    if (
      !invocation ||
      !["agent-control", "room-mls/v1"].includes(invocation.transport)
    )
      throw new Error("Assignment invocation transport is unavailable.");
    if (
      invocation.graph_version === "workflow-graph/v3" &&
      invocation.transport !== "room-mls/v1"
    )
      throw new Error(
        "Protected assignment has a direct invocation transport.",
      );
    return invocation.transport === "room-mls/v1";
  }

  private async createAssignmentCommand(
    assignmentId: string,
    input: Parameters<AgentControlRepository["createCommand"]>[0],
    transaction?: PgClient,
  ) {
    // The invocation's committed transport is authoritative. A missing MLS
    // delivery must never turn a protected follow-up into a direct command.
    const protectedAssignment = await this.assignmentUsesProtectedTransport(
      assignmentId,
      transaction,
    );
    if (!protectedAssignment)
      return this.repository.createCommand(input, transaction);
    const controller = this.roomActionController;
    if (!controller)
      throw new Error("Protected assignment has no room action controller.");
    const write = async (client: PgClient) => {
      const conflictingKey = input.idempotencyKey
        ? await pgOne<{ transport: string }>(
            client,
            `SELECT transport FROM agent_control.commands
             WHERE agent_id=$1 AND idempotency_key=$2`,
            [input.agentId, input.idempotencyKey],
          )
        : undefined;
      const command = await this.repository.createCommand(
        {
          ...input,
          transport: "room-mls/v1",
          idempotencyKey:
            conflictingKey?.transport === "agent-control"
              ? `room-mls/v1:${input.idempotencyKey}`
              : input.idempotencyKey,
        },
        client,
      );
      await controller.recordAssignmentControl(
        client,
        command.id,
        assignmentId,
        command.expiresAt!,
      );
      return command;
    };
    return transaction
      ? write(transaction)
      : withPostgresTransaction(this.pool, write);
  }

  private async wakeAssignment(assignmentId: string, agentId: string) {
    if (await this.assignmentUsesProtectedTransport(assignmentId)) {
      if (!this.roomActionController)
        throw new Error("Protected assignment has no room action controller.");
      this.roomActionController.wake();
    } else await this.gateway.dispatchAgent(agentId);
  }

  async tick() {
    const rows = await this.pool.query<Row>(
      `SELECT a.*,c.authorization_token,agent.session_generation AS current_generation,agent.revoked_at,
      authority.generation AS current_authority_generation
      FROM execution.executor_assignments a JOIN execution.executor_assignment_capabilities c ON c.assignment_id=a.id
      JOIN agent_control.agents agent ON agent.id=a.executor_id
      JOIN execution.workflow_run_authority authority ON authority.workflow_run_id=a.workflow_run_id
      WHERE a.backend='room-member' AND a.state=ANY($1::text[]) ORDER BY a.updated_at LIMIT 100`,
      [active],
    );
    // No assignment waits for another member's authorization or network delivery.
    const outcomes = await Promise.allSettled(
      rows.rows.map((row) => this.reconcile(row)),
    );
    for (let index = 0; index < outcomes.length; index++) {
      const outcome = outcomes[index]!;
      if (
        outcome.status === "rejected" &&
        !(outcome.reason instanceof WorkflowAuthorityUnavailableError)
      )
        await this.requestCancellation(rows.rows[index]!.id, {
          code: outcome.reason?.code ?? "executor_reconciliation_failed",
          message:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : "Executor reconciliation failed.",
        });
    }
    await this.reconcileArtifactReleases();
  }

  /** Release only after the frozen retention floor and the whole run settle. */
  private async reconcileArtifactReleases() {
    const obligations = await this.pool.query<Row>(
      `SELECT o.obligation_id,o.status AS obligation_status,m.assignment_id,m.attempt,a.executor_id,a.organization_id,a.authority_generation,
         invocation.transport AS invocation_transport,
         r.template_snapshot_json->>'graphVersion' AS graph_version,
         agent.revoked_at AS agent_revoked_at,agent.session_generation AS current_generation
       FROM execution.workflow_artifact_obligations o
       JOIN execution.workflow_artifact_manifests m ON m.id=o.manifest_id
       JOIN execution.executor_assignments a ON a.id=m.assignment_id
       JOIN agent_control.commands invocation ON invocation.id=a.command_id
       JOIN agent_control.agents agent ON agent.id=a.executor_id
       JOIN execution.workflow_runs r ON r.id=m.workflow_run_id
       WHERE o.required_until<=now() AND ((o.status='active')
         OR (o.status='releasing' AND o.cleanup_confirmed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM execution.workflow_artifact_obligations sibling
             WHERE sibling.manifest_id=m.id AND sibling.status='active')))
         AND r.status IN ('completed','failed','cancelled')
       ORDER BY o.required_until LIMIT 100`,
    );
    for (const obligation of obligations.rows) {
      if (
        obligation.graph_version === "workflow-graph/v3" &&
        obligation.invocation_transport !== "room-mls/v1"
      )
        throw new Error(
          "Protected assignment has a direct invocation transport.",
        );
      const previous = await pgOne<Row>(
        this.pool,
        `SELECT * FROM agent_control.commands WHERE agent_id=$1
         AND operation='action.artifact.release'
         AND payload_json->>'retentionObligationId'=$2
         AND transport=$3
         ORDER BY sequence DESC LIMIT 1`,
        [
          obligation.executor_id,
          obligation.obligation_id,
          obligation.invocation_transport,
        ],
      );
      if (
        artifactReleaseReceiptMatches(previous, obligation) &&
        (obligation.obligation_status === "active" ||
          previous?.result_json?.cleanupConfirmed === true)
      ) {
        await withPostgresTransaction(this.pool, (client) =>
          acknowledgeWorkflowArtifactReleasePg(client, {
            assignmentId: obligation.assignment_id,
            obligationId: obligation.obligation_id,
            cleanupConfirmed: previous?.result_json?.cleanupConfirmed === true,
          }),
        );
        continue;
      }
      if (obligation.agent_revoked_at) continue;
      if (
        previous &&
        (!["completed", "failed", "cancelled", "expired"].includes(
          previous.state,
        ) ||
          Date.now() - new Date(previous.updated_at).getTime() < 5_000)
      )
        continue;
      await this.createAssignmentCommand(obligation.assignment_id, {
        organizationId: obligation.organization_id,
        agentId: obligation.executor_id,
        operation: "action.artifact.release",
        idempotencyKey: `${obligation.assignment_id}:release:${obligation.obligation_id}:${previous?.id ?? "initial"}`,
        ttlSeconds: 60,
        payload: {
          assignmentId: obligation.assignment_id,
          attempt: obligation.attempt,
          authorityGeneration: Number(obligation.authority_generation),
          retentionObligationId: obligation.obligation_id,
        },
      });
      await this.wakeAssignment(
        obligation.assignment_id,
        obligation.executor_id,
      );
    }
  }

  async requestCancellation(
    assignmentId: string,
    error: Row = {
      code: "executor_cancelled",
      message: "Cancellation requested.",
    },
  ) {
    await this.backend.cancel(this.pool, assignmentId, {
      code: error.code,
      message: String(error.message ?? "Execution cancellation requested."),
      retryable: error.retryable,
    });
    const assignment = await pgOne<Row>(
      this.pool,
      "SELECT attempt FROM execution.executor_assignments WHERE id=$1",
      [assignmentId],
    );
    if (assignment && this.storageTransfers)
      await this.storageTransfers.cancelArtifactCopiesByAssignment(
        assignmentId,
        Number(assignment.attempt),
      );
  }

  async reconcile(assignment: Row) {
    const context = await this.assignments.context(assignment.task_id);
    if (
      assignment.executor_stopped_at &&
      context.step.actionPackage === "@beam/room-transfer" &&
      context.stepRun.resource_execution_json?.state === "active" &&
      this.cleanupResource
    ) {
      await this.cleanupResource(assignment, assignment.authorization_token);
    }

    const invocation = await pgOne<Row>(
      this.pool,
      `SELECT command.*,
              run.template_snapshot_json->>'graphVersion' AS graph_version
       FROM agent_control.commands command
       JOIN execution.executor_assignments current ON current.command_id=command.id
       JOIN execution.workflow_runs run ON run.id=current.workflow_run_id
       WHERE current.id=$1 AND command.id=$2`,
      [assignment.id, assignment.command_id],
    );
    if (
      !invocation ||
      !["agent-control", "room-mls/v1"].includes(invocation.transport)
    )
      throw new Error("Assignment invocation transport is unavailable.");
    if (
      invocation.graph_version === "workflow-graph/v3" &&
      invocation.transport !== "room-mls/v1"
    )
      throw new Error(
        "Protected assignment has a direct invocation transport.",
      );
    const cancelling =
      assignment.cancel_requested_at ||
      !["queued", "running"].includes(context.run.status) ||
      context.task.status === "cancelled";
    const configured = Number(
      context.step.timeoutSeconds ??
        context.step.manifestSnapshot?.execution?.defaultTimeoutSeconds ??
        300,
    );
    const roomDeadline = trustedRoomAssignmentDeadline(
      context.step,
      context.stepRun,
      context.task,
      assignment,
    );
    const timedOut =
      roomDeadline !== null
        ? Date.now() >= roomDeadline
        : Number.isFinite(configured) &&
          configured > 0 &&
          Date.now() - new Date(assignment.created_at).getTime() >=
            configured * 1000;
    const expired =
      new Date(assignment.lease_expires_at).getTime() <= Date.now();
    const replaced =
      String(assignment.session_generation) !==
        String(assignment.current_generation) ||
      assignment.revoked_at ||
      String(assignment.authority_generation) !==
        String(assignment.current_authority_generation);
    if (cancelling || expired || replaced || timedOut) {
      await this.requestCancellation(assignment.id, {
        code: timedOut
          ? "executor_timeout"
          : String(assignment.authority_generation) !==
              String(assignment.current_authority_generation)
            ? "executor_authority_superseded"
            : replaced
              ? "executor_session_fenced"
              : expired
                ? "executor_lease_expired"
                : "executor_cancelled",
        message: timedOut
          ? "Action execution timed out."
          : replaced
            ? "The executing control session was replaced or revoked."
            : expired
              ? "The execution lease expired."
              : "Workflow cancellation requested.",
      });
    } else {
      try {
        await this.assignments.authorizeAssignment(
          assignment.id,
          assignment.authorization_token,
        );
      } catch (error) {
        if (error instanceof WorkflowAuthorityUnavailableError) return;
        if (error instanceof WorkflowAuthorizationError) {
          await this.requestCancellation(assignment.id, {
            code: error.code,
            message: error.message,
            retryable: false,
          });
          return;
        }
        throw error;
      }
    }
    const current = (await this.backend.reconcile(this.pool, assignment.id))!;
    if (terminal.includes(current.state)) return;
    if (invocation) {
      const outcome = assignmentOutcome(invocation, current);
      if (
        outcome &&
        String(invocation.session_generation) ===
          String(current.session_generation)
      ) {
        if (!current.cancel_requested_at && !expired && !replaced)
          await this.assignments.authorizeAssignment(
            current.id,
            assignment.authorization_token,
          );
        if (await this.settle(current, invocation)) return;
      }
      if (invocation.state === "running" && current.state === "dispatching")
        await this.pool.query(
          "UPDATE execution.executor_assignments SET state='running',progress_json=$2::jsonb,updated_at=now() WHERE id=$1 AND state='dispatching'",
          [current.id, JSON.stringify(invocation.result_json ?? {})],
        );
      else if (invocation.state === "running")
        await this.pool.query(
          "UPDATE execution.executor_assignments SET progress_json=$2::jsonb WHERE id=$1",
          [current.id, JSON.stringify(invocation.result_json ?? {})],
        );
    }
    const controls = await this.pool.query<Row>(
      `SELECT DISTINCT ON(operation) * FROM agent_control.commands WHERE agent_id=$1 AND payload_json->>'assignmentId'=$2 AND transport=$3 AND operation IN ('action.cancel','action.reconcile','action.renew','action.publish') ORDER BY operation,sequence DESC`,
      [current.executor_id, current.id, invocation.transport],
    );
    for (const command of controls.rows) {
      if (command.operation === "action.renew") continue;
      if (!commandSessionMatches(command, assignment.current_generation))
        continue;
      const outcome = assignmentOutcome(command, current);
      if (outcome) {
        if (!current.cancel_requested_at && !expired && !replaced)
          await this.assignments.authorizeAssignment(
            current.id,
            assignment.authorization_token,
          );
        if (await this.settle(current, command)) return;
      }
    }
    // A late reply to an earlier protected probe can arrive after a newer
    // reconcile has been queued. Keep its confirmed cleanup visible even
    // though the latest command per operation is still pending.
    const latestReconcile = controls.rows.find(
      (row) => row.operation === "action.reconcile",
    );
    if (latestReconcile) {
      const prior = await this.pool.query<Row>(
        `SELECT * FROM agent_control.commands
         WHERE agent_id=$1 AND payload_json->>'assignmentId'=$2
           AND transport=$3 AND operation='action.reconcile' AND state='completed'
           AND sequence<$4 ORDER BY sequence DESC LIMIT 64`,
        [
          current.executor_id,
          current.id,
          invocation.transport,
          latestReconcile.sequence,
        ],
      );
      for (const command of prior.rows) {
        if (
          !commandSessionMatches(command, assignment.current_generation) ||
          !assignmentOutcome(command, current)
        )
          continue;
        if (!current.cancel_requested_at && !expired && !replaced)
          await this.assignments.authorizeAssignment(
            current.id,
            assignment.authorization_token,
          );
        if (await this.settle(current, command)) return;
      }
    }
    if (assignment.revoked_at) return; // Local lease expires independently; keep cleanup visibly unconfirmed.
    if (current.cancel_requested_at) {
      await this.control(
        current,
        "action.cancel",
        controls.rows.find((row) => row.operation === "action.cancel"),
      );
      await this.control(
        current,
        "action.reconcile",
        controls.rows.find((row) => row.operation === "action.reconcile"),
      );
      return;
    }
    const pendingArtifact = await pgOne<Row>(
      this.pool,
      `SELECT id FROM execution.workflow_artifact_manifests
       WHERE assignment_id=$1 AND status='pending'`,
      [current.id],
    );
    const publicationError = String(invocation?.error_json?.code ?? "");
    if (
      pendingArtifact ||
      [
        "action_artifact_transfer_failed",
        "action_artifact_status_unavailable",
      ].includes(publicationError)
    ) {
      const remaining =
        new Date(current.lease_expires_at).getTime() - Date.now();
      if (remaining < 30_000) {
        await this.renew(current, assignment.authorization_token);
        return;
      }
      await this.publish(
        current,
        invocation,
        controls.rows.find((row) => row.operation === "action.publish"),
        assignment.authorization_token,
      );
      return;
    }
    if (
      invocation &&
      ["failed", "cancelled", "expired"].includes(invocation.state)
    ) {
      await this.control(
        current,
        "action.reconcile",
        controls.rows.find((row) => row.operation === "action.reconcile"),
      );
      return;
    }
    const remaining = new Date(current.lease_expires_at).getTime() - Date.now();
    if (remaining < 30_000 && invocation?.state === "running") {
      const prior = controls.rows.find(
        (row) => row.operation === "action.renew",
      );
      if (prior && ["failed", "expired", "cancelled"].includes(prior.state)) {
        await this.requestCancellation(current.id, {
          code: "executor_renewal_failed",
          message: "The member did not confirm lease renewal.",
        });
        return;
      }
      if (prior && !terminal.includes(prior.state)) return;
      await this.renew(current, assignment.authorization_token);
    }
    await this.wakeAssignment(current.id, current.executor_id);
  }

  private async control(
    assignment: Row,
    operation: "action.cancel" | "action.reconcile",
    previous?: Row,
  ) {
    if (
      (await this.roomActionController?.recoveryWindowOpen(assignment.id)) ===
      false
    )
      return;
    if (
      previous &&
      (!["completed", "failed", "cancelled", "expired"].includes(
        previous.state,
      ) ||
        Date.now() - new Date(previous.updated_at).getTime() < 5000)
    ) {
      await this.wakeAssignment(assignment.id, assignment.executor_id);
      return;
    }
    const hybridTransferConfirmations =
      operation === "action.reconcile" &&
      previous?.state === "completed" &&
      previous.result_json?.assignmentId === assignment.id &&
      Number(previous.result_json?.attempt) === Number(assignment.attempt) &&
      Number(previous.payload_json?.authorityGeneration ?? 1) ===
        Number(assignment.authority_generation) &&
      this.storageTransfers
        ? await this.storageTransfers.hybridTransferConfirmationsForAssignment(
            {
              organizationId: assignment.organization_id,
              assignmentId: assignment.id,
              attempt: Number(assignment.attempt),
            },
            previous.result_json?.transfers,
          )
        : [];
    const command = await this.createAssignmentCommand(assignment.id, {
      organizationId: assignment.organization_id,
      agentId: assignment.executor_id,
      operation,
      idempotencyKey: `${assignment.id}:${operation}:${previous?.id ?? "initial"}`,
      ttlSeconds: 60,
      payload: {
        assignmentId: assignment.id,
        attempt: assignment.attempt,
        authorityGeneration: Number(assignment.authority_generation),
        ...(operation === "action.reconcile"
          ? { hybridTransferConfirmations }
          : {}),
      },
    });
    await this.wakeAssignment(assignment.id, assignment.executor_id);
    return command;
  }

  /** Retry retained publication bytes on the same assignment, without executing the action again. */
  private async publish(
    assignment: Row,
    invocation: Row | undefined,
    previous: Row | undefined,
    capability: string,
  ) {
    if (!invocation?.payload_json?.invocation) return;
    if (
      previous &&
      ((!terminal.includes(previous.state) && previous.state !== "expired") ||
        Date.now() - new Date(previous.updated_at).getTime() < 5_000)
    ) {
      await this.wakeAssignment(assignment.id, assignment.executor_id);
      return;
    }
    await this.assignments.authorizeAssignment(assignment.id, capability);
    const remainingSeconds = Math.floor(
      (new Date(assignment.lease_expires_at).getTime() - Date.now()) / 1_000,
    );
    if (remainingSeconds < 1) return;
    await this.createAssignmentCommand(assignment.id, {
      organizationId: assignment.organization_id,
      agentId: assignment.executor_id,
      operation: "action.publish",
      idempotencyKey: `${assignment.id}:publish:${previous?.id ?? "initial"}`,
      ttlSeconds: remainingSeconds,
      payload: {
        ...invocation.payload_json,
        authorityGeneration: Number(assignment.authority_generation),
        invocation: {
          ...invocation.payload_json.invocation,
          authorityGeneration: Number(assignment.authority_generation),
        },
        leaseExpiresAt: assignment.lease_expires_at,
        capability,
      },
    });
    await this.wakeAssignment(assignment.id, assignment.executor_id);
  }

  async renew(assignment: Row, capability: string) {
    const authorized = await this.assignments.authorizeAssignment(
      assignment.id,
      capability,
    );
    const maxSeconds = Math.min(
      60,
      Number(
        authorized.assignment.agent.action_execution_json?.maxLeaseSeconds ?? 0,
      ),
      Number(
        authorized.assignment.agent.policy_json?.action_execution
          ?.max_lease_seconds ?? 120,
      ),
    );
    if (maxSeconds < 5)
      throw new Error("Executor has no valid lease capability.");
    const next = new Date(Date.now() + maxSeconds * 1000).toISOString();
    await withPostgresTransaction(this.pool, async (client) => {
      const context = await this.assignments.context(
        assignment.task_id,
        client,
        true,
      );
      const current = await pgOne<Row>(
        client,
        `SELECT a.* FROM execution.executor_assignments a JOIN agent_control.agents agent ON agent.id=a.executor_id
        WHERE a.id=$1 AND a.state IN ('assigned','dispatching','running') AND a.lease_expires_at>now() AND a.lease_expires_at=$2 AND a.session_generation=agent.session_generation AND agent.revoked_at IS NULL FOR UPDATE OF a`,
        [assignment.id, assignment.lease_expires_at],
      );
      if (
        !current ||
        context.task.attempt_count !== current.attempt ||
        context.task.status !== "running" ||
        !["queued", "running"].includes(context.run.status)
      )
        return;
      // The invocation command shares the action lease; command expiry cannot truncate a renewed action.
      await client.query(
        "UPDATE agent_control.commands SET expires_at=$2 WHERE id=$1",
        [current.command_id, next],
      );
      await this.createAssignmentCommand(
        current.id,
        {
          organizationId: current.organization_id,
          agentId: current.executor_id,
          operation: "action.renew",
          idempotencyKey: `${current.id}:renew:${new Date(current.lease_expires_at).getTime()}`,
          ttlSeconds: Math.max(
            1,
            Math.floor(
              (new Date(current.lease_expires_at).getTime() - Date.now()) /
                1000,
            ),
          ),
          payload: {
            assignmentId: current.id,
            attempt: current.attempt,
            authorityGeneration: Number(current.authority_generation),
            leaseExpiresAt: next,
          },
        },
        client,
      );
      if (
        !(await this.backend.renewLease(
          client,
          {
            taskId: current.task_id,
            attempt: current.attempt,
            claimToken: context.task.claim_token,
          },
          next,
        ))
      )
        throw new Error("Executor lease expired before renewal committed.");
    });
    await this.wakeAssignment(assignment.id, assignment.executor_id);
  }

  async settle(assignment: Row, command: Row) {
    const outcome = assignmentOutcome(command, assignment);
    if (!outcome) return false;
    let transferAlreadyPublished = false;
    if (assignment.cancel_requested_at && this.storageTransfers)
      transferAlreadyPublished = (
        await this.storageTransfers.waitForArtifactCopiesCancellation(
          assignment.id,
          Number(assignment.attempt),
        )
      ).completedDelivery;
    const unlocked = await this.assignments.context(assignment.task_id);
    const coreArtifactEvidence =
      outcome.state === "completed" &&
      outcome.result?.artifactManifest &&
      unlocked.step.executionRoom
        ? await readCoreArtifactEvidence(
            outcome.result as import("@beam-studio/core").ActionResult,
            String(unlocked.run.organization_id),
            unlocked.step.executionRoom,
          ).catch(() => [])
        : [];
    const providerArtifactEvidence =
      outcome.state === "completed" &&
      outcome.result?.artifactManifest &&
      unlocked.step.executionRoom
        ? await readProviderArtifactEvidence(
            this.pool,
            outcome.result as import("@beam-studio/core").ActionResult,
            unlocked.task.metadata_json?.artifactPublications,
            String(unlocked.run.organization_id),
            unlocked.step.executionRoom,
          ).catch(() => [])
        : [];
    return withPostgresTransaction(this.pool, async (client) => {
      const context = await this.assignments.context(
        assignment.task_id,
        client,
        true,
      );
      const current = await pgOne<Row>(
        client,
        `SELECT a.*,agent.session_generation AS current_generation FROM execution.executor_assignments a JOIN agent_control.agents agent ON agent.id=a.executor_id WHERE a.id=$1 FOR UPDATE OF a`,
        [assignment.id],
      );
      if (!current || terminal.includes(current.state)) return true;
      if (
        context.task.attempt_count !== current.attempt ||
        context.task.leased_by !== current.executor_id
      )
        return false;
      if (
        ["action.invoke", "action.publish"].includes(command.operation) &&
        String(command.session_generation) !==
          String(current.session_generation)
      )
        return false;
      if (
        !["action.invoke", "action.publish"].includes(command.operation) &&
        !commandSessionMatches(command, current.current_generation)
      )
        return false;
      const sessionValid =
        command.transport === "room-mls/v1" ||
        String(current.session_generation) ===
          String(current.current_generation);
      let artifactError: Error | null = null;
      if (
        outcome.state === "completed" &&
        actionArtifactPortsRequired(context.step.manifestSnapshot)
      ) {
        try {
          assertArtifactPortResult(
            context.step.manifestSnapshot,
            outcome.result! as import("@beam-studio/core").ActionResult,
            {
              workflowRunId: context.run.id,
              stepRunId: context.stepRun.id,
              attempt: Number(current.attempt),
              taskId: context.task.id,
              assignmentId: current.id,
            },
            undefined,
            this.assignments.artifactInputBudget(
              context.step.manifestSnapshot,
              context.task,
            ),
          );
        } catch (error) {
          artifactError =
            error instanceof Error
              ? error
              : new Error("Invalid artifact output.");
        }
      }
      const status = await this.backend.settle(
        client,
        {
          taskId: context.task.id,
          attempt: current.attempt,
          claimToken: context.task.claim_token,
        },
        {
          status:
            (artifactError || !sessionValid || transferAlreadyPublished) &&
            outcome.state === "completed"
              ? "failed"
              : (outcome.state as "completed" | "failed" | "cancelled"),
          result: artifactError
            ? undefined
            : (outcome.result as
                | import("@beam-studio/core").ActionResult
                | undefined),
          error: transferAlreadyPublished
            ? {
                code: "executor_artifact_transfer_already_published",
                message:
                  "A superseded artifact transfer completed and cannot be safely replayed.",
                retryable: false,
              }
            : artifactError
              ? {
                  code: "executor_artifact_output_invalid",
                  message: artifactError.message,
                  retryable: false,
                }
              : !sessionValid
                ? {
                    code: "executor_session_fenced",
                    message: "Result came from a replaced agent session.",
                    retryable: false,
                  }
                : (outcome.error ?? undefined),
          executorStopped: true,
          coreArtifactEvidence,
          providerArtifactEvidence,
        },
      );
      return status !== "deferred" && status !== "stale";
    });
  }
}
