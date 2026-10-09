import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  withPostgresTransaction,
  type PgPool,
} from "@beam-studio/db";
import { instanceClaimCodeMatches } from "@beam-studio/shared/instance-claim";
import { auth } from "../auth/policy.js";
import { StudioValidationError } from "./validation-error.js";
import type { InstanceAdmission } from "../auth/instance-admission.js";
import {
  studioRequestAuth,
  studioRequestSession,
} from "../auth/request-context.js";
import {
  claimInstance,
  listInstanceOrganizations,
  readInstance,
  releaseInstance,
  setJoinPolicy,
  transferInstanceOwnership,
  upsertInstanceOrganization,
  type JoinPolicy,
} from "./repositories/instance-access-repository.js";
import type { InstanceKeyService } from "./instance-key.js";

type Organization = { id: string; name?: string | null; role?: string | null };

const JOIN_POLICIES: readonly JoinPolicy[] = ["open", "request", "closed"];

function denied(code: string, statusCode: number, message: string) {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * The organizations Beam says belong to the caller.
 *
 * Routes on the claim funnel skip the kernel's organization check, so they
 * cannot assume anything has been verified and ask Beam themselves. Without
 * this a caller could claim an instance for an organization they have nothing
 * to do with, simply by naming it.
 */
async function callerOrganizations(request: FastifyRequest) {
  const payload = await studioRequestAuth(request).beamApi.getJson<{
    organizations?: Organization[];
  }>("/api/organizations");
  return payload.organizations ?? [];
}

export function registerInstanceAccessRoutes(
  server: FastifyInstance,
  options: {
    pgPool: PgPool;
    admission: InstanceAdmission;
    instanceKeys: InstanceKeyService;
    instanceKeysEnabled: boolean;
  },
) {
  const { pgPool, admission, instanceKeys, instanceKeysEnabled } = options;

  /**
   * Whether the caller may administer this deployment.
   *
   * Two conditions, both from data already in hand: the selected organization
   * owns the instance, and Beam says the caller is not a read-only member of
   * it. The second reuses the rule the kernel applies to every other mutating
   * route rather than inventing a second notion of who may write.
   */
  async function requireOwner(request: FastifyRequest) {
    const instance = await readInstance(pgPool);
    if (instance.state !== "claimed" || !instance.ownerOrganizationId) {
      // Includes an adopted instance: it has members but no owner, and until
      // someone claims it there is nobody with standing to decide for it.
      throw denied(
        "instance_unclaimed",
        409,
        "This Studio has no owner yet. Claim it before changing who may use it.",
      );
    }
    const organizations = await callerOrganizations(request);
    const owner = organizations.find(
      (item) => item.id === instance.ownerOrganizationId,
    );
    if (!owner) {
      throw denied(
        "instance_admin_required",
        403,
        "Only the organization that owns this Studio can change who may use it.",
      );
    }
    if (owner.role === "viewer" || owner.role === "read_only") {
      throw denied(
        "organization_read_only",
        403,
        "Your role in the owning organization is read-only.",
      );
    }
    return instance;
  }

  server.get(
    "/studio/instance/access",
    { config: { auth: auth.claimFunnel() } },
    async (request) => {
      const instance = await readInstance(pgPool);
      const session = studioRequestSession(request);
      const organizations = await callerOrganizations(request);
      const owned = Boolean(
        instance.ownerOrganizationId &&
          organizations.some(
            (item) => item.id === instance.ownerOrganizationId,
          ),
      );

      // Studio never learns organization names: both write paths store the id
      // in the name column. Beam knows them, but /api/organizations answers for
      // the caller's own memberships only, so a name is resolvable for the
      // organizations this viewer belongs to and for no others. The page says
      // so by falling back to the id rather than inventing a placeholder.
      const names = new Map(
        organizations.map((item) => [item.id, item.name ?? null]),
      );
      const nameOf = (organizationId: string | null) =>
        (organizationId && names.get(organizationId)) || null;

      // Only the owner learns whether the installation holds its key.
      const instanceKey =
        owned && instance.ownerOrganizationId && instanceKeysEnabled
          ? await instanceKeys.status(instance.ownerOrganizationId)
          : null;

      return {
        instanceKey: !owned
          ? null
          : !instanceKeysEnabled
            ? { status: "disabled" as const }
            : instanceKey
              ? {
                  status: "active" as const,
                  credentialId: instanceKey.credentialId,
                  name: instanceKey.name,
                  prefix: instanceKey.prefix,
                  createdAt: instanceKey.createdAt,
                  updatedAt: instanceKey.updatedAt,
                }
              : { status: "missing" as const },
        instance: {
          state: instance.state,
          joinPolicy: instance.joinPolicy,
          ownerOrganizationId: instance.ownerOrganizationId,
          ownerOrganizationName: nameOf(instance.ownerOrganizationId),
          claimedAt: instance.claimedAt,
          claimedByEmail: instance.claimedByEmail,
        },
        viewer: {
          userId: session?.userId ?? null,
          isOwner: owned,
          // The claimant picks from their own memberships; an unclaimed
          // instance has no other way to learn who is installing it.
          organizations: organizations.map((item) => ({
            id: item.id,
            name: item.name ?? item.id,
            role: item.role ?? null,
          })),
        },
        // Only an administrator sees who else is admitted. To everyone else
        // this endpoint answers "private", and nothing about the tenants.
        organizations: owned
          ? (await listInstanceOrganizations(pgPool)).map((entry) => ({
              ...entry,
              name: nameOf(entry.organizationId),
            }))
          : [],
      };
    },
  );

  server.post(
    "/studio/instance/claim",
    { config: { auth: auth.claimFunnel() } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const organizationId = String(body.organizationId ?? "").trim();
      const claimCode = String(body.claimCode ?? "").trim();
      if (!organizationId) {
        throw new StudioValidationError(
          "organization_required",
          "Choose which organization owns this Studio.",
        );
      }

      const instance = await readInstance(pgPool);
      if (instance.state === "claimed") {
        throw denied(
          "instance_already_claimed",
          409,
          "This Studio already has an owner.",
        );
      }

      // Checked before the code, so a caller naming an organization that is
      // not theirs is refused on that ground rather than being told whether
      // their code was right.
      const organizations = await callerOrganizations(request);
      if (!organizations.some((item) => item.id === organizationId)) {
        throw denied(
          "organization_forbidden",
          403,
          "That organization is not one of yours.",
        );
      }

      // An adopted instance was already serving this organization before
      // ownership existed, so claiming it grants nothing its members did not
      // already have, and demanding a code from an operator who never had one
      // generated would strand them. A fresh installation always needs it.
      const alreadyServed =
        instance.state === "adopted" &&
        (await admission.check(organizationId)).outcome === "admitted";
      if (!alreadyServed && !instanceClaimCodeMatches(claimCode)) {
        throw denied(
          "claim_code_invalid",
          403,
          "That claim code does not match this installation.",
        );
      }

      const session = studioRequestSession(request);
      const won = await claimInstance(pgPool, {
        organizationId,
        userId: session?.userId ?? null,
        email: session?.email ?? null,
      });
      if (!won) {
        // Another caller claimed it between the read above and this write.
        throw denied(
          "instance_already_claimed",
          409,
          "This Studio already has an owner.",
        );
      }
      admission.forget();
      reply.code(201);
      return { claimed: true, ownerOrganizationId: organizationId };
    },
  );

  server.patch(
    "/studio/instance/access",
    { config: { auth: auth.instanceAdmin() } },
    async (request) => {
      await requireOwner(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const joinPolicy = String(body.joinPolicy ?? "") as JoinPolicy;
      if (!JOIN_POLICIES.includes(joinPolicy)) {
        throw new StudioValidationError(
          "join_policy_invalid",
          "Choose open, request or closed.",
        );
      }
      await setJoinPolicy(pgPool, joinPolicy);
      admission.forget();
      return { joinPolicy };
    },
  );

  server.post(
    "/studio/instance/access/organizations",
    { config: { auth: auth.instanceAdmin() } },
    async (request) => {
      await requireOwner(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const organizationId = String(body.organizationId ?? "").trim();
      if (!organizationId) {
        throw new StudioValidationError(
          "organization_required",
          "Name the organization to admit.",
        );
      }
      const session = studioRequestSession(request);
      await upsertInstanceOrganization(pgPool, {
        organizationId,
        status: "admitted",
        decidedByUserId: session?.userId ?? null,
        decidedByEmail: session?.email ?? null,
      });
      admission.forget(organizationId);
      return { organizationId, status: "admitted" };
    },
  );

  server.post(
    "/studio/instance/access/organizations/:organizationId/revoke",
    { config: { auth: auth.instanceAdmin() } },
    async (request) => {
      const instance = await requireOwner(request);
      const { organizationId } = request.params as { organizationId: string };
      if (organizationId === instance.ownerOrganizationId) {
        // Without this the UI can lock every administrator out of the
        // deployment it administers, with no way back except the environment
        // lever or a psql session.
        throw denied(
          "instance_owner_cannot_be_revoked",
          409,
          "The owning organization cannot remove its own access. Transfer ownership first.",
        );
      }
      const session = studioRequestSession(request);
      await upsertInstanceOrganization(pgPool, {
        organizationId,
        status: "revoked",
        decidedByUserId: session?.userId ?? null,
        decidedByEmail: session?.email ?? null,
      });
      admission.forget(organizationId);
      return { organizationId, status: "revoked" };
    },
  );

  server.post(
    "/studio/instance/access/transfer",
    { config: { auth: auth.instanceAdmin() } },
    async (request) => {
      const instance = await requireOwner(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const organizationId = String(body.organizationId ?? "").trim();
      if (!organizationId || organizationId === instance.ownerOrganizationId) {
        throw new StudioValidationError(
          "organization_required",
          "Name a different organization to transfer ownership to.",
        );
      }
      const session = studioRequestSession(request);
      // The old owner's instance key goes first: it would otherwise stay live,
      // charging an organization that no longer owns this installation. A
      // failure stops the transfer, so nothing is left half-done.
      await instanceKeys.revoke(instance.ownerOrganizationId!);
      // Demote, then promote, in one transaction: the same code the
      // BEAM_STUDIO_OWNER_ORGANIZATION_ID recovery lever runs.
      await withPostgresTransaction(pgPool, (client) =>
        transferInstanceOwnership(client, {
          organizationId,
          decidedByUserId: session?.userId ?? null,
          decidedByEmail: session?.email ?? null,
        }),
      );
      admission.forget();
      return { ownerOrganizationId: organizationId };
    },
  );

  /**
   * Starts the owner's consent for the instance key at Beam Auth, which also
   * rotates an existing key. Always an explicit request from the owner:
   * nothing mints a key on its own.
   */
  server.post(
    "/studio/instance/key",
    { config: { auth: auth.instanceAdmin() } },
    async (request, reply) => {
      const instance = await requireOwner(request);
      if (!instanceKeysEnabled) {
        throw denied(
          "instance_key_disabled",
          403,
          "This Studio runs on the Beam keys stored under Credentials and does not hold an instance key.",
        );
      }
      if (!instance.instanceId) {
        throw denied(
          "instance_id_missing",
          503,
          "This installation has no instance id yet. Restart Studio so its database is up to date.",
        );
      }
      const accessToken =
        await studioRequestAuth(request).oauth.getAccessToken();
      const started = await instanceKeys.start({
        accessToken,
        organizationId: instance.ownerOrganizationId!,
        instanceId: instance.instanceId,
        instanceName: instanceName(request),
        userId: studioRequestSession(request)?.userId ?? null,
      });
      reply.code(201);
      return started;
    },
  );

  server.post(
    "/studio/instance/key/poll",
    { config: { auth: auth.instanceAdmin() } },
    async (request) => {
      const instance = await requireOwner(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      return instanceKeys.poll(String(body.attemptId ?? "").trim(), {
        organizationId: instance.ownerOrganizationId!,
        userId: studioRequestSession(request)?.userId ?? null,
      });
    },
  );

  server.delete(
    "/studio/instance/key",
    { config: { auth: auth.instanceAdmin() } },
    async (request) => {
      const instance = await requireOwner(request);
      return instanceKeys.revoke(instance.ownerOrganizationId!);
    },
  );

  /**
   * Unclaims the installation: revokes its instance key at Beam, then leaves
   * it unowned and serving nobody until it is claimed again.
   */
  server.post(
    "/studio/instance/release",
    { config: { auth: auth.instanceAdmin() } },
    async (request) => {
      const instance = await requireOwner(request);
      await instanceKeys.revoke(instance.ownerOrganizationId!);
      await withPostgresTransaction(pgPool, (client) =>
        releaseInstance(client),
      );
      admission.forget();
      return { released: true };
    },
  );
}

/**
 * The label Beam gives the key ("Studio: <name>"): the host the owner reaches
 * this installation at, as their browser sent it.
 */
function instanceName(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (typeof origin === "string") {
    try {
      return new URL(origin).host;
    } catch {
      // Fall through to the Host header.
    }
  }
  return request.headers.host ?? "Beam Studio";
}
