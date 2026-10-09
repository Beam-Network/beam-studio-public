import type { FastifyInstance, FastifyRequest } from "fastify";
import { auth } from "../auth/policy.js";
import { studioRequestSession } from "../auth/request-context.js";
import {
  authorizeUpdateOperation,
  updateCapabilities,
  updateModeFromEnv,
  type UpdateMode,
  type UpdateOperation,
} from "./update-policy.js";
import { createUpdaterClient, type UpdaterClient } from "./updater-client.js";

/**
 * Beam Studio self-update, proxied from the authenticated Studio API to the
 * host updater's Unix socket. Unrelated to Registry package updates.
 */
export function registerUpdateRoutes(
  server: FastifyInstance,
  options: {
    mode?: UpdateMode;
    updater?: UpdaterClient;
    installedVersion?: string | null;
  } = {},
) {
  const mode = options.mode ?? updateModeFromEnv();
  const updater = options.updater ?? createUpdaterClient();
  const installedVersion =
    options.installedVersion !== undefined
      ? options.installedVersion
      : installedVersionFromEnv();
  const capabilities = updateCapabilities(mode);

  const authorize = (request: FastifyRequest, operation: UpdateOperation) => {
    const decision = authorizeUpdateOperation({
      mode,
      operation,
      session: studioRequestSession(request),
    });
    if (!decision.allowed) {
      throw Object.assign(new Error(decision.reason), {
        code: decision.code,
        statusCode: decision.statusCode,
      });
    }
  };

  // Installation-wide routes: about the host rather than a tenant, so they
  // belong to whoever owns the installation. They used to take any signed-in
  // account, which meant a stranger who could reach the URL could redeploy
  // someone else's stack.
  const installation = { config: { auth: auth.instanceAdmin() } };

  server.get("/studio/updates/status", installation, async (request) => {
    authorize(request, "status");
    const status = await updater.status();
    return {
      mode,
      canApply: capabilities.canApply,
      installedVersion: status.currentVersion ?? installedVersion,
      status,
    };
  });

  server.get("/studio/updates/check", installation, async (request) => {
    authorize(request, "check");
    const check = await updater.check();
    return {
      mode,
      channel: check.channel,
      installedVersion: check.currentVersion ?? installedVersion,
      availableVersion: check.latestVersion,
      updateAvailable: check.updateAvailable,
      canApply: capabilities.canApply && check.updateAvailable,
      publishedAt: check.publishedAt,
      releaseNotesUrl: check.releaseNotesUrl,
      requiresBackup: check.requiresBackup,
    };
  });

  server.post<{ Body: { confirm?: unknown } | undefined }>(
    "/studio/updates/apply",
    installation,
    async (request, reply) => {
      authorize(request, "apply");
      // Installing replaces the running stack, so it is never implicit: the
      // caller must state the confirmation the UI collected.
      if (request.body?.confirm !== true) {
        return reply.code(400).send({
          code: "update_confirmation_required",
          error: "Confirm the update explicitly before installing it.",
        });
      }
      // Re-check server-side so a stale page cannot reinstall the current release.
      const check = await updater.check();
      if (!check.updateAvailable) {
        return reply.code(409).send({
          code: "update_not_available",
          error: `Beam Studio is already up to date on the ${check.channel} channel.`,
        });
      }
      const result = await updater.apply();
      return reply.code(202).send({
        accepted: true,
        operationId: result.operationId,
        targetVersion: check.latestVersion,
      });
    },
  );
}

function installedVersionFromEnv() {
  const version = process.env.BEAM_STUDIO_VERSION?.trim();
  // The Compose template placeholder is left verbatim outside rendered releases.
  return version && !version.startsWith("@") ? version : null;
}
