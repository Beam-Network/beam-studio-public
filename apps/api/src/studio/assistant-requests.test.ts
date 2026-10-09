import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPostgresPool, type PgPool } from "@beam-studio/db";
import {
  getAssistantConversation,
  listAssistantConversations,
} from "./store.js";
import {
  AssistantRequestRepository,
  AssistantRequestWorker,
  type AssistantRequestInput,
} from "./assistant-requests.js";

const databaseUrl = process.env.ASSISTANT_TEST_DATABASE_URL;
const scope = {
  organizationId: "org-a",
  userId: "user-a",
  projectId: null,
  permissions: ["studio:read"],
};
const input = (prompt = "Hello"): AssistantRequestInput => ({
  prompt,
  context: {},
  route: "/",
  scope,
});

async function fixture(
  run: (repository: AssistantRequestRepository, pool: PgPool) => Promise<void>,
) {
  assert.ok(databaseUrl);
  assert.ok(
    ["localhost", "127.0.0.1", "::1"].includes(new URL(databaseUrl).hostname),
    "Integration tests require a local PostgreSQL server",
  );
  const raw = createPostgresPool(databaseUrl);
  const schema = `assistant_test_${randomUUID().replaceAll("-", "")}`;
  // identity.organizations is rewritten too, so the conversation foreign key
  // below is enforced the way the target schema enforces it.
  const rewrite = (sql: string) =>
    sql
      .replaceAll("assistant.", `${schema}.`)
      .replaceAll("identity.organizations", `${schema}.organizations`);
  const pool = {
    query: (sql: string, values?: unknown[]) => raw.query(rewrite(sql), values),
    connect: async () => {
      const client = await raw.connect();
      return {
        query: (sql: string, values?: unknown[]) =>
          client.query(rewrite(sql), values),
        release: () => client.release(),
      };
    },
  } as unknown as PgPool;
  const globals = globalThis as typeof globalThis & {
    __beamStudioPgPool?: PgPool;
  };
  const previousPool = globals.__beamStudioPgPool;
  globals.__beamStudioPgPool = pool;
  try {
    await raw.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE identity.organizations (
      id text PRIMARY KEY, slug text NOT NULL, name text NOT NULL, metadata_json jsonb,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE assistant.conversations (
      id text PRIMARY KEY, organization_id text REFERENCES identity.organizations(id), user_id text, project_id text, title text, route text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), archived_at timestamptz);
      CREATE TABLE assistant.messages (id text PRIMARY KEY, conversation_id text REFERENCES assistant.conversations(id) ON DELETE CASCADE,
      role text, content text, meta_json jsonb, created_at timestamptz DEFAULT now());`);
    const source = readFileSync(
      new URL(
        "../../../../packages/db/src/beam-studio-target-schema.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const migration = source.slice(
      source.indexOf(
        "ALTER TABLE assistant.conversations ADD COLUMN IF NOT EXISTS read_request_id",
      ),
      source.indexOf("CREATE TABLE IF NOT EXISTS assistant.provider_settings"),
    );
    assert.ok(
      migration.includes("CREATE TABLE IF NOT EXISTS assistant.requests"),
    );
    await pool.query(migration);
    await pool.query(migration); // Startup schema changes remain idempotent.
    await run(new AssistantRequestRepository(pool), pool);
  } finally {
    globals.__beamStudioPgPool = previousPool;
    await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await raw.end();
  }
}

const integration = { skip: !databaseUrl };
test(
  "durable requests are idempotent, scoped, atomic and fenced across cancellation/retry",
  integration,
  async () =>
    fixture(async (repo, pool) => {
      const [first, duplicate] = await Promise.all([
        repo.enqueue(input(), "key-1", null, "encrypted"),
        repo.enqueue(input(), "key-1", null, "encrypted"),
      ]);
      assert.equal(first.id, duplicate.id);
      assert.equal((await repo.messages(first.conversation_id)).length, 1);
      await assert.rejects(
        repo.enqueue(input("Again"), "key-2", first.conversation_id, null),
        /already has a response/,
      );
      const stranger = { ...scope, userId: "other-user" };
      assert.equal(await repo.get(first.id, stranger), null);
      assert.equal(await repo.cancel(first.id, stranger), null);
      await assert.rejects(repo.retry(first.id, stranger, null), /not found/);
      await assert.rejects(
        repo.enqueue(
          { ...input(), scope: stranger },
          "other-key",
          first.conversation_id,
          null,
        ),
        /not found/,
      );
      const second = await repo.enqueue(
        input("Another chat"),
        "key-other-chat",
        null,
        "encrypted",
      );
      const [a, b] = await Promise.all([
        repo.claim("lease-a"),
        repo.claim("lease-b"),
      ]);
      assert.ok(a && b);
      assert.notEqual(a.id, b.id);
      const firstLease = a.id === first.id ? "lease-a" : "lease-b";
      const cancelled = await repo.cancel(first.id, scope);
      assert.equal(cancelled?.worker_id, firstLease);
      assert.equal(
        await repo.finish(first, firstLease, {
          response: { message: "Too late" },
        }),
        false,
      );
      assert.equal((await repo.messages(first.conversation_id)).length, 1);
      const retry = await repo.retry(
        first.id,
        { ...scope, projectId: "another-project" },
        "new-encrypted",
      );
      assert.equal(
        retry.input_json.scope.projectId,
        null,
        "retry preserves the original request's project",
      );
      const retried = await repo.claim("retry-lease");
      assert.equal(retried?.id, first.id);
      assert.equal(
        await repo.finish(first, firstLease, {
          response: { message: "Old attempt" },
        }),
        false,
      );
      assert.equal(
        await repo.finish(first, "retry-lease", {
          response: { message: "Ready", plan: { id: "plan-1" } },
        }),
        true,
      );
      assert.equal(
        await repo.finish(first, "retry-lease", {
          response: { message: "Duplicate" },
        }),
        false,
      );
      const messages = await repo.messages(first.conversation_id);
      assert.deepEqual(
        messages.map((message) => message.content),
        ["Hello", "Ready"],
      );
      assert.equal((await repo.get(first.id, scope))?.encrypted_session, null);
      const ready = await getAssistantConversation(
        first.conversation_id,
        scope,
      );
      assert.equal(ready?.unread, true);
      assert.equal(ready?.request?.status, "succeeded");
      assert.equal(ready?.messages.at(-1)?.meta.planId, "plan-1");
      assert.ok(!JSON.stringify(ready).includes("encrypted_session"));
      assert.ok(
        (await listAssistantConversations(scope)).some(
          (chat) => chat.id === first.conversation_id && chat.unread,
        ),
      );
      assert.equal(
        await repo.markRead(first.conversation_id, first.id, stranger),
        false,
      );
      assert.equal(
        await repo.markRead(first.conversation_id, first.id, scope),
        true,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT read_request_id FROM assistant.conversations WHERE id=$1",
            [first.conversation_id],
          )
        ).rows[0].read_request_id,
        first.id,
      );
      assert.equal(
        (await getAssistantConversation(first.conversation_id, scope))?.unread,
        false,
      );
      const next = await repo.enqueue(
        input("Next turn"),
        "key-next",
        first.conversation_id,
        "encrypted",
      );
      await assert.rejects(
        repo.retry(first.id, scope, null),
        /Only the latest/,
      );
      assert.equal(
        await repo.markRead(first.conversation_id, next.id, scope),
        false,
      );
      // A different API process can pick up queued work; expired executions are not silently replayed.
      await pool.query(
        "UPDATE assistant.requests SET lease_until=now()-interval '1 minute' WHERE id=$1",
        [second.id],
      );
      const restarted = new AssistantRequestRepository(pool);
      assert.equal((await restarted.claim("after-restart"))?.id, next.id);
      assert.equal(
        (await restarted.get(second.id, scope))?.error_code,
        "interrupted",
      );
      assert.equal(await restarted.heartbeat(second.id, "lease-b"), false);
      assert.equal(
        await restarted.finish(second, "lease-b", {
          response: { message: "Lost lease" },
        }),
        false,
      );
      assert.equal(
        (await repo.enqueue(input(), "key-1", null, null)).status,
        "succeeded",
      );
      await pool.query(
        "ALTER TABLE assistant.messages ADD CONSTRAINT reject_answer CHECK (content <> 'Rejected answer')",
      );
      await assert.rejects(
        repo.finish(next, "after-restart", {
          response: { message: "Rejected answer" },
        }),
      );
      assert.equal(
        (await repo.get(next.id, scope))?.status,
        "running",
        "message and success state roll back together",
      );
      assert.equal((await repo.messages(next.conversation_id)).length, 3);
      await pool.query(
        "ALTER TABLE assistant.messages DROP CONSTRAINT reject_answer",
      );
      await repo.finish(next, "after-restart", {
        response: { message: "Next reply" },
      });
      await repo.markRead(first.conversation_id, first.id, scope);
      assert.equal(
        (await getAssistantConversation(first.conversation_id, scope))?.unread,
        true,
        "an old acknowledgement cannot read the new answer",
      );
      await repo.markRead(first.conversation_id, next.id, scope);
      await repo.markRead(first.conversation_id, first.id, scope);
      assert.equal(
        (await getAssistantConversation(first.conversation_id, scope))?.unread,
        false,
        "a delayed old acknowledgement cannot regress read state",
      );
    }),
);

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for background work");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "background worker completes concurrent conversations without a waiting client",
  integration,
  async () =>
    fixture(async (repo, pool) => {
      const jobs = await Promise.all(
        ["one", "two", "three"].map((key) =>
          repo.enqueue(input(key), key, null, null),
        ),
      );
      const releases = new Map<string, () => void>();
      const errors: unknown[] = [];
      const worker = new AssistantRequestWorker(
        new AssistantRequestRepository(pool),
        async (job, signal) => {
          await new Promise<void>((resolve, reject) => {
            releases.set(job.id, resolve);
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          return { message: `Answer for ${job.input_json.prompt}` };
        },
        (error) => errors.push(error),
        2,
      );
      try {
        await worker.drain();
        assert.equal(
          releases.size,
          2,
          "two conversations run simultaneously with a bounded queue",
        );
        const first = jobs.find((job) => releases.has(job.id))!;
        await repo.cancel(first.id, scope);
        worker.cancel(first.id);
        await until(() => releases.size === 3);
        for (const [id, release] of releases) if (id !== first.id) release();
        await until(async () =>
          (await Promise.all(jobs.map((job) => repo.get(job.id, scope)))).every(
            (job) => ["succeeded", "cancelled"].includes(job!.status),
          ),
        );
        assert.equal((await repo.messages(first.conversation_id)).length, 1);
        for (const job of jobs.filter((job) => job.id !== first.id)) {
          assert.equal((await repo.messages(job.conversation_id)).length, 2);
          assert.equal((await repo.get(job.id, scope))?.status, "succeeded");
        }
        assert.deepEqual(errors, []);
      } finally {
        await worker.stop();
      }
    }),
);
