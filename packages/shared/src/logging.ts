/**
 * Logger configuration shared by the Node services (API, orchestrator, MCP
 * server, worker).
 *
 * Kept free of a pino dependency: each service passes its own `pino` factory,
 * so this module only decides the level and what is redacted.
 */

export const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export const LOG_REDACTED = "[REDACTED]";

/**
 * Field names whose value is a secret wherever it appears. Each is redacted at
 * the top level and one level down (`token` and `*.token`), which covers
 * `logger.info({ token })` as well as `logger.info({ credential: { token } })`.
 */
const SECRET_KEYS = [
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "apiKey",
  "api_key",
  "clientSecret",
  "client_secret",
  "privateKey",
  "private_key",
  "secretAccessKey",
  "secret_access_key",
  "sessionToken",
  "session_token",
  "signature",
  "credential",
  "credentials",
  "credentialPayload",
  "encryptedPayload",
  "encrypted_payload",
  "claimCode",
  "claim_code",
] as const;

/**
 * Headers that carry credentials. Fastify's default request serializer does
 * not log headers, but an error or a hand-written log line can carry them.
 */
const SECRET_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-beam-api-key",
  "x-beam-path-token",
  "x-beam-signature",
  "x-studio-shared-secret",
] as const;

function headerPaths(prefix: string) {
  return SECRET_HEADERS.map((header) =>
    /^[a-z]+$/.test(header) ? `${prefix}.${header}` : `${prefix}["${header}"]`,
  );
}

/** pino `redact.paths` for secrets in any service log line. */
export const LOG_REDACT_PATHS: readonly string[] = [
  ...SECRET_KEYS.flatMap((key) => [key, `*.${key}`]),
  ...headerPaths("headers"),
  ...headerPaths("*.headers"),
  ...headerPaths("req.headers"),
  ...headerPaths("res.headers"),
];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * The level from `LOG_LEVEL`, or the default when it is unset. An unknown
 * value is reported as `invalid` rather than thrown, so a typo in a deploy
 * never stops a service from starting.
 */
export function logLevelFromEnv(
  env: Record<string, string | undefined> = process.env,
): { level: LogLevel; invalid: string | null } {
  const requested = env.LOG_LEVEL?.trim().toLowerCase() ?? "";
  if (!requested) return { level: DEFAULT_LOG_LEVEL, invalid: null };
  return isLogLevel(requested)
    ? { level: requested, invalid: null }
    : { level: DEFAULT_LOG_LEVEL, invalid: env.LOG_LEVEL ?? requested };
}

const URL_USERINFO =
  /\b([a-z][a-z0-9+.-]*:\/\/)((?:\\.|[^\s:/?#@"\\])*)(?::((?:\\.|[^\s/?#"\\])*))?@/gi;

export function maskUrlCredentials(text: string): string {
  if (!text.includes("://")) return text;
  return text.replace(
    URL_USERINFO,
    (match, scheme: string, user: string, password: string | undefined) => {
      if (password !== undefined) {
        return `${scheme}${user}:${LOG_REDACTED}@`;
      }
      return user ? `${scheme}${LOG_REDACTED}@` : match;
    },
  );
}

/**
 * A connection string safe to log: the userinfo (username, password or token)
 * is dropped, the scheme, host, port and path are kept.
 * `postgres://beam:secret@postgres:5432/beam_studio` becomes
 * `postgres://postgres:5432/beam_studio`.
 */
export function stripUrlCredentials(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return maskUrlCredentials(value);
  }
  if (!url.username && !url.password) return value;
  url.username = "";
  url.password = "";
  return url.toString();
}

export type ServiceLoggerOptions = {
  name: string;
  level: LogLevel;
  redact: { paths: string[]; censor: string };
  /**
   * pino's last step before a line is written: masks URL credentials in the
   * message, in nested fields and in error messages and stacks.
   */
  hooks: { streamWrite: (line: string) => string };
};

/**
 * Builds a service logger with the shared level and redaction, including the
 * URL credential mask on every written line.
 *
 * `extraRedactPaths` adds service-specific paths on top of
 * {@link LOG_REDACT_PATHS}.
 */
export function createServiceLogger<
  TLogger extends { warn(object: object, message: string): unknown },
>(
  factory: (options: ServiceLoggerOptions) => TLogger,
  name: string,
  options: {
    env?: Record<string, string | undefined>;
    extraRedactPaths?: readonly string[];
  } = {},
): TLogger {
  const { level, invalid } = logLevelFromEnv(options.env);
  const logger = factory({
    name,
    level,
    redact: {
      paths: [
        ...new Set([...LOG_REDACT_PATHS, ...(options.extraRedactPaths ?? [])]),
      ],
      censor: LOG_REDACTED,
    },
    hooks: { streamWrite: maskUrlCredentials },
  });
  if (invalid) {
    // Not `level`: pino writes its own numeric `level` on every line, and a
    // second one made the JSON carry the key twice.
    logger.warn(
      { requested: invalid, fallbackLevel: level, accepted: LOG_LEVELS },
      "Ignoring unknown LOG_LEVEL",
    );
  }
  return logger;
}
