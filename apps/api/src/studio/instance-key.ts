import { randomUUID } from "node:crypto";
import {
  createInstanceKeyClient,
  InstanceKeyError,
  type InstanceKeyClient,
  type InstanceKeyConsent,
} from "./instance-key-client.js";
import {
  instanceKeySecret,
  markInstanceKeyRevoked,
  readInstanceKeyCredential,
  storeInstanceKeyCredential,
  type InstanceKeyCredential,
} from "./store.js";

const SLOW_DOWN_SECONDS = 5;
const MAX_ATTEMPTS = 20;

/** Where the instance key is kept. Injected so tests need no database. */
export type InstanceKeyStore = {
  read(organizationId: string): Promise<InstanceKeyCredential | null>;
  store(input: {
    organizationId: string;
    beamKeyId: string;
    name: string;
    secret: string;
  }): Promise<{ credentialId: string; rotated: boolean }>;
  secret(
    organizationId: string,
  ): Promise<{ credentialId: string; secret: string } | null>;
  markRevoked(organizationId: string): Promise<boolean>;
};

export const credentialInstanceKeyStore: InstanceKeyStore = {
  read: (organizationId) => readInstanceKeyCredential(organizationId),
  store: storeInstanceKeyCredential,
  secret: instanceKeySecret,
  markRevoked: (organizationId) => markInstanceKeyRevoked(organizationId),
};

