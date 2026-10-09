import type { InstanceSnapshot } from "@beam-studio/db";

/**
 * Which organization the deployment's own Studio room consumer enrolls for.
 *
 * A self-hosted release runs one consumer next to the API (the `room-consumer`
 * Compose service). It enrolls for the organization that owns the instance,
 * so nobody has to copy an organization ID into `.env`. The hosted deployment
 * keeps its explicit `BEAM_STUDIO_CONSUMER_ORGANIZATION_ID`, which wins.
 *
 * Every refusal here is temporary: the consumer retries a 503 with backoff, so
 * it enrolls on its own once the instance is claimed and the organization has
 * a Beam API key.
 */

export type ConsumerInstanceReader = () => Promise<
  Pick<InstanceSnapshot, "state" | "ownerOrganizationId">
>;

export type ConsumerBootstrapRefusal = {
  ok: false;
  code:
    | "consumer_bootstrap_unavailable"
    | "instance_unclaimed"
    | "room_authority_key_unavailable";
  error: string;
};

export type ConsumerOrganization =
  | { ok: true; organizationId: string; source: "configured" | "owner" }
  | ConsumerBootstrapRefusal;

export function consumerSharedSecret() {
  return process.env.BEAM_STUDIO_SHARED_SECRET?.trim() ?? "";
}

export async function resolveConsumerOrganization(input: {
  configured?: string | null;
  instance?: ConsumerInstanceReader | null;
}): Promise<ConsumerOrganization> {
  const configured = input.configured?.trim();
  if (configured) {
    return { ok: true, organizationId: configured, source: "configured" };
  }
  if (!input.instance) {
    return {
      ok: false,
      code: "consumer_bootstrap_unavailable",
      error: "Studio consumer bootstrap is not configured.",
    };
  }
  const instance = await input.instance();
  const owner = instance.ownerOrganizationId?.trim();
  if (!owner) {
    // Unclaimed, or adopted from before instance ownership existed. Either
    // way nobody owns it yet, and claiming it is what gives it an owner.
    return {
      ok: false,
      code: "instance_unclaimed",
      error:
        "This Studio has no owner organization yet. Claim it under Settings → Access; the room consumer enrolls once it is claimed.",
    };
  }
  return { ok: true, organizationId: owner, source: "owner" };
}
