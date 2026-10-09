import assert from "node:assert/strict";
import test from "node:test";
import type { ActionManifest } from "@beam-studio/core";
import { roomWorkflowHost } from "./services/roomWorkflow.js";
import { withControlRecovery } from "./services/controlRecovery.js";
import {
  WorkflowAuthorizationError,
  WorkflowAuthorityUnavailableError,
} from "@beam-studio/db";
import { sandboxRpcMethodsForAction } from "@beam-studio/action-runtime";

const baseManifest = {
  name: "@beam/room-transfer",
  version: "2.0.0",
  apiVersion: "workflow-actions/v1",
  runtime: { placements: ["local-workers"] },
} satisfies ActionManifest;

test("room RPC permissions expose only their declared operations", () => {
  const manifest = {
    ...baseManifest,
    permissions: ["beam:room-status"],
  } satisfies ActionManifest;
  const methods = sandboxRpcMethodsForAction(manifest);
  assert.ok(methods.includes("beam.rooms.status"));
  assert.ok(!methods.includes("beam.rooms.publish"));
  assert.ok(!methods.includes("beam.rooms.cancel"));
});
test("two transient authority failures cannot lose the completed room result", async () => {
  const originalFetch = globalThis.fetch;
  const base = process.env.BEAM_STUDIO_API_URL;
  process.env.BEAM_STUDIO_API_URL = "http://127.0.0.1:8787";
  const requests: RequestInit[] = [];
  const deadlines: string[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(init!);
    assert.deepEqual(
      deadlines,
      [],
      "failed polls cannot extend the idle lease",
    );
    if (requests.length <= 2)
      return Response.json(
        {
          error: "Internal server error",
          retryable: true,
          code: "execution_authority_unavailable",
        },
        { status: 503 },
      );
    return Response.json({
      command: {
        id: "cmd",
        state: "completed",
        result: { status: { state: "completed", recipients: 3 } },
      },
    });
  };
  try {
    const host = roomWorkflowHost(
      { id: "task", claimToken: "claim" },
      { ...baseManifest, permissions: ["beam:room-status"] },
      AbortSignal.timeout(5_000),
      (deadline) => deadlines.push(deadline),
    );
    assert.deepEqual(await host.status(), {
      commandId: "cmd",
      status: { state: "completed", recipients: 3 },
    });
    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => request.body === requests[0]!.body));
    assert.deepEqual(deadlines, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (base === undefined) delete process.env.BEAM_STUDIO_API_URL;
    else process.env.BEAM_STUDIO_API_URL = base;
  }
});
test("uncertain command POST retries keep identity and bind the task claim", async () => {
  const originalFetch = globalThis.fetch,
    base = process.env.BEAM_STUDIO_API_URL;
  const requests: RequestInit[] = [];
  process.env.BEAM_STUDIO_API_URL = "http://127.0.0.1:8787";
  globalThis.fetch = async (_url, init) => {
    requests.push(init!);
    if (requests.length === 1) throw Error("ack lost");
    return Response.json({
      command: {
        id: "cmd",
        state: "completed",
        result: { transfer: { publication_id: "pub" } },
      },
    });
  };
  try {
    const host = roomWorkflowHost(
      { id: "task", claimToken: "claim" },
      { ...baseManifest, permissions: ["beam:room-publish"] },
      new AbortController().signal,
    );
    const result = await host.publish();
    assert.deepEqual(result, {
      commandId: "cmd",
      transfer: { publication_id: "pub" },
    });
    assert.equal(requests[0]!.body, requests[1]!.body);
    assert.equal(
      (requests[0]!.headers as Record<string, string>).Authorization,
      "Bearer claim",
    );
    assert.deepEqual(
      Object.keys(JSON.parse(String(requests[0]!.body))).sort(),
      ["operation", "requestId"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (base === undefined) delete process.env.BEAM_STUDIO_API_URL;
    else process.env.BEAM_STUDIO_API_URL = base;
  }
});

test("room command identity is stable across worker task attempts", async () => {
  const originalFetch = globalThis.fetch,
    base = process.env.BEAM_STUDIO_API_URL;
  const bodies: string[] = [];
  process.env.BEAM_STUDIO_API_URL = "http://127.0.0.1:8787";
  globalThis.fetch = async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({
      command: {
        id: "cmd",
        state: "completed",
        result: { transfer: { publication_id: "pub" } },
      },
    });
  };
  try {
    const task = { id: "wftask_room_attempt", claimToken: "claim" };
    const manifest = {
      ...baseManifest,
      permissions: ["beam:room-publish"],
    } satisfies ActionManifest;
    await roomWorkflowHost(
      task,
      manifest,
      new AbortController().signal,
    ).publish();
    await roomWorkflowHost(
      task,
      manifest,
      new AbortController().signal,
    ).publish();
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.deepEqual(JSON.parse(bodies[0]!), {
      operation: "publish",
      requestId: "wftask_room_attempt-publish",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (base === undefined) delete process.env.BEAM_STUDIO_API_URL;
    else process.env.BEAM_STUDIO_API_URL = base;
  }
});

test("only the API's trusted status lease notifies the worker timer", async () => {
  const originalFetch = globalThis.fetch;
  const base = process.env.BEAM_STUDIO_API_URL;
  process.env.BEAM_STUDIO_API_URL = "http://127.0.0.1:8787";
  const deadlines: string[] = [];
  const deadline = new Date(Date.now() + 300_000).toISOString();
  globalThis.fetch = async () =>
    Response.json({
      command: {
        id: "publication",
        state: "completed",
        result: {
          status: { publisher: { room_transfer: { status: "in_progress" } } },
          trustedIdleExpiresAt: deadline,
        },
      },
    });
  try {
    const host = roomWorkflowHost(
      { id: "task", claimToken: "claim" },
      {
        ...baseManifest,
        permissions: ["beam:room-status", "beam:room-publish"],
      },
      new AbortController().signal,
      (value) => deadlines.push(value),
    );
    await host.status();
    assert.deepEqual(deadlines, [deadline]);
    await host.publish();
    assert.deepEqual(deadlines, [deadline]);
  } finally {
    globalThis.fetch = originalFetch;
    if (base === undefined) delete process.env.BEAM_STUDIO_API_URL;
    else process.env.BEAM_STUDIO_API_URL = base;
  }
});

test("pending acknowledgement recovery keeps the command and renews only on a successful status", async () => {
  const originalFetch = globalThis.fetch;
  const base = process.env.BEAM_STUDIO_API_URL;
  process.env.BEAM_STUDIO_API_URL = "http://127.0.0.1:8787";
  const requests: Array<{ path: string; method: string }> = [];
  const deadlines: string[] = [];
  const deadline = new Date(Date.now() + 300_000).toISOString();
  globalThis.fetch = async (url, init) => {
    requests.push({
      path: new URL(String(url)).pathname,
      method: init!.method!,
    });
    assert.deepEqual(deadlines, []);
    if (requests.length === 1)
      return Response.json({ command: { id: "cmd", state: "pending" } });
    if (requests.length < 4)
      return new Response("unavailable", { status: 503 });
    return Response.json({
      command: {
        id: "cmd",
        state: "completed",
        result: { trustedIdleExpiresAt: deadline },
      },
    });
  };
  try {
    await roomWorkflowHost(
      { id: "task", claimToken: "claim" },
      { ...baseManifest, permissions: ["beam:room-status"] },
      AbortSignal.timeout(5_000),
      (value) => deadlines.push(value),
    ).status();
    assert.deepEqual(deadlines, [deadline]);
    assert.equal(
      requests.filter((request) => request.method === "POST").length,
      1,
    );
    assert.ok(
      requests
        .slice(1)
        .every(
          (request) =>
            request.path.endsWith("/room-command/cmd") &&
            request.method === "GET",
        ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (base === undefined) delete process.env.BEAM_STUDIO_API_URL;
    else process.env.BEAM_STUDIO_API_URL = base;
  }
});

test("explicit HTTP denial never retries or discloses unrestricted error text", async () => {
  const originalFetch = globalThis.fetch;
  const base = process.env.BEAM_STUDIO_API_URL;
  process.env.BEAM_STUDIO_API_URL = "http://127.0.0.1:8787";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(
      {
        error: "Bearer secret-value",
        code: "execution_target_revoked",
        retryable: true,
      },
      { status: 403 },
    );
  };
  try {
    await assert.rejects(
      roomWorkflowHost(
        { id: "task", claimToken: "claim" },
        { ...baseManifest, permissions: ["beam:room-status"] },
        new AbortController().signal,
      ).status(),
      (error: any) => {
        assert.equal(error.retryable, false);
        assert.match(error.message, /HTTP 403; execution_target_revoked/);
        assert.doesNotMatch(error.message, /Bearer|secret-value/);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (base === undefined) delete process.env.BEAM_STUDIO_API_URL;
    else process.env.BEAM_STUDIO_API_URL = base;
  }
});

test("room completion authority recovery requires fresh authorization and stops on denial", async () => {
  let calls = 0;
  const retryable = (error: unknown) =>
    error instanceof WorkflowAuthorityUnavailableError;
  const result = await withControlRecovery(
    async () => {
      if (++calls < 3) throw new WorkflowAuthorityUnavailableError();
      return "freshly-authorized";
    },
    AbortSignal.timeout(5_000),
    retryable,
  );
  assert.equal(result, "freshly-authorized");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    withControlRecovery(
      async () => {
        calls++;
        throw new WorkflowAuthorizationError("execution_target_revoked");
      },
      new AbortController().signal,
      retryable,
    ),
    /execution_target_revoked/,
  );
  assert.equal(calls, 1);
});

test("room control recovery stops at cancellation or lease expiry without another request", async () => {
  for (const reason of ["cancelled", "idle expired", "claim lost"]) {
    const controller = new AbortController();
    let calls = 0;
    const timer = setTimeout(() => controller.abort(new Error(reason)), 40);
    try {
      await assert.rejects(
        withControlRecovery(
          async () => {
            calls++;
            throw new WorkflowAuthorityUnavailableError();
          },
          controller.signal,
          (error) => error instanceof WorkflowAuthorityUnavailableError,
        ),
      );
      assert.equal(calls, 1);
      assert.equal(controller.signal.reason.message, reason);
    } finally {
      clearTimeout(timer);
    }
  }
  const controller = new AbortController();
  await assert.rejects(
    withControlRecovery(
      async () => {
        controller.abort(new Error("revoked during request"));
        return "must not commit";
      },
      controller.signal,
      () => true,
    ),
    /revoked during request/,
  );
});

test("room cancellation cleanup remains usable after the task is aborted", async () => {
  const originalFetch = globalThis.fetch;
  const base = process.env.BEAM_STUDIO_API_URL;
  process.env.BEAM_STUDIO_API_URL = "http://127.0.0.1:8787";
  globalThis.fetch = async (_url, init) => {
    assert.equal(init!.signal!.aborted, false);
    return Response.json({ command: { id: "cancel", state: "completed" } });
  };
  try {
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(
      await roomWorkflowHost(
        { id: "task", claimToken: "claim" },
        { ...baseManifest, permissions: ["beam:room-cancel"] },
        controller.signal,
      ).cancel(),
      { commandId: "cancel" },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (base === undefined) delete process.env.BEAM_STUDIO_API_URL;
    else process.env.BEAM_STUDIO_API_URL = base;
  }
});
