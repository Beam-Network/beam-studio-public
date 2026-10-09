import { randomUUID } from "node:crypto";
import {
  CreditReservationError,
  createCreditClient,
  type CreditClient,
  type MeterMeasure,
} from "./credit-client.js";

/**
 * A billable Studio action, the price-book profile it is charged under, and
 * which component charges it.
 *
 * `permission` is the scope the API key must hold. Before this, every billable
 * call was authorized as transfer creation, so a key restricted to transfers
 * could start rooms and run workflows too.
 *
 * `billedBy` says who moves the credits:
 *
 * - `studio` — Studio holds credit here and settles when the run ends. Used for
 *   work only Studio knows about, priced per invocation.
 * - `beamcore` — BeamCore bills it from the bytes actually moved, keyed on the
 *   transfer id. Studio only checks the key can pay and holds nothing, because
 *   a Studio-side charge would be a second charge for the same transfer under a
 *   different idempotency key, and Studio never learns the byte count anyway.
 */
export const BILLABLE_ACTIONS = {
  "transfer.create": {
    billingProfileId: "beam.transfer.v1",
    permission: "transfers:create",
    billedBy: "beamcore",
  },
  "transfer.run": {
    billingProfileId: "beam.transfer.v1",
    permission: "transfers:create",
    billedBy: "beamcore",
  },
  "workflow.run": {
    billingProfileId: "beam.workflow.v1",
    permission: "workflows:run",
    billedBy: "studio",
  },
  "room.start": {
    billingProfileId: "beam.room.v1",
    permission: "rooms:start",
    billedBy: "studio",
  },
} as const;

export type BillableAction = Exclude<keyof typeof BILLABLE_ACTIONS, "workflow.run">;

export class ActionNotBillableError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "ActionNotBillableError";
  }
}

export type ReserveActionInput = {
  action: BillableAction;
  /**
   * Studio's own id for the Beam API key this action is charged to. Required:
   * an organization may hold several keys with different caps and budgets, so
   * the caller must say which one pays.
   */
  apiKeyId: string | null | undefined;
  /** Organization that owns the stored credential. */
  organizationId?: string | null;
  /** Meters known up front. Volume meters are usually only known once the run ends. */
  usage?: MeterMeasure[];
  transferId?: string;
};

/** Resolves Studio's key id to the raw Beam API key it stores encrypted. */
export type ApiKeyResolver = (
  apiKeyId: string,
  organizationId?: string | null,
) => string | null | Promise<string | null>;

export async function defaultApiKeyResolver(
  apiKeyId: string,
  organizationId?: string | null,
) {
  const { getDecryptedApiKey } = await import("../studio/store.js");
  return getDecryptedApiKey(apiKeyId, organizationId);
}

export type ActionReservation = {
  /**
   * The hold to settle when the run ends, or null when this action is billed by
   * BeamCore and Studio only checked that the key could pay.
   */
  operationKey: string | null;
  creditsUsed: number;
  /** The key that took the hold; releasing it authenticates with the same key. */
  apiKeyId: string;
  organizationId: string | null;
};

/**
 * Reserve credit for a billable action.
 *
 * Reserving is the one blocking billing call on the path that starts a run;
 * settlement happens afterwards, off the run lifecycle, so credit accounting
 * never holds up progression.
 */
export async function reserveAction(
  input: ReserveActionInput,
  client: CreditClient = createCreditClient(),
  resolveApiKey: ApiKeyResolver = defaultApiKeyResolver,
): Promise<ActionReservation> {
  if (!input.apiKeyId) {
    throw new ActionNotBillableError(
      `A Beam API key must be selected before running this ${input.action.split(".")[0]}.`,
    );
  }

  // Studio keys carry Studio's own ids, which mean nothing to the Beam API, so
  // every call presents the stored secret itself.
  const rawApiKey = await resolveApiKey(input.apiKeyId, input.organizationId);
  if (!rawApiKey) {
    throw new ActionNotBillableError(
      "The selected Beam API key could not be read; re-enter it under Credentials.",
    );
  }

  const definition = BILLABLE_ACTIONS[input.action];
  const owner = {
    apiKeyId: input.apiKeyId,
    organizationId: input.organizationId ?? null,
  };

  // BeamCore charges this action from the bytes it actually moved. Holding
  // credit here as well would charge the same transfer twice under two
  // different idempotency keys, so verifying the key is the whole check:
  // verification refuses a key whose organization cannot pay.
  if (definition.billedBy === "beamcore") {
    await client.resolveKeyId(rawApiKey);
    return { operationKey: null, creditsUsed: 0, ...owner };
  }

  const operationKey = `${input.action}:${randomUUID()}`;

  // Beam prices the hold and checks the action's permission from the key.
  const reservation = await client.reserve(rawApiKey, {
    idempotencyKey: operationKey,
    action: input.action,
    transferId: input.transferId,
    usage: [
      { metric: "invocation", quantity: 1, unit: "count" },
      ...(input.usage ?? []),
    ],
  });

  return { operationKey, creditsUsed: reservation.creditsUsed, ...owner };
}

/**
 * Release a reservation for work that never started.
 *
 * A null operation key means the action is billed by BeamCore and Studio never
 * held anything, so there is nothing to release.
 */
export async function releaseReservation(
  reservation: ActionReservation,
  reason: string,
  client: CreditClient = createCreditClient(),
  resolveApiKey: ApiKeyResolver = defaultApiKeyResolver,
) {
  if (!reservation.operationKey) return;
  const rawApiKey = await resolveApiKey(
    reservation.apiKeyId,
    reservation.organizationId,
  );
  if (!rawApiKey)
    throw new CreditReservationError(
      "billing_unavailable",
      "The Beam API key that took this hold could not be read.",
      503,
    );
  await client.cancel(rawApiKey, reservation.operationKey, reason);
}

export { CreditReservationError };
