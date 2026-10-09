import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import {
  archiveAssistantConversation,
  findAssistantReply,
  listAssistantConversations,
  renameAssistantConversation,
} from "./store.js";

test("conversation history mutations and reply recovery keep organization and user scope", async () => {
  const globals = globalThis as typeof globalThis & {
    __beamStudioPgPool?: PgPool;
  };
  const previous = globals.__beamStudioPgPool;
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let rows: Record<string, unknown>[] = [];
  globals.__beamStudioPgPool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows };
    },
  } as unknown as PgPool;
  const scope = { organizationId: "org-a", userId: "user-a" };
  try {
    rows = [
      {
        id: "chat-a",
        title: "Daily sync",
        archived_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        message_count: 2,
      },
    ];
    const conversations = await listAssistantConversations({
      ...scope,
      search: "Daily",
    });
    assert.equal(conversations[0]?.archivedAt, null);
    assert.deepEqual(calls.at(-1)?.values, ["org-a", "user-a", false, "Daily"]);
    assert.match(calls.at(-1)!.sql, /c\.archived_at IS NOT NULL/);
    assert.match(calls.at(-1)!.sql, /strpos\(lower\(c.title\), lower\(\$4\)\)/);
    await listAssistantConversations({ ...scope, archived: true });
    assert.deepEqual(calls.at(-1)?.values, ["org-a", "user-a", true, ""]);
    assert.equal(
      await archiveAssistantConversation("chat-a", true, scope),
      true,
    );
    assert.equal(calls.at(-1)?.values[0], "chat-a");
    assert.equal(typeof calls.at(-1)?.values[1], "string");
    assert.deepEqual(calls.at(-1)?.values.slice(2), ["org-a", "user-a"]);
    assert.match(calls.at(-1)!.sql, /organization_id = \$3/);
    assert.match(calls.at(-1)!.sql, /user_id IS NOT DISTINCT FROM \$4/);
    assert.doesNotMatch(calls.at(-1)!.sql, /DELETE/);
    await archiveAssistantConversation("chat-a", false, scope);
    assert.equal(calls.at(-1)?.values[1], null);
    await renameAssistantConversation("chat-a", "  Revised title  ", scope);
    assert.equal(calls.at(-1)?.values[1], "Revised title");
    assert.deepEqual(calls.at(-1)?.values.slice(3), ["org-a", "user-a"]);
    await assert.rejects(
      renameAssistantConversation("chat-a", " ", scope),
      /title is required/,
    );
    rows = [];
    assert.equal(
      await archiveAssistantConversation("missing", true, scope),
      false,
    );
    rows = [
      { conversation_id: "chat-a", response: { message: "Already completed" } },
    ];
    assert.deepEqual(await findAssistantReply("request-a", scope), {
      conversationId: "chat-a",
      response: { message: "Already completed" },
    });
    assert.deepEqual(calls.at(-1)?.values, ["org-a", "user-a", "request-a"]);
    assert.match(
      calls.at(-1)!.sql,
      /c.organization_id = \$1 AND c.user_id = \$2/,
    );
    const count = calls.length;
    assert.equal(
      await findAssistantReply("request-a", { organizationId: "org-a" }),
      null,
    );
    assert.equal(calls.length, count);
  } finally {
    globals.__beamStudioPgPool = previous;
  }
});
