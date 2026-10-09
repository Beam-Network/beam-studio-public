import { randomUUID } from "node:crypto";
import { withPostgresTransaction, type PgPool } from "@beam-studio/db";
import {
  redactAssistantPayload,
  type AssistantRequestSummary,
  type AssistantReasoningEffort,
} from "@beam-studio/shared";
import type { AssistantExecutionScope } from "./assistant-operations.js";
import { ensureIdentityOrganization } from "./repositories/identity-organization.js";

type JsonObject = Record<string, unknown>;
export type AssistantRequestInput = {
  prompt: string;
  context: JsonObject;
  route: string;
  model?: string;
  reasoningEffort?: AssistantReasoningEffort;
  scope: AssistantExecutionScope;
};
export type AssistantRequestJob = {
  id: string;
  conversation_id: string;
  organization_id: string;
  user_id: string;
  request_key: string;
  input_json: AssistantRequestInput;
  encrypted_session: string | null;
};
export type AssistantRequestRow = AssistantRequestJob & {
  status: AssistantRequestSummary["status"];
  error: string | null;
  error_code: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  response_json: JsonObject | null;
  worker_id: string | null;
};
export function requestSummary(
  row: AssistantRequestRow,
): AssistantRequestSummary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    error: row.error,
    errorCode: row.error_code,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at).toISOString()
      : null,
  };
}
function failure(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

export class AssistantRequestRepository {
  constructor(private readonly pool: PgPool) {}

  async enqueue(
    input: AssistantRequestInput,
    requestKey: string,
    conversationId: string | null,
    encryptedSession: string | null,
  ) {
    const { organizationId, userId, projectId } = input.scope;
    if (!organizationId || !userId)
      throw failure("Sign in and select an organization.", 401);
    if (!input.prompt.trim() || !requestKey)
      throw failure("A prompt and request key are required.", 400);
    const safePrompt = String(redactAssistantPayload(input.prompt));
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [JSON.stringify([organizationId, userId, requestKey])],
      );
      const previous = (
        await client.query<AssistantRequestRow>(
          "SELECT * FROM assistant.requests WHERE organization_id=$1 AND user_id=$2 AND request_key=$3",
          [organizationId, userId, requestKey],
        )
      ).rows[0];
      if (previous) {
        if (conversationId && previous.conversation_id !== conversationId)
          throw failure("Request belongs to another conversation.", 409);
        return previous;
      }
      const id = conversationId || `acv_${randomUUID()}`;
      if (!conversationId) {
        // assistant.conversations references identity.organizations, and the
        // first prompt can be the first thing this organization writes.
        await ensureIdentityOrganization(client, organizationId);
        await client.query(
          `INSERT INTO assistant.conversations (id, organization_id, user_id, project_id, title, route)
         VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            id,
            organizationId,
            userId,
            projectId,
            safePrompt.replace(/\s+/g, " ").trim().slice(0, 80),
            input.route,
          ],
        );
      }
      const conversation = (
        await client.query(
          "SELECT id FROM assistant.conversations WHERE id=$1 AND organization_id=$2 AND user_id=$3 FOR UPDATE",
          [id, organizationId, userId],
        )
      ).rows[0];
      if (!conversation) throw failure("Conversation not found.", 404);
      const active = await client.query(
        "SELECT id FROM assistant.requests WHERE conversation_id=$1 AND status IN ('queued','running')",
        [id],
      );
      if (active.rows.length)
        throw failure(
          "This conversation already has a response in progress.",
          409,
        );
      const jobId = `arq_${randomUUID()}`;
      const safeInput = redactAssistantPayload(input);
      const row = (
        await client.query<AssistantRequestRow>(
          `INSERT INTO assistant.requests (id,conversation_id,organization_id,user_id,project_id,request_key,input_json,encrypted_session)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
          [
            jobId,
            id,
            organizationId,
            userId,
            projectId,
            requestKey,
            JSON.stringify(safeInput),
            encryptedSession,
          ],
        )
      ).rows[0]!;
      await client.query(
        `INSERT INTO assistant.messages (id,conversation_id,role,content,meta_json)
         VALUES ($1,$2,'user',$3,$4::jsonb)`,
        [
          `amsg_${randomUUID()}`,
          id,
          safePrompt,
          JSON.stringify({ requestId: jobId, requestKey }),
        ],
      );
      await client.query(
        "UPDATE assistant.conversations SET updated_at=now() WHERE id=$1",
        [id],
      );
      return row;
    });
  }

  async get(
    id: string,
    scope: { organizationId?: string | null; userId?: string | null },
  ) {
    return (
      (
        await this.pool.query<AssistantRequestRow>(
          "SELECT * FROM assistant.requests WHERE id=$1 AND organization_id=$2 AND user_id=$3",
          [id, scope.organizationId, scope.userId],
        )
      ).rows[0] ?? null
    );
  }

  async retry(
    id: string,
    scope: AssistantExecutionScope,
    encryptedSession: string | null,
  ) {
    return withPostgresTransaction(this.pool, async (client) => {
      const current = (
        await client.query<AssistantRequestRow>(
          "SELECT * FROM assistant.requests WHERE id=$1 AND organization_id=$2 AND user_id=$3",
          [id, scope.organizationId, scope.userId],
        )
      ).rows[0];
      if (!current) throw failure("Request not found.", 404);
      await client.query(
        "SELECT id FROM assistant.conversations WHERE id=$1 FOR UPDATE",
        [current.conversation_id],
      );
      const latest = (
        await client.query<AssistantRequestRow>(
          "SELECT * FROM assistant.requests WHERE conversation_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE",
          [current.conversation_id],
        )
      ).rows[0];
      if (latest?.id !== id)
        throw failure("Only the latest message can be retried.", 409);
      if (latest.status !== "failed" && latest.status !== "cancelled")
        return latest;
      return (
        await client.query<AssistantRequestRow>(
          `UPDATE assistant.requests SET status='queued',error=NULL,error_code=NULL,completed_at=NULL,
         worker_id=NULL,lease_until=NULL,encrypted_session=$2,
         input_json=jsonb_set(input_json,'{scope}',$3::jsonb) WHERE id=$1 RETURNING *`,
          [
            id,
            encryptedSession,
            JSON.stringify({
              ...scope,
              projectId: latest.input_json.scope.projectId,
            }),
          ],
        )
      ).rows[0]!;
    });
  }

  async cancel(
    id: string,
    scope: { organizationId?: string | null; userId?: string | null },
  ) {
    const cancelled = (
      await this.pool.query<AssistantRequestRow>(
        `UPDATE assistant.requests SET status='cancelled',completed_at=now(),encrypted_session=NULL,lease_until=NULL
       WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND status IN ('queued','running') RETURNING *`,
        [id, scope.organizationId, scope.userId],
      )
    ).rows[0];
    // Return the exact cancelled lease, even if another client retries immediately.
    return cancelled ?? this.get(id, scope);
  }

  async markRead(
    conversationId: string,
    requestId: string,
    scope: { organizationId?: string | null; userId?: string | null },
  ) {
    const result = await this.pool.query(
      `UPDATE assistant.conversations c SET read_request_id=(
        SELECT r.id FROM assistant.requests r WHERE r.conversation_id=c.id
          AND r.id IN ($2,c.read_request_id) AND r.status='succeeded'
        ORDER BY r.created_at DESC,r.id DESC LIMIT 1)
      WHERE c.id=$1 AND c.organization_id=$3 AND c.user_id=$4
      AND EXISTS (SELECT 1 FROM assistant.requests r WHERE r.id=$2 AND r.conversation_id=c.id AND r.status='succeeded')`,
      [conversationId, requestId, scope.organizationId, scope.userId],
    );
    return Boolean(result.rowCount);
  }

  async claim(workerId: string) {
    // Interrupted generations are surfaced for an explicit retry, never replayed
    // automatically: a provider or a read tool may already have been billed.
    await this.pool
      .query(`UPDATE assistant.requests SET status='failed',error='The server interrupted this response. Please retry.',
      error_code='interrupted',completed_at=now(),encrypted_session=NULL WHERE status='running' AND lease_until < now()`);
    return (
      (
        await this.pool.query<AssistantRequestJob>(
          `WITH next AS (
      SELECT id FROM assistant.requests WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE assistant.requests r SET status='running',worker_id=$1,lease_until=now()+interval '45 seconds'
      FROM next WHERE r.id=next.id RETURNING r.*`,
          [workerId],
        )
      ).rows[0] ?? null
    );
  }

  async heartbeat(id: string, workerId: string) {
    return Boolean(
      (
        await this.pool.query(
          `UPDATE assistant.requests SET lease_until=now()+interval '45 seconds'
      WHERE id=$1 AND worker_id=$2 AND status='running' RETURNING id`,
          [id, workerId],
        )
      ).rowCount,
    );
  }

  async messages(conversationId: string) {
    return (
      await this.pool.query<{ role: "user" | "assistant"; content: string }>(
        "SELECT role,content FROM assistant.messages WHERE conversation_id=$1 ORDER BY created_at,id",
        [conversationId],
      )
    ).rows;
  }

  async finish(
    job: AssistantRequestJob,
    workerId: string,
    result: { response?: JsonObject; error?: string; errorCode?: string },
  ) {
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT id FROM assistant.conversations WHERE id=$1 FOR UPDATE",
        [job.conversation_id],
      );
      const row = (
        await client.query(
          `UPDATE assistant.requests SET status=$3,response_json=$4::jsonb,error=$5,error_code=$6,
        completed_at=now(),lease_until=NULL,encrypted_session=NULL
        WHERE id=$1 AND worker_id=$2 AND status='running' RETURNING id`,
          [
            job.id,
            workerId,
            result.response ? "succeeded" : "failed",
            JSON.stringify(redactAssistantPayload(result.response ?? null)),
            result.error ? String(redactAssistantPayload(result.error)) : null,
            result.errorCode ?? null,
          ],
        )
      ).rows[0];
      if (!row) return false; // Cancellation or an expired lease won the race.
      if (result.response) {
        const response = redactAssistantPayload(result.response) as JsonObject;
        const plan = response.plan as { id?: string } | undefined;
        await client.query(
          `INSERT INTO assistant.messages (id,conversation_id,role,content,meta_json)
          VALUES ($1,$2,'assistant',$3,$4::jsonb)`,
          [
            `amsg_${randomUUID()}`,
            job.conversation_id,
            String(response.message ?? ""),
            JSON.stringify({
              ...response,
              planId: plan?.id,
              requestId: job.id,
              requestKey: job.request_key,
              response,
            }),
          ],
        );
      }
      await client.query(
        "UPDATE assistant.conversations SET updated_at=now() WHERE id=$1",
        [job.conversation_id],
      );
      return true;
    });
  }
}