export type InstanceKeyConsentStart = {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type InstanceKeyPollResult =
  | { status: "authorization_pending"; interval: number; expiresIn: number }
  | {
      status: "connected";
      key: InstanceKeyCredential | null;
      rotated: boolean;
    };

type Attempt = {
  consent: InstanceKeyConsent;
  organizationId: string;
  instanceId: string;
  instanceName: string;
  /** Only the owner who started the consent may finish it. */
  userId: string | null;
  expiresAt: number;
  interval: number;
};

export class InstanceKeyService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly polls = new Map<string, Promise<InstanceKeyPollResult>>();

  constructor(
    private readonly deps: {
      client: InstanceKeyClient;
      store: InstanceKeyStore;
      now: () => number;
    },
  ) {}

  status(organizationId: string) {
    return this.deps.store.read(organizationId);
  }

  async start(input: {
    accessToken: string;
    organizationId: string;
    instanceId: string;
    instanceName: string;
    userId: string | null;
  }): Promise<InstanceKeyConsentStart> {
    this.prune();
    const consent = await this.deps.client.startConsent(input);
    const attemptId = randomUUID();
    this.attempts.set(attemptId, {
      consent,
      organizationId: input.organizationId,
      instanceId: input.instanceId,
      instanceName: input.instanceName,
      userId: input.userId,
      expiresAt: this.deps.now() + consent.expiresIn * 1_000,
      interval: consent.interval,
    });
    return {
      attemptId,
      userCode: consent.userCode,
      verificationUri: consent.verificationUri,
      verificationUriComplete: consent.verificationUriComplete,
      expiresIn: consent.expiresIn,
      interval: consent.interval,
    };
  }

  /** One request to Beam at a time per attempt, however often the page polls. */
  poll(
    attemptId: string,
    input: { organizationId: string; userId: string | null },
  ): Promise<InstanceKeyPollResult> {
    const existing = this.polls.get(attemptId);
    if (existing) return existing;
    const pending = this.performPoll(attemptId, input).finally(() =>
      this.polls.delete(attemptId),
    );
    this.polls.set(attemptId, pending);
    return pending;
  }

  cancel(attemptId: string) {
    this.attempts.delete(attemptId);
  }

  /**
   * Revokes the organization's instance key at Beam, then marks it revoked
   * here. Beam first: marking it revoked locally while it stays live at Beam
   * would leave a working key nobody can see from Studio.
   */
  async revoke(organizationId: string) {
    const current = await this.deps.store.secret(organizationId);
    if (!current) return { revoked: false };
    await this.deps.client.revokeKey(current.secret);
    await this.deps.store.markRevoked(organizationId);
    return { revoked: true };
  }

  private async performPoll(
    attemptId: string,
    input: { organizationId: string; userId: string | null },
  ): Promise<InstanceKeyPollResult> {
    const attempt = this.attempts.get(attemptId);
    if (
      !attempt ||
      attempt.organizationId !== input.organizationId ||
      attempt.userId !== input.userId
    ) {
      throw new InstanceKeyError(
        "instance_key_attempt_not_found",
        "This approval is no longer active. Start again.",
        404,
      );
    }
    const remaining = Math.ceil((attempt.expiresAt - this.deps.now()) / 1_000);
    if (remaining <= 0) {
      this.attempts.delete(attemptId);
      throw new InstanceKeyError(
        "expired_token",
        "The approval code expired. Start again.",
        400,
      );
    }

    let polled;
    try {
      polled = await this.deps.client.pollConsent(attempt.consent.deviceCode);
    } catch (error) {
      if (!(error instanceof InstanceKeyError) || !error.retryable) {
        this.attempts.delete(attemptId);
      }
      throw consentError(error);
    }
    if (polled.status === "slow_down") {
      attempt.interval += SLOW_DOWN_SECONDS;
    }
    if (polled.status !== "approved") {
      return {
        status: "authorization_pending",
        interval: attempt.interval,
        expiresIn: remaining,
      };
    }

    // The grant is single-use: whatever happens next, this attempt is over.
    this.attempts.delete(attemptId);
    const minted = await this.deps.client
      .mintKey({
        grant: polled.grant,
        instanceId: attempt.instanceId,
        instanceName: attempt.instanceName,
      })
      .catch((error: unknown) => {
        throw consentError(error);
      });
    if (
      minted.apiKey.organizationId !== attempt.organizationId ||
      minted.apiKey.studioInstanceId !== attempt.instanceId
    ) {
      // Never store a key for another organization or installation. Revoke it
      // with itself so it does not stay live unseen.
      await this.deps.client.revokeKey(minted.secret).catch(() => undefined);
      throw new InstanceKeyError(
        "instance_key_mismatch",
        "Beam returned a key for another organization or Studio. It was revoked; nothing was stored.",
        502,
      );
    }
    const stored = await this.deps.store.store({
      organizationId: attempt.organizationId,
      beamKeyId: minted.apiKey.id,
      name: minted.apiKey.name,
      secret: minted.secret,
    });
    return {
      status: "connected",
      key: await this.deps.store.read(attempt.organizationId),
      rotated: stored.rotated,
    };
  }

  private prune() {
    const now = this.deps.now();
    for (const [id, attempt] of this.attempts) {
      if (attempt.expiresAt <= now) this.attempts.delete(id);
    }
    while (this.attempts.size >= MAX_ATTEMPTS) {
      const oldest = this.attempts.keys().next().value;
      if (oldest === undefined) break;
      this.attempts.delete(oldest);
    }
  }
}

export function createInstanceKeyService() {
  return new InstanceKeyService({
    client: createInstanceKeyClient(),
    store: credentialInstanceKeyStore,
    now: Date.now,
  });
}

const CONSENT_MESSAGES: Record<string, string> = {
  access_denied: "The request was denied in Beam Auth.",
  expired_token: "The approval code expired. Start again.",
  invalid_grant: "This approval is no longer valid. Start again.",
  grant_already_used: "This approval was already used. Start again.",
  permission_required:
    "Your role in this organization can't create API keys. Ask an owner, admin or developer to create the instance key.",
};

function consentError(error: unknown) {
  if (!(error instanceof InstanceKeyError)) return error;
  const message = CONSENT_MESSAGES[error.code];
  return message
    ? new InstanceKeyError(
        error.code,
        message,
        error.statusCode,
        error.retryable,
      )
    : error;
}
