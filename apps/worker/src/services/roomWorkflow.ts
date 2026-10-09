import { setTimeout as delay } from "node:timers/promises";
import {
  ActionExecutionError,
  type ActionManifest,
} from "@beam-studio/core";
import { assertActionPermission } from "@beam-studio/action-runtime";
import { withControlRecovery } from "./controlRecovery.js";

export function roomWorkflowHost(
  task: { id: string; claimToken: string },
  manifest: ActionManifest,
  signal: AbortSignal,
  onTrustedIdleDeadline?: (deadline: string) => void,
) {
  async function command(operation: "publish" | "status" | "cancel") {
    assertActionPermission(manifest, `beam:room-${operation}`);
    const base = process.env.BEAM_STUDIO_API_URL?.trim();
    if (!base)
      throw new ActionExecutionError(
        "BEAM_STUDIO_API_URL is required for room workflows.",
        { retryable: false },
      );
    const path = `/internal/workflow-tasks/${encodeURIComponent(task.id)}/room-command`;
    const requestId = `${task.id}-${operation}`;
    // Cancellation has its own bounded cleanup window after the task is aborted.
    // All other recovery is fenced by the unchanged task/idle/cancellation signal.
    const commandSignal =
      operation === "cancel" ? AbortSignal.timeout(20_000) : signal;
    const target = new URL(path, base);
    async function request(
      pathname: string,
      requestSignal: AbortSignal,
      body?: unknown,
    ) {
      let response: Response;
      try {
        response = await fetch(new URL(pathname, target), {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${task.claimToken}`,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.any([
            requestSignal,
            AbortSignal.timeout(operation === "cancel" ? 5_000 : 15_000),
          ]),
          redirect: "error",
        });
      } catch {
        requestSignal.throwIfAborted();
        throw new ActionExecutionError(
          `Room ${operation} control transport is temporarily unavailable.`,
        );
      }
      const result = (await response.json().catch(() => null)) as Record<
        string,
        any
      > | null;
      if (!response.ok)
        throw new ActionExecutionError(
          `Room ${operation} control request failed (HTTP ${response.status}${typeof result?.code === "string" && /^execution_[a-z_]{1,64}$/.test(result.code) ? `; ${result.code}` : ""}).`,
          {
            retryable:
              (response.status === 408 ||
                response.status === 429 ||
                response.status >= 500) &&
              result?.retryable !== false,
          },
        );
      if (
        !result?.command ||
        typeof result.command.id !== "string" ||
        typeof result.command.state !== "string"
      )
        throw new ActionExecutionError(
          "Room control returned an invalid command acknowledgement.",
          { retryable: false },
        );
      return result.command as {
        id: string;
        state: string;
        result?: Record<string, any>;
        error?: Record<string, any>;
      };
    }
    const retryable = (error: unknown) =>
      error instanceof ActionExecutionError && error.retryable;
    // Re-submit uncertain requests serially with the same identity and live claim.
    let current = await withControlRecovery(
      () => request(path, commandSignal, { operation, requestId }),
      commandSignal,
      retryable,
    );
    const acknowledgementSignal = AbortSignal.any([
      commandSignal,
      AbortSignal.timeout(65_000),
    ]);
    while (
      !["completed", "failed", "cancelled", "expired"].includes(current.state)
    ) {
      await delay(500, undefined, { signal: acknowledgementSignal });
      current = await withControlRecovery(
        () =>
          request(
            `${path}/${encodeURIComponent(current.id)}`,
            acknowledgementSignal,
          ),
        acknowledgementSignal,
        retryable,
      );
    }
    if (current.state !== "completed")
      throw new ActionExecutionError(
        String(
          current.error?.message ??
            `Room ${operation} command ${current.state}.`,
        ),
        {
          retryable:
            current.error?.retryable === true || current.state === "expired",
        },
      );
    if (
      operation === "status" &&
      typeof current.result?.trustedIdleExpiresAt === "string"
    )
      onTrustedIdleDeadline?.(current.result.trustedIdleExpiresAt);
    return { commandId: current.id, ...current.result };
  }
  return {
    publish: () => command("publish"),
    status: () => command("status"),
    cancel: () => command("cancel"),
  };
}
