export type StudioSession = {
  type: "account";
  userId: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  provider?: string | null;
  platformRole?: "USER" | "ADMIN" | "SUPERADMIN" | null;
  accountType?: "user" | "admin";
  exp?: number | null;
};

type MePayload = {
  sub?: unknown;
  id?: unknown;
  userId?: unknown;
  email?: unknown;
  name?: unknown;
  image?: unknown;
  provider?: unknown;
  platformRole?: unknown;
  accountType?: unknown;
  user?: unknown;
};

/** Maps business identity returned by Beam API; OAuth token responses are never inspected here. */
export function studioSessionFromMe(payload: MePayload): StudioSession | null {
  const user = object(payload.user);
  const userId = text(
    payload.userId ?? payload.id ?? payload.sub ?? user?.id ?? user?.sub,
  );
  if (!userId) {
    return null;
  }
  return {
    type: "account",
    userId,
    name: nullableText(payload.name ?? user?.name),
    email: nullableText(payload.email ?? user?.email),
    image: nullableText(payload.image ?? user?.image),
    provider: nullableText(payload.provider ?? user?.provider),
    platformRole: platformRole(payload.platformRole ?? user?.platformRole),
    accountType: accountType(payload.accountType ?? user?.accountType),
    exp: null,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableText(value: unknown) {
  return typeof value === "string" ? value : null;
}

function platformRole(value: unknown): StudioSession["platformRole"] {
  return value === "USER" || value === "ADMIN" || value === "SUPERADMIN"
    ? value
    : null;
}

function accountType(value: unknown): StudioSession["accountType"] {
  return value === "admin" ? "admin" : "user";
}