export type AssistantRequestWorkerRepository = Pick<
  AssistantRequestRepository,
  "claim" | "heartbeat" | "finish"
>;
export class AssistantRequestWorker {
  private readonly workerId = randomUUID();
  private readonly active = new Map<
    string,
    { jobId: string; controller: AbortController; done: Promise<void> }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private claiming = false;
  private stopped = false;
  constructor(
    private readonly repository: AssistantRequestWorkerRepository,
    private readonly execute: (
      job: AssistantRequestJob,
      signal: AbortSignal,
    ) => Promise<JsonObject>,
    private readonly onError: (error: unknown) => void,
    private readonly concurrency = 4,
  ) {}

  start() {
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), 1000);
    this.timer.unref();
    this.kick();
  }
  kick() {
    void this.drain().catch(this.onError);
  }
  cancel(id: string, leaseId?: string) {
    for (const [lease, task] of this.active)
      if (task.jobId === id && (!leaseId || leaseId === lease))
        task.controller.abort();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.claiming)
      await new Promise((resolve) => setTimeout(resolve, 10));
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((task) => task.done),
    );
  }
  async drain() {
    if (this.claiming || this.stopped) return;
    this.claiming = true;
    try {
      while (!this.stopped && this.active.size < this.concurrency) {
        const leaseId = `${this.workerId}:${randomUUID()}`;
        const job = await this.repository.claim(leaseId);
        if (!job) break;
        const controller = new AbortController();
        if (this.stopped) controller.abort();
        const done = this.run(job, controller, leaseId)
          .catch(this.onError)
          .finally(() => {
            this.active.delete(leaseId);
            if (!this.stopped) this.kick();
          });
        this.active.set(leaseId, { jobId: job.id, controller, done });
      }
    } finally {
      this.claiming = false;
    }
  }
  private async run(
    job: AssistantRequestJob,
    controller: AbortController,
    leaseId: string,
  ) {
    let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        if (!(await this.repository.heartbeat(job.id, leaseId)))
          controller.abort();
      } catch (error) {
        controller.abort();
        this.onError(error);
      } finally {
        renewing = false;
      }
    }, 5000);
    heartbeat.unref();
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    timeout.unref();
    try {
      controller.signal.throwIfAborted();
      const response = await this.execute(job, controller.signal);
      controller.signal.throwIfAborted();
      if (response.error)
        await this.repository.finish(job, leaseId, {
          error: String(
            response.providerMessage ||
              "The assistant could not respond. Please retry.",
          ),
          errorCode: String(response.error),
        });
      else await this.repository.finish(job, leaseId, { response });
    } catch (error) {
      await this.repository.finish(job, leaseId, {
        error: controller.signal.aborted
          ? "The response was interrupted. Please retry."
          : "The assistant could not respond. Please retry.",
        errorCode: controller.signal.aborted ? "interrupted" : "provider_error",
      });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  }
}
