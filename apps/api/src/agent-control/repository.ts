import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import type { PgClient, PgPool } from "@beam-studio/db";
import {
  agentControlCommandStates,
  agentControlOperations,
  type AgentCommandEventPayload,
  type AgentControlCommandState,
  type AgentControlOperation,
  type AgentHelloPayload,
} from "@beam-studio/shared";

type Row = Record<string, unknown>;

const enrollmentTtlMs = 10 * 60_000;
const accessTokenTtlSeconds = 5 * 60;
const proofClockSkewMs = 5 * 60_000;
const staleSessionAfterMs = 45_000;

export class AgentControlError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export class AgentControlRepository {
  constructor(
    private readonly pool: PgPool,
    /** Active first; the rest are retired keys still accepted on verify. */
    private readonly tokenSecrets: readonly string[],
    private readonly now: () => Date = () => new Date(),
    /**
     * Whether this deployment still serves an organization.
     *
     * An enrolled agent holds a long-lived credential and refreshes its access
     * token from it, so without this an agent belonging to an organization the
     * owner removed would keep connecting indefinitely. Checking at token
     * issuance means the agent drops off at its next refresh rather than
     * needing its rows deleted.
     */
    private readonly isOrganizationAdmitted?: (
      organizationId: string,
    ) => Promise<boolean>,
  ) {}

  async linkRoomWorkflowRuns(
    organizationId: string,
    environmentTemplateKey: string,
    transfers: Record<string, unknown>[],
  ) {
    if (!transfers.length) return { transfers };
    const ids = transfers.map((value) => String(value.transfer_id));
    const rows = await this.pool.query<Row>(
      `SELECT s.workflow_run_id, s.state_json->>'beamTransferId' AS transfer_id
      FROM execution.workflow_step_runs s JOIN execution.workflow_runs r ON r.id=s.workflow_run_id
      WHERE r.organization_id=$1 AND s.state_json->>'environmentTemplateKey'=$2 AND s.state_json->>'beamTransferId'=ANY($3::text[])
      ORDER BY r.created_at DESC`,
      [organizationId, environmentTemplateKey, ids],
    );
    return {
      transfers: transfers.map((value) => ({
        ...value,
        workflowRunId:
          rows.rows.find((row) => row.transfer_id === value.transfer_id)
            ?.workflow_run_id ?? null,
      })),
    };
  }

