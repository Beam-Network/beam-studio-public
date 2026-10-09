import assert from "node:assert/strict";
import test from "node:test";
import type { PgPool } from "@beam-studio/db";
import {
  authorizeV3ArtifactReadPg,
  resolveFrozenV3RoomPg,
} from "./roomMemberExecution.js";

test("private V3 boundary uses only the scoped run capability and frozen artifact descriptor", async () => {
  const previousUrl = process.env.BEAM_STUDIO_API_URL;
  const previousFetch = globalThis.fetch;
  process.env.BEAM_STUDIO_API_URL = "https://studio.example/";
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify(
        calls.length === 1
          ? { membersByPartition: { participants: [{ memberId: "member_a" }] } }
          : {},
      ),
      { status: 200 },
    );
  };
  const pool = {
    async query() {
      return { rows: [{ authorization_token: "run-secret" }] };
    },
  } as unknown as PgPool;
  const artifact = {
    manifestId: "manifest",
    artifactId: "artifact",
    sha256: `sha256:${"a".repeat(64)}`,
    sizeBytes: 2,
    mediaType: "application/octet-stream",
    location: {
      kind: "member" as const,
      roomId: "room",
      channelId: "channel",
      sourceMemberId: "source",
      memberId: "member_a",
      transferId: "transfer",
    },
  };
  try {
    assert.deepEqual(await resolveFrozenV3RoomPg(pool, "run"), {
      membersByPartition: { participants: [{ memberId: "member_a" }] },
    });
    await authorizeV3ArtifactReadPg(pool, "run", "member_a", artifact);
    assert.equal(
      calls[0]?.url,
      "https://studio.example/internal/workflow-runs/run/v3-room-resolution",
    );
    assert.equal(calls[0]?.init.method, "GET");
    assert.equal(
      calls[1]?.url,
      "https://studio.example/internal/workflow-runs/run/v3-artifact-read",
    );
    assert.equal(calls[1]?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
      consumerMemberId: "member_a",
      artifact,
    });
    for (const call of calls)
      assert.equal(
        (call.init.headers as Record<string, string>).Authorization,
        "Bearer run-secret",
      );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.BEAM_STUDIO_API_URL;
    else process.env.BEAM_STUDIO_API_URL = previousUrl;
  }
});
