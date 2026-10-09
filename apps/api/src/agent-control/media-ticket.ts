import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type MediaTicket = {
  agentId: string;
  organizationId: string;
  roomId: string;
  channelId: string;
  expiresAt: number;
};

export function issueMediaTicket(
  secret: string,
  value: Omit<MediaTicket, "expiresAt">,
  now = Date.now(),
) {
  const ticket: MediaTicket & { nonce: string } = {
    ...value,
    expiresAt: now + 60_000,
    nonce: randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyMediaTicket(
  secret: string,
  raw: string,
  now = Date.now(),
) {
  if (!secret || !raw || raw.length > 4_096) return null;
  const [payload, supplied, ...extra] = raw.split(".");
  if (!payload || !supplied || extra.length) return null;
  const expected = sign(secret, payload);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return null;
  }
  try {
    const value = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as Record<string, unknown>;
    if (
      typeof value.agentId !== "string" ||
      typeof value.organizationId !== "string" ||
      typeof value.roomId !== "string" ||
      typeof value.channelId !== "string" ||
      typeof value.expiresAt !== "number" ||
      typeof value.nonce !== "string" ||
      value.expiresAt < now ||
      value.expiresAt > now + 65_000
    ) {
      return null;
    }
    return value as MediaTicket & { nonce: string };
  } catch {
    return null;
  }
}

function sign(secret: string, payload: string) {
  return createHmac("sha256", secret)
    .update(`beam-media-v1\0${payload}`)
    .digest("base64url");
}