  async createEnrollment(input: {
    organizationId: string;
    projectId?: string | null;
    machineName: string;
    createdById?: string | null;
  }) {
    const organizationId = required(input.organizationId, "organizationId");
    const machineName = required(input.machineName, "machineName").slice(
      0,
      160,
    );
    const enrollmentId = id("agenr");
    const code = enrollmentCode();
    const expiresAt = new Date(this.now().getTime() + enrollmentTtlMs);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ensureOrganization(client, organizationId);
      await client.query(
        `
        INSERT INTO agent_control.enrollments (
          id, organization_id, project_id, machine_name, code_hash,
          status, expires_at, created_by_id
        )
        VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
        `,
        [
          enrollmentId,
          organizationId,
          input.projectId ?? null,
          machineName,
          digest(code),
          expiresAt.toISOString(),
          input.createdById ?? null,
        ],
      );
      await appendAudit(client, {
        organizationId,
        enrollmentId,
        actorId: input.createdById,
        action: "agent.enrollment.created",
        status: "accepted",
        details: { machineName, expiresAt: expiresAt.toISOString() },
      });
      await client.query("COMMIT");
      return { enrollmentId, code, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getEnrollment(organizationId: string, enrollmentId: string) {
    const result = await this.pool.query<Row>(
      `
      SELECT e.id, e.machine_name, e.status, e.expires_at, e.consumed_at,
             e.consumed_by_agent_id, a.status AS agent_status
      FROM agent_control.enrollments e
      LEFT JOIN agent_control.agents a ON a.id = e.consumed_by_agent_id
      WHERE e.id = $1 AND e.organization_id = $2
      `,
      [
        required(enrollmentId, "enrollmentId"),
        required(organizationId, "organizationId"),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw notFound("enrollment_not_found", "Enrollment was not found.");
    }
    return {
      enrollmentId: String(row.id),
      machineName: String(row.machine_name),
      status: String(row.status),
      expiresAt: nullableDate(row.expires_at),
      consumedAt: nullableDate(row.consumed_at),
      agentId: nullableString(row.consumed_by_agent_id),
      agentStatus: nullableString(row.agent_status),
    };
  }

  async consumeEnrollment(input: {
    code: string;
    publicKey: string;
    machineName?: string;
    agentId?: string;
  }) {
    const code = required(input.code, "code");
    validateEd25519PublicKey(input.publicKey);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const enrollmentResult = await client.query<Row>(
        `
        SELECT *
        FROM agent_control.enrollments
        WHERE code_hash = $1
        FOR UPDATE
        `,
        [digest(code)],
      );
      const enrollment = enrollmentResult.rows[0];
      if (!enrollment || enrollment.status !== "pending") {
        throw new AgentControlError(
          "Enrollment code is invalid or already consumed.",
          "enrollment_invalid",
          404,
        );
      }
      if (Date.parse(String(enrollment.expires_at)) <= this.now().getTime()) {
        await client.query(
          "UPDATE agent_control.enrollments SET status = 'expired', updated_at = now() WHERE id = $1",
          [enrollment.id],
        );
        throw new AgentControlError(
          "Enrollment code has expired.",
          "enrollment_expired",
          410,
        );
      }

      const organizationId = String(enrollment.organization_id);
      if (
        this.isOrganizationAdmitted &&
        !(await this.isOrganizationAdmitted(organizationId))
      ) {
        // Same refusal as token issuance. The code stays pending (the
        // transaction rolls back), so it works once the owner admits the
        // organization, without generating a new one.
        throw organizationNotServed();
      }
      const machineId = id("mach");
      const agentId = canonicalAgentId(input.agentId) ?? id("agt");
      const credentialId = id("agc");
      const credentialSecret = randomBytes(32).toString("base64url");
      const machineName = (
        input.machineName?.trim() || String(enrollment.machine_name)
      ).slice(0, 160);
      await client.query(
        `
        INSERT INTO agent_control.machines (
          id, organization_id, project_id, name
        ) VALUES ($1, $2, $3, $4)
        `,
        [machineId, organizationId, enrollment.project_id ?? null, machineName],
      );
      await client.query(
        `
        INSERT INTO agent_control.agents (
          id, organization_id, project_id, machine_id, name, public_key,
          status, created_by_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'offline', $7)
        `,
        [
          agentId,
          organizationId,
          enrollment.project_id ?? null,
          machineId,
          machineName,
          input.publicKey,
          enrollment.created_by_id ?? null,
        ],
      );
      await client.query(
        `
        INSERT INTO agent_control.credentials (id, agent_id, secret_hash)
        VALUES ($1, $2, $3)
        `,
        [credentialId, agentId, digest(credentialSecret)],
      );
      await client.query(
        `
        UPDATE agent_control.enrollments
        SET status = 'consumed', consumed_at = now(),
            consumed_by_agent_id = $2, updated_at = now()
        WHERE id = $1
        `,
        [enrollment.id, agentId],
      );
      await appendAudit(client, {
        organizationId,
        agentId,
        enrollmentId: String(enrollment.id),
        actorId: enrollment.created_by_id as string | null,
        action: "agent.enrollment.consumed",
        status: "succeeded",
        details: { machineId },
      });
      await client.query("COMMIT");
      return {
        agentId,
        machineId,
        organizationId,
        credential: `${credentialId}.${credentialSecret}`,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new AgentControlError(
          "This agent identity is already enrolled.",
          "agent_identity_conflict",
          409,
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async issueAccessToken(input: {
    credential: string;
    nonce: string;
    issuedAt: string;
    signature: string;
  }) {
    const [credentialId, secret, ...extra] = input.credential.split(".");
    if (!credentialId || !secret || extra.length) {
      throw unauthorized("agent_credential_invalid");
    }
    const credentialResult = await this.pool.query<Row>(
      `
      SELECT c.*, a.public_key, a.status AS agent_status, a.revoked_at,
             a.organization_id
      FROM agent_control.credentials c
      JOIN agent_control.agents a ON a.id = c.agent_id
      WHERE c.id = $1
      `,
      [credentialId],
    );
    const credential = credentialResult.rows[0];
    if (
      !credential ||
      credential.status !== "active" ||
      credential.agent_status === "revoked" ||
      credential.revoked_at ||
      !safeEqual(String(credential.secret_hash), digest(secret))
    ) {
      throw unauthorized("agent_credential_invalid");
    }
    if (
      this.isOrganizationAdmitted &&
      !(await this.isOrganizationAdmitted(String(credential.organization_id)))
    ) {
      // 403, not 401: the credential is valid, the organization is simply no
      // longer served here, and re-enrolling would not change the answer.
      throw organizationNotServed();
    }
    const issuedAt = Date.parse(input.issuedAt);
    if (
      !Number.isFinite(issuedAt) ||
      Math.abs(this.now().getTime() - issuedAt) > proofClockSkewMs
    ) {
      throw unauthorized("agent_proof_expired");
    }
    const nonce = required(input.nonce, "nonce");
    const agentId = String(credential.agent_id);
    const proof = agentProof(agentId, credentialId, nonce, input.issuedAt);
    if (
      !verifyEd25519(
        String(credential.public_key),
        proof,
        required(input.signature, "signature"),
      )
    ) {
      throw unauthorized("agent_proof_invalid");
    }
    try {
      await this.pool.query(
        `
        INSERT INTO agent_control.auth_nonces (
          nonce_hash, agent_id, expires_at
        ) VALUES ($1, $2, $3)
        `,
        [
          digest(nonce),
          agentId,
          new Date(this.now().getTime() + proofClockSkewMs).toISOString(),
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw unauthorized("agent_proof_replayed");
      }
      throw error;
    }
    await this.pool.query(
      "UPDATE agent_control.credentials SET last_used_at = now() WHERE id = $1",
      [credentialId],
    );
    const expiresAt =
      Math.floor(this.now().getTime() / 1_000) + accessTokenTtlSeconds;
    return {
      accessToken: signToken(
        { agentId, credentialId, exp: expiresAt, jti: randomUUID() },
        this.tokenSecrets[0] as string,
      ),
      expiresIn: accessTokenTtlSeconds,
    };
  }

  verifyAccessToken(token: string) {
    const payload = verifyToken(token, this.tokenSecrets);
    if (payload.exp <= Math.floor(this.now().getTime() / 1_000)) {
      throw unauthorized("agent_access_token_expired");
    }
    return payload;
  }

  async assertAgentActive(agentId: string, credentialId?: string) {
    const result = await this.pool.query<Row>(
      `
      SELECT a.id, a.status, a.revoked_at, c.status AS credential_status
      FROM agent_control.agents a
      LEFT JOIN agent_control.credentials c
        ON c.agent_id = a.id AND ($2::text IS NULL OR c.id = $2)
      WHERE a.id = $1
      `,
      [agentId, credentialId ?? null],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.status === "revoked" ||
      row.revoked_at ||
      (credentialId && row.credential_status !== "active")
    ) {
      throw unauthorized("agent_revoked");
    }
    return row;
  }

  async listAgents(organizationId: string) {
    await this.reconcileStaleSessions();
    const result = await this.pool.query<Row>(
      `
      SELECT a.*, m.worker_id, m.name AS machine_name,
             s.id AS active_session_id, s.heartbeat_at
      FROM agent_control.agents a
      LEFT JOIN agent_control.machines m ON m.id = a.machine_id
      LEFT JOIN LATERAL (
        SELECT id, heartbeat_at
        FROM agent_control.sessions
        WHERE agent_id = a.id AND status = 'online'
        ORDER BY generation DESC
        LIMIT 1
      ) s ON true
      WHERE a.organization_id = $1
      ORDER BY a.updated_at DESC
      `,
      [organizationId],
    );
    return result.rows.map(agentView);
  }

  async listRoomLabels(organizationId: string) {
    const result = await this.pool.query<Row>(
      `
      SELECT room_id, label
      FROM agent_control.room_labels
      WHERE organization_id = $1
      `,
      [required(organizationId, "organizationId")],
    );
    return Object.fromEntries(
      result.rows.map((row) => [String(row.room_id), String(row.label)]),
    );
  }

  async listRecentRoomSourcePaths(
    organizationId: string,
    environmentTemplateKey: string,
    sourceMemberId: string,
    limit = 8,
  ) {
    const result = await this.pool.query<Row>(
      `
      SELECT step->'config'->'source'->'locator'->>'path' AS source_path,
             MAX(step_run.completed_at) AS last_used_at
      FROM execution.workflow_runs run
      CROSS JOIN LATERAL jsonb_array_elements(run.resolved_steps_json) step
      JOIN execution.workflow_step_runs step_run
        ON step_run.workflow_run_id = run.id
       AND step_run.workflow_step_id = step->>'id'
       AND step_run.status = 'completed'
      WHERE run.organization_id = $1
        AND step->>'actionPackage' = '@beam/room-transfer'
        AND step->'config'->>'environmentTemplateKey' = $2
        AND step->'config'->'source'->>'memberId' = $3
        AND step->'config'->'source'->'locator'->>'type' = 'agent_path'
        AND NULLIF(BTRIM(step->'config'->'source'->'locator'->>'path'), '') IS NOT NULL
      GROUP BY step->'config'->'source'->'locator'->>'path'
      ORDER BY last_used_at DESC
      LIMIT $4
      `,
      [
        required(organizationId, "organizationId"),
        required(environmentTemplateKey, "environmentTemplateKey"),
        required(sourceMemberId, "sourceMemberId"),
        Math.min(Math.max(limit, 1), 20),
      ],
    );
    return result.rows.map((row) => String(row.source_path));
  }

  async setRoomLabel(input: {
    organizationId: string;
    roomId: string;
    label?: string | null;
  }) {
    const organizationId = required(input.organizationId, "organizationId");
    const roomId = required(input.roomId, "roomId");
    const label = input.label?.trim() ?? "";
    if (label.length > 120) {
      throw new AgentControlError(
        "Room labels cannot exceed 120 characters.",
        "room_label_too_long",
        400,
      );
    }
    if (!label) {
      await this.pool.query(
        `
        DELETE FROM agent_control.room_labels
        WHERE organization_id = $1 AND room_id = $2
        `,
        [organizationId, roomId],
      );
      return null;
    }
    await this.pool.query(
      `
      INSERT INTO agent_control.room_labels (
        organization_id, room_id, label
      ) VALUES ($1, $2, $3)
      ON CONFLICT (organization_id, room_id) DO UPDATE
      SET label = EXCLUDED.label, updated_at = now()
      `,
      [organizationId, roomId, label],
    );
    return label;
  }

  async getAgent(organizationId: string, agentId: string) {
    await this.reconcileStaleSessions();
    const result = await this.pool.query<Row>(
      `
      SELECT a.*, m.worker_id, m.name AS machine_name,
             s.id AS active_session_id, s.heartbeat_at
      FROM agent_control.agents a
      LEFT JOIN agent_control.machines m ON m.id = a.machine_id
      LEFT JOIN LATERAL (
        SELECT id, heartbeat_at
        FROM agent_control.sessions
        WHERE agent_id = a.id AND status = 'online'
        ORDER BY generation DESC
        LIMIT 1
      ) s ON true
      WHERE a.id = $1 AND a.organization_id = $2
      `,
      [agentId, organizationId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("agent_not_found", "Agent was not found.");
    return agentView(row);
  }

  async getAgentById(agentId: string) {
    await this.reconcileStaleSessions();
    const result = await this.pool.query<Row>(
      `
      SELECT a.*, m.worker_id, m.name AS machine_name,
             s.id AS active_session_id, s.heartbeat_at
      FROM agent_control.agents a
      LEFT JOIN agent_control.machines m ON m.id = a.machine_id
      LEFT JOIN LATERAL (
        SELECT id, heartbeat_at
        FROM agent_control.sessions
        WHERE agent_id = a.id AND status = 'online'
        ORDER BY generation DESC
        LIMIT 1
      ) s ON true
      WHERE a.id = $1
      `,
      [agentId],
    );
    const row = result.rows[0];
    return row
      ? { ...agentView(row), organizationId: String(row.organization_id) }
      : null;
  }

  async reconcileStaleSessions() {
    const staleBefore = new Date(
      this.now().getTime() - staleSessionAfterMs,
    ).toISOString();
    const result = await this.pool.query(
      `
      WITH expired_sessions AS (
        UPDATE agent_control.sessions
        SET status = 'expired', disconnected_at = now(),
            disconnect_reason = 'heartbeat timeout'
        WHERE status = 'online' AND heartbeat_at < $1
        RETURNING agent_id, generation
      )
      UPDATE agent_control.agents a
      SET status = 'stale', updated_at = now()
      FROM expired_sessions s
      WHERE a.id = s.agent_id AND a.session_generation = s.generation
        AND a.status = 'online' AND a.revoked_at IS NULL
      `,
      [staleBefore],
    );
    return result.rowCount ?? 0;
  }

  async renameAgent(
    organizationId: string,
    agentId: string,
    name: unknown,
    actorId?: string | null,
  ) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 160 ||
      /[\u0000-\u001f\u007f]/.test(name)
    ) {
      throw new AgentControlError(
        "Agent name must contain 1–160 characters without control characters.",
        "agent_name_invalid",
        400,
      );
    }
    const normalized = name.trim();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE agent_control.agents SET name = $3, updated_at = now()
         WHERE id = $1 AND organization_id = $2 RETURNING id`,
        [agentId, organizationId, normalized],
      );
      if (!result.rowCount) {
        throw notFound("agent_not_found", "Agent was not found.");
      }
      await appendAudit(client, {
        organizationId,
        agentId,
        actorId,
        action: "agent.renamed",
        status: "succeeded",
        details: { name: normalized },
      });
      await client.query("COMMIT");
      return { id: agentId, name: normalized };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeAgent(
    organizationId: string,
    agentId: string,
    actorId?: string | null,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Row>(
        `
        UPDATE agent_control.agents
        SET status = 'revoked', revoked_at = now(), updated_at = now()
        WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL
        RETURNING id
        `,
        [agentId, organizationId],
      );
      if (!result.rowCount) {
        throw notFound("agent_not_found", "Agent was not found.");
      }
      await client.query(
        `
        UPDATE agent_control.credentials
        SET status = 'revoked', revoked_at = now()
        WHERE agent_id = $1 AND status = 'active'
        `,
        [agentId],
      );
      await client.query(
        `
        UPDATE agent_control.sessions
        SET status = 'disconnected', disconnected_at = now(),
            disconnect_reason = 'agent revoked'
        WHERE agent_id = $1 AND status = 'online'
        `,
        [agentId],
      );
      await appendAudit(client, {
        organizationId,
        agentId,
        actorId,
        action: "agent.revoked",
        status: "succeeded",
        details: {},
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteRevokedAgent(
    organizationId: string,
    agentId: string,
    actorId?: string | null,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Row>(
        `
        SELECT id, status, revoked_at
        FROM agent_control.agents
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE
        `,
        [agentId, organizationId],
      );
      const agent = result.rows[0];
      if (!agent) {
        throw notFound("agent_not_found", "Agent was not found.");
      }
      if (agent.status !== "revoked" || !agent.revoked_at) {
        throw new AgentControlError(
          "Only revoked agents can be deleted.",
          "agent_must_be_revoked",
          409,
        );
      }
      const assignments = await client.query(
        "SELECT id FROM execution.executor_assignments WHERE executor_id=$1 AND cleanup_confirmed_at IS NULL LIMIT 1",
        [agentId],
      );
      if (assignments.rowCount)
        throw new AgentControlError(
          "Reconcile unfinished action assignments before deleting this agent.",
          "agent_execution_cleanup_pending",
          409,
        );
      await appendAudit(client, {
        organizationId,
        agentId,
        actorId,
        action: "agent.deleted",
        status: "succeeded",
        details: { agentId },
      });
      await client.query(
        `DELETE FROM agent_control.agents WHERE id = $1 AND organization_id = $2`,
        [agentId, organizationId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createCommand(
    input: {
      organizationId: string;
      projectId?: string | null;
      agentId: string;
      operation: AgentControlOperation;
      payload: Record<string, unknown>;
      idempotencyKey?: string;
      requestedById?: string | null;
      ttlSeconds?: number;
      transport?: "agent-control" | "room-mls/v1";
    },
    transaction?: PgClient,
  ) {
    if (!agentControlOperations.includes(input.operation)) {
      throw new AgentControlError(
        "Unsupported agent operation.",
        "agent_operation_unsupported",
        400,
      );
    }
    const idempotencyKey =
      input.idempotencyKey?.trim() || id("agent-command-key");
    const fingerprint = stableDigest({
      operation: input.operation,
      payload: input.payload,
    });
    const client = transaction ?? (await this.pool.connect());
    try {
      if (!transaction) await client.query("BEGIN");
      const existing = await client.query<Row>(
        `
        SELECT * FROM agent_control.commands
        WHERE agent_id = $1 AND idempotency_key = $2
        FOR UPDATE
        `,
        [input.agentId, idempotencyKey],
      );
      if (existing.rows[0]) {
        if (
          String(existing.rows[0].request_fingerprint) !== fingerprint ||
          String(existing.rows[0].transport ?? "agent-control") !==
            (input.transport ?? "agent-control")
        ) {
          throw new AgentControlError(
            "Idempotency key was already used with another request.",
            "agent_command_idempotency_conflict",
            409,
          );
        }
        if (!transaction) await client.query("COMMIT");
        return commandView(existing.rows[0]);
      }
      const agentResult = await client.query<Row>(
        `
        UPDATE agent_control.agents
        SET command_sequence = command_sequence + 1, updated_at = now()
        WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL
        RETURNING command_sequence, session_generation
        `,
        [input.agentId, input.organizationId],
      );
      const agent = agentResult.rows[0];
      if (!agent) throw notFound("agent_not_found", "Agent was not found.");
      const commandId = id("agcmd");
      const ttl = Math.min(Math.max(input.ttlSeconds ?? 300, 5), 86_400);
      const expiresAt = new Date(this.now().getTime() + ttl * 1_000);
      const inserted = await client.query<Row>(
        `
        INSERT INTO agent_control.commands (
          id, organization_id, project_id, agent_id, sequence,
          idempotency_key, request_fingerprint, session_generation,
          operation, state, payload_json, requested_by_id, expires_at, transport
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, 0),
                $9, 'queued', $10::jsonb, $11, $12, $13)
        RETURNING *
        `,
        [
          commandId,
          input.organizationId,
          input.projectId ?? null,
          input.agentId,
          agent.command_sequence,
          idempotencyKey,
          fingerprint,
          agent.session_generation,
          input.operation,
          JSON.stringify(input.payload),
          input.requestedById ?? null,
          expiresAt.toISOString(),
          input.transport ?? "agent-control",
        ],
      );
      await appendAudit(client, {
        organizationId: input.organizationId,
        agentId: input.agentId,
        commandId,
        actorId: input.requestedById,
        action: "agent.command.created",
        status: "accepted",
        details: { operation: input.operation, idempotencyKey },
      });
      if (!transaction) await client.query("COMMIT");
      return commandView(inserted.rows[0]!);
    } catch (error) {
      if (!transaction) await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!transaction) client.release();
    }
  }

  async recordDelegatedCommand(input: {
    organizationId: string;
    projectId?: string | null;
    agentId: string;
    operation: AgentControlOperation;
    payload: Record<string, unknown>;
    result: Record<string, unknown>;
    idempotencyKey?: string;
    requestedById?: string | null;
  }) {
    const idempotencyKey =
      input.idempotencyKey?.trim() || id("agent-command-key");
    const fingerprint = stableDigest({
      operation: input.operation,
      payload: input.payload,
    });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<Row>(
        `
        SELECT * FROM agent_control.commands
        WHERE agent_id = $1 AND idempotency_key = $2
        FOR UPDATE
        `,
        [input.agentId, idempotencyKey],
      );
      if (existing.rows[0]) {
        if (String(existing.rows[0].request_fingerprint) !== fingerprint) {
          throw new AgentControlError(
            "Idempotency key was already used with another request.",
            "agent_command_idempotency_conflict",
            409,
          );
        }
        await client.query("COMMIT");
        return commandView(existing.rows[0]);
      }
      const agentResult = await client.query<Row>(
        `
        UPDATE agent_control.agents
        SET command_sequence = command_sequence + 1, updated_at = now()
        WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL
        RETURNING command_sequence
        `,
        [input.agentId, input.organizationId],
      );
      const agent = agentResult.rows[0];
      if (!agent) throw notFound("agent_not_found", "Agent was not found.");
      const commandId = id("agcmd");
      const expiresAt = new Date(this.now().getTime() + 300_000);
      const inserted = await client.query<Row>(
        `
        INSERT INTO agent_control.commands (
          id, organization_id, project_id, agent_id, sequence,
          idempotency_key, request_fingerprint, session_generation,
          operation, state, payload_json, result_json, requested_by_id,
          expires_at, dispatched_at, accepted_at, started_at, completed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NULL,
                $8, 'completed', $9::jsonb, $10::jsonb, $11,
                $12, now(), now(), now(), now())
        RETURNING *
        `,
        [
          commandId,
          input.organizationId,
          input.projectId ?? null,
          input.agentId,
          agent.command_sequence,
          idempotencyKey,
          fingerprint,
          input.operation,
          JSON.stringify(input.payload),
          JSON.stringify(input.result),
          input.requestedById ?? null,
          expiresAt.toISOString(),
        ],
      );
      await appendAudit(client, {
        organizationId: input.organizationId,
        agentId: input.agentId,
        commandId,
        actorId: input.requestedById,
        action: "agent.command.delegated",
        status: "succeeded",
        details: { operation: input.operation, idempotencyKey },
      });
      await client.query("COMMIT");
      return commandView(inserted.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listCommands(organizationId: string, agentId: string, limit = 100) {
    const result = await this.pool.query<Row>(
      `
      SELECT * FROM agent_control.commands
      WHERE organization_id = $1 AND agent_id = $2
      ORDER BY sequence DESC
      LIMIT $3
      `,
      [organizationId, agentId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((row) => commandView(row));
  }

  async listEvents(organizationId: string, agentId: string, limit = 200) {
    const result = await this.pool.query<Row>(
      `
      SELECT * FROM agent_control.events
      WHERE organization_id = $1 AND agent_id = $2
      ORDER BY created_at DESC
      LIMIT $3
      `,
      [organizationId, agentId, Math.min(Math.max(limit, 1), 1_000)],
    );
    return result.rows.map(eventView);
  }

  async openSession(agentId: string, hello: AgentHelloPayload, owner: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const agentResult = await client.query<Row>(
        `
        UPDATE agent_control.agents
        SET session_generation = session_generation + 1,
            status = 'online', daemon_version = $2, daemon_commit = $3,
            daemon_build_date = $4, platform = $5, architecture = $6,
            capabilities_json = $7::jsonb, protocol_min = $8,
            protocol_max = $9, action_execution_json=$10::jsonb, last_seen_at = now(), updated_at = now()
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING *
        `,
        [
          agentId,
          hello.daemonVersion,
          hello.daemonCommit ?? null,
          hello.daemonBuildDate ?? null,
          hello.platform,
          hello.architecture,
          JSON.stringify(hello.capabilities),
          hello.protocolMin,
          hello.protocolMax,
          hello.actionExecution ? JSON.stringify(hello.actionExecution) : null,
        ],
      );
      const agent = agentResult.rows[0];
      if (!agent) throw unauthorized("agent_revoked");
      // A lost socket can strand a command after its accepted/running event.
      // Requeue it for at-least-once delivery; the agent journal makes the
      // replay durable and returns the prior terminal result when available.
      await client.query(
        `
        UPDATE agent_control.commands
        SET state = 'queued', session_generation = NULL, updated_at = now()
        WHERE agent_id = $1 AND state IN ('accepted', 'running')
          AND transport = 'agent-control'
          AND expires_at > now()
        `,
        [agentId],
      );
      await client.query(
        `
        UPDATE agent_control.sessions
        SET status = 'replaced', disconnected_at = now(),
            disconnect_reason = 'new session connected'
        WHERE agent_id = $1 AND status = 'online'
        `,
        [agentId],
      );
      const sessionId = id("agsess");
      await client.query(
        `
        INSERT INTO agent_control.sessions (
          id, agent_id, generation, boot_id, connection_owner, metadata_json
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          sessionId,
          agentId,
          agent.session_generation,
          hello.bootId,
          owner,
          JSON.stringify({
            lastCommandSequence: hello.lastCommandSequence,
            lastEventSequence: hello.lastEventSequence,
          }),
        ],
      );
      await client.query("COMMIT");
      return {
        sessionId,
        generation: Number(agent.session_generation),
        commandSequence: Number(agent.command_sequence),
        policyRevision: Number(agent.policy_revision),
        policy: objectValue(agent.policy_json),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(agentId: string, sessionId: string, generation: number) {
    const result = await this.pool.query(
      `
      UPDATE agent_control.sessions s
      SET heartbeat_at = now()
      FROM agent_control.agents a
      WHERE s.id = $1 AND s.agent_id = $2 AND s.generation = $3
        AND s.status = 'online' AND a.id = s.agent_id
        AND a.session_generation = $3 AND a.revoked_at IS NULL
      `,
      [sessionId, agentId, generation],
    );
    if (!result.rowCount) throw unauthorized("agent_session_fenced");
    await this.pool.query(
      "UPDATE agent_control.agents SET status = 'online', last_seen_at = now(), updated_at = now() WHERE id = $1 AND session_generation = $2",
      [agentId, generation],
    );
  }

  async pendingCommands(agentId: string, generation: number) {
    await this.expireCommands(agentId);
    const result = await this.pool.query<Row>(
      `
      SELECT c.* FROM agent_control.commands c
      WHERE c.agent_id = $1
        AND c.transport = 'agent-control'
        AND c.state IN ('queued', 'dispatched')
        AND c.expires_at > now()
        AND NOT EXISTS (
          SELECT 1 FROM execution.executor_assignments assignment
          JOIN agent_control.commands invocation
            ON invocation.id = assignment.command_id
          WHERE assignment.id = c.payload_json->>'assignmentId'
            AND invocation.transport = 'room-mls/v1'
        )
      ORDER BY c.sequence
      LIMIT 100
      `,
      [agentId],
    );
    return result.rows.map((row) => ({
      ...commandView(row, false),
      payload: objectValue(row.payload_json),
      sessionGeneration: generation,
    }));
  }

  async markDispatched(agentId: string, commandId: string, generation: number) {
    const result = await this.pool.query(
      `
      UPDATE agent_control.commands c
      SET state = 'dispatched', session_generation = $3,
          dispatched_at = COALESCE(dispatched_at, now()), updated_at = now()
      FROM agent_control.agents a
      WHERE c.id = $1 AND c.agent_id = $2
        AND c.transport = 'agent-control'
        AND c.state IN ('queued', 'dispatched')
        AND c.expires_at > now()
        AND NOT EXISTS (
          SELECT 1 FROM execution.executor_assignments assignment
          JOIN agent_control.commands invocation
            ON invocation.id = assignment.command_id
          WHERE assignment.id = c.payload_json->>'assignmentId'
            AND invocation.transport = 'room-mls/v1'
        )
        AND a.id = c.agent_id AND a.session_generation = $3
      `,
      [commandId, agentId, generation],
    );
    return Boolean(result.rowCount);
  }

  async applyCommandEvent(
    sessionId: string,
    eventType: string,
    event: AgentCommandEventPayload,
  ) {
    if (!agentControlCommandStates.includes(event.state)) {
      throw new AgentControlError(
        "Unknown command state.",
        "agent_command_state_invalid",
        400,
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const commandResult = await client.query<Row>(
        "SELECT operation FROM agent_control.commands WHERE id=$1 AND agent_id=$2 AND transport='agent-control' FOR UPDATE",
        [event.commandId, event.agentId],
      );
      if (!commandResult.rows[0])
        throw notFound("agent_command_not_found", "Command was not found for this agent.");
      const storedResult = storedCommandResult(
        String(commandResult.rows[0].operation),
        event.result,
      );
      const sessionResult = await client.query<Row>(
        `
        SELECT s.*, a.organization_id, a.session_generation
        FROM agent_control.sessions s
        JOIN agent_control.agents a ON a.id = s.agent_id
        WHERE s.id = $1 AND s.agent_id = $2 AND s.generation = $3
          AND s.status = 'online' AND a.session_generation = $3
          AND a.revoked_at IS NULL
        FOR UPDATE OF s
        `,
        [sessionId, event.agentId, event.sessionGeneration],
      );
      const session = sessionResult.rows[0];
      if (!session) throw unauthorized("agent_session_fenced");
      const transition = eventTransition(event.state);
      const updated = await client.query<Row>(
        `
        UPDATE agent_control.commands
        SET state = $4,
            result_json = COALESCE($5::jsonb, result_json),
            error_json = COALESCE($6::jsonb, error_json),
            accepted_at = CASE WHEN $4 = 'accepted' THEN COALESCE(accepted_at, now()) ELSE accepted_at END,
            started_at = CASE WHEN $4 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
            completed_at = CASE WHEN $4 IN ('completed', 'failed', 'cancelled') THEN COALESCE(completed_at, now()) ELSE completed_at END,
            updated_at = now()
        WHERE id = $1 AND agent_id = $2 AND session_generation = $3
          AND transport = 'agent-control'
          AND state = ANY($7::text[])
        RETURNING *
        `,
        [
          event.commandId,
          event.agentId,
          event.sessionGeneration,
          event.state,
          storedResult ? JSON.stringify(storedResult) : null,
          event.error ? JSON.stringify(event.error) : null,
          transition.from,
        ],
      );
      if (!updated.rows[0]) {
        const existing = await client.query<Row>(
          "SELECT state FROM agent_control.commands WHERE id = $1 AND agent_id = $2 AND transport = 'agent-control'",
          [event.commandId, event.agentId],
        );
        if (existing.rows[0]?.state !== event.state) {
          throw new AgentControlError(
            "Command event is stale or invalid for the current state.",
            "agent_command_transition_invalid",
            409,
          );
        }
      }
      const eventId = id("agev");
      await client.query(
        `
        INSERT INTO agent_control.events (
          id, organization_id, agent_id, session_id, command_id,
          sequence, event_type, payload_json
        )
        VALUES ($1, $2, $3, $4, $5, NULLIF($6, 0), $7, $8::jsonb)
        ON CONFLICT (agent_id, sequence) DO NOTHING
        `,
        [
          eventId,
          session.organization_id,
          event.agentId,
          sessionId,
          event.commandId,
          event.sequence,
          eventType,
          JSON.stringify(event),
        ],
      );
      await client.query(
        `
        UPDATE agent_control.agents
        SET event_sequence = GREATEST(event_sequence, $2),
            last_seen_at = now(), updated_at = now()
        WHERE id = $1 AND session_generation = $3
        `,
        [event.agentId, event.sequence, event.sessionGeneration],
      );
      await client.query("COMMIT");
      return updated.rows[0] ? commandView(updated.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendAgentEvent(
    sessionId: string,
    input: {
      agentId: string;
      generation: number;
      sequence: number;
      eventType: string;
      payload: Record<string, unknown>;
    },
  ) {
    const result = await this.pool.query<Row>(
      `
      INSERT INTO agent_control.events (
        id, organization_id, agent_id, session_id, sequence,
        event_type, payload_json
      )
      SELECT $1, a.organization_id, a.id, s.id, NULLIF($5, 0), $6, $7::jsonb
      FROM agent_control.agents a
      JOIN agent_control.sessions s ON s.agent_id = a.id
      WHERE a.id = $2 AND s.id = $3 AND s.generation = $4
        AND a.session_generation = $4 AND s.status = 'online'
        AND a.revoked_at IS NULL
      ON CONFLICT (agent_id, sequence) DO NOTHING
      RETURNING id
      `,
      [
        id("agev"),
        input.agentId,
        sessionId,
        input.generation,
        input.sequence,
        input.eventType,
        JSON.stringify(input.payload),
      ],
    );
    if (!result.rowCount) {
      const duplicate = await this.pool.query(
        "SELECT 1 FROM agent_control.events WHERE agent_id = $1 AND sequence = $2",
        [input.agentId, input.sequence],
      );
      if (!duplicate.rowCount) throw unauthorized("agent_session_fenced");
    }
  }

  async closeSession(
    sessionId: string,
    agentId: string,
    generation: number,
    reason: string,
  ) {
    await this.pool.query(
      `
      UPDATE agent_control.sessions
      SET status = 'disconnected', disconnected_at = now(),
          disconnect_reason = $4
      WHERE id = $1 AND agent_id = $2 AND generation = $3
        AND status = 'online'
      `,
      [sessionId, agentId, generation, reason.slice(0, 500)],
    );
    await this.pool.query(
      `
      UPDATE agent_control.agents
      SET status = 'offline', updated_at = now()
      WHERE id = $1 AND session_generation = $2 AND revoked_at IS NULL
      `,
      [agentId, generation],
    );
  }

  private async expireCommands(agentId: string) {
    await this.pool.query(
      `
      UPDATE agent_control.commands
      SET state = 'expired', completed_at = now(), updated_at = now()
      WHERE agent_id = $1 AND state IN ('queued', 'dispatched', 'accepted', 'running')
        AND transport = 'agent-control'
        AND expires_at <= now()
      `,
      [agentId],
    );
  }
}

function storedCommandResult(
  operation: string,
  result: Record<string, unknown> | undefined,
) {
  if (!result) return undefined;
  if (
    ![
      "tunnel.create",
      "destination.create",
      "endpoint.get",
      "endpoint.list",
    ].includes(operation)
  ) {
    return result;
  }
  const endpoint = objectValue(result.endpoint);
  if (Object.keys(endpoint).length) {
    return {
      endpoint: {
        id: endpoint.id,
        status: endpoint.status,
        direction: endpoint.direction,
        public: endpoint.public,
      },
    };
  }
  const endpoints = Array.isArray(result.endpoints)
    ? result.endpoints.map((item) => {
        const value = objectValue(item);
        return {
          id: value.id,
          idempotency_key: value.idempotency_key,
          status: value.status,
          direction: value.direction,
          public: value.public,
        };
      })
    : [];
  return { endpoints };
}

function eventTransition(state: AgentControlCommandState) {
  switch (state) {
    case "accepted":
      return { from: ["queued", "dispatched", "accepted"] };
    case "running":
      return { from: ["dispatched", "accepted", "running"] };
    case "completed":
    case "failed":
    case "cancelled":
      return { from: ["dispatched", "accepted", "running", state] };
    default:
      return { from: [state] };
  }
}

async function ensureOrganization(client: PgClient, organizationId: string) {
  const slug = `agent-${digest(organizationId).slice(0, 18)}`;
  await client.query(
    `
    INSERT INTO identity.organizations (id, slug, name)
    VALUES ($1, $2, $1)
    ON CONFLICT (id) DO NOTHING
    `,
    [organizationId, slug],
  );
}

async function appendAudit(
  client: PgClient,
  input: {
    organizationId: string;
    agentId?: string | null;
    enrollmentId?: string | null;
    commandId?: string | null;
    actorId?: string | null;
    action: string;
    status: string;
    details: Record<string, unknown>;
  },
) {
  await client.query(
    `
    INSERT INTO agent_control.audit_events (
      id, organization_id, agent_id, enrollment_id, command_id,
      actor_id, action, status, details_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `,
    [
      id("agaud"),
      input.organizationId,
      input.agentId ?? null,
      input.enrollmentId ?? null,
      input.commandId ?? null,
      input.actorId ?? null,
      input.action,
      input.status,
      JSON.stringify(input.details),
    ],
  );
}

function agentView(row: Row) {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: nullableString(row.project_id),
    machineId: nullableString(row.machine_id),
    machineName: nullableString(row.machine_name) ?? String(row.name),
    workerId: nullableString(row.worker_id),
    name: String(row.name),
    status: String(row.status),
    daemonVersion: nullableString(row.daemon_version),
    daemonCommit: nullableString(row.daemon_commit),
    daemonBuildDate: nullableString(row.daemon_build_date),
    platform: nullableString(row.platform),
    architecture: nullableString(row.architecture),
    capabilities: arrayValue(row.capabilities_json),
    actionExecution: nullableObject(row.action_execution_json),
    protocolMin: nullableNumber(row.protocol_min),
    protocolMax: nullableNumber(row.protocol_max),
    sessionGeneration: Number(row.session_generation ?? 0),
    policyRevision: Number(row.policy_revision ?? 0),
    policy: objectValue(row.policy_json),
    lastSeenAt: nullableDate(row.last_seen_at),
    heartbeatAt: nullableDate(row.heartbeat_at),
    enrolledAt: nullableDate(row.enrolled_at),
    revokedAt: nullableDate(row.revoked_at),
  };
}

function commandView(row: Row, redact = true) {
  const payload = objectValue(row.payload_json);
  const result = nullableObject(row.result_json);
  const error = nullableObject(row.error_json);
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    organizationId: String(row.organization_id),
    projectId: nullableString(row.project_id),
    sequence: Number(row.sequence),
    idempotencyKey: String(row.idempotency_key),
    operation: String(row.operation) as AgentControlOperation,
    state: String(row.state) as AgentControlCommandState,
    payload: redact ? redactSensitive(payload) : payload,
    result: redact && result ? redactSensitive(result) : result,
    error: redact && error ? redactSensitive(error) : error,
    sessionGeneration: nullableNumber(row.session_generation),
    expiresAt: nullableDate(row.expires_at),
    dispatchedAt: nullableDate(row.dispatched_at),
    acceptedAt: nullableDate(row.accepted_at),
    startedAt: nullableDate(row.started_at),
    completedAt: nullableDate(row.completed_at),
    createdAt: nullableDate(row.created_at),
    updatedAt: nullableDate(row.updated_at),
  };
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /(token|capability|secret|credential|private[_-]?key|identity[_-]?key|bridge[_-]?lease)/i.test(
        key,
      )
        ? "[REDACTED]"
        : redactSensitive(item),
    ]),
  );
}

function eventView(row: Row) {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    sessionId: nullableString(row.session_id),
    commandId: nullableString(row.command_id),
    sequence: nullableNumber(row.sequence),
    type: String(row.event_type),
    payload: objectValue(row.payload_json),
    createdAt: nullableDate(row.created_at),
  };
}

function enrollmentCode() {
  const value = randomBytes(12).toString("base64url").toUpperCase();
  return `BM-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

function agentProof(
  agentId: string,
  credentialId: string,
  nonce: string,
  issuedAt: string,
) {
  return `beam-studio-agent-token-v1\n${agentId}\n${credentialId}\n${nonce}\n${issuedAt}`;
}

function verifyEd25519(publicKey: string, message: string, signature: string) {
  try {
    return verifySignature(
      null,
      Buffer.from(message),
      ed25519PublicKey(publicKey),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function validateEd25519PublicKey(value: string) {
  try {
    ed25519PublicKey(value);
  } catch {
    throw new AgentControlError(
      "Agent public key is not a valid Ed25519 key.",
      "agent_public_key_invalid",
      400,
    );
  }
}

function ed25519PublicKey(value: string) {
  const raw = Buffer.from(required(value, "publicKey"), "base64url");
  if (raw.length !== 32) throw new Error("invalid Ed25519 key length");
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "spki",
  });
}

type AccessTokenPayload = {
  agentId: string;
  credentialId: string;
  exp: number;
  jti: string;
};

function signToken(payload: AccessTokenPayload, secret: string) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

/**
 * @param secrets  Every signing secret currently on the keyring, active first.
 *   An agent token issued under a key that has since been retired keeps
 *   working until that key is dropped, so rotating the vault key does not
 *   disconnect every agent at once.
 */
function verifyToken(
  token: string,
  secrets: readonly string[],
): AccessTokenPayload {
  const [encoded, signature, ...extra] = token.split(".");
  if (!encoded || !signature || extra.length)
    throw unauthorized("agent_access_token_invalid");
  const matched = secrets.some((secret) =>
    safeEqual(
      signature,
      createHmac("sha256", secret).update(encoded).digest("base64url"),
    ),
  );
  if (!matched) throw unauthorized("agent_access_token_invalid");
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString(),
    ) as AccessTokenPayload;
    if (
      !payload.agentId ||
      !payload.credentialId ||
      !payload.jti ||
      !Number.isSafeInteger(payload.exp)
    ) {
      throw new Error("invalid token payload");
    }
    return payload;
  } catch {
    throw unauthorized("agent_access_token_invalid");
  }
}

function stableDigest(value: unknown) {
  return digest(stableJson(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function unauthorized(code: string) {
  return new AgentControlError("Agent authentication failed.", code, 401);
}

/**
 * The agent's organization is not served here. An open join policy does not
 * count: agents are machine callers, admitted only when an owner recorded the
 * admission (or the organization is exempt, like the Rooms consumer).
 */
function organizationNotServed() {
  return new AgentControlError(
    "This Studio does not serve the agent's organization. Its owner has to admit the organization in Settings -> Access.",
    "instance_organization_forbidden",
    403,
  );
}

function notFound(code: string, message: string) {
  return new AgentControlError(message, code, 404);
}

function required(value: string, name: string) {
  const result = value?.trim();
  if (!result) {
    throw new AgentControlError(`${name} is required.`, "invalid_request", 400);
  }
  return result;
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function canonicalAgentId(value?: string) {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  if (!/^agt_[a-f0-9]{20,64}$/i.test(candidate)) {
    throw new AgentControlError(
      "agentId must be a canonical coordinator agent id.",
      "agent_id_invalid",
      400,
    );
  }
  return candidate;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nullableObject(value: unknown) {
  return value === null || value === undefined ? null : objectValue(value);
}

function arrayValue(value: unknown) {
  if (typeof value === "string") {
    try {
      return arrayValue(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function nullableString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableDate(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
