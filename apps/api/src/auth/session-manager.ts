import { createHash } from "node:crypto";
import { join } from "node:path";
import { derivedSecret, derivedSecrets } from "@beam-studio/vault";
import {
  createStudioBrowserSession,
  isValidStudioBrowserSession,
} from "./browser-session.js";
import { createBeamApiClient, type BeamApiClient } from "./beam-api-client.js";
import {
  createStudioOAuthService,
  type StudioOAuthService,
} from "./oauth-service.js";
import {
  defaultRefreshTokenPath,
  EncryptedFileRefreshTokenStore,
} from "./secure-token-store.js";

export const STUDIO_LOGIN_COOKIE = "beam-studio.login";
export type StudioSessionServices = {
  oauth: StudioOAuthService;
  beamApi: BeamApiClient;
};

/** One OAuth service and encrypted store per unguessable, signed browser session. */
export class StudioSessionManager {
  private readonly sessions = new Map<string, StudioSessionServices>();
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly options: {
      secret?: string;
      directory?: string;
      now?: () => number;
      createServices?: (id: string) => StudioSessionServices;
    } = {},
  ) {}

  create() {
    const cookie = createStudioBrowserSession(this.secret(), {
      now: this.now(),
    });
    const services = this.get(cookie)!;
    this.pending.set(cookie, this.now() + 10 * 60 * 1_000);
    return { cookie, services };
  }

  get(cookie: string | null): StudioSessionServices | null {
    const secret = this.verificationSecrets();
    if (!cookie || !isValidStudioBrowserSession(cookie, secret, this.now()))
      return null;
    this.prune();
    let services = this.sessions.get(cookie);
    if (!services) {
      const id = createHash("sha256").update(cookie).digest("hex");
      if (this.options.createServices) {
        services = this.options.createServices(id);
      } else {
        const oauth = createStudioOAuthService({
          store: new EncryptedFileRefreshTokenStore(
            join(
              this.options.directory ?? `${defaultRefreshTokenPath()}.sessions`,
              `${id}.json`,
            ),
          ),
        });
        services = { oauth, beamApi: createBeamApiClient(oauth) };
      }
      this.sessions.set(cookie, services);
    }
    return services;
  }

  activate(cookie: string) {
    const expiresAt = this.pending.get(cookie);
    if (!expiresAt || expiresAt <= this.now()) {
      throw Object.assign(new Error("The device login attempt has expired"), {
        code: "expired_token",
        statusCode: 400,
      });
    }
    this.pending.delete(cookie);
  }

  async logout(cookie: string | null) {
    const services = this.get(cookie);
    if (!services) return;
    // Keep this service until expiry so in-flight requests cannot revive it.
    await services.oauth.logout();
  }

  shutdown() {
    for (const services of this.sessions.values()) services.oauth.shutdown();
    this.sessions.clear();
    this.pending.clear();
  }

  private prune() {
    for (const [cookie, services] of this.sessions) {
      const pendingExpiresAt = this.pending.get(cookie);
      if (
        (pendingExpiresAt !== undefined && pendingExpiresAt <= this.now()) ||
        !isValidStudioBrowserSession(
          cookie,
          this.verificationSecrets(),
          this.now(),
        )
      ) {
        services.oauth.shutdown();
        this.sessions.delete(cookie);
        this.pending.delete(cookie);
      }
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** The secret new cookies are signed with: always the active key. */
  private secret() {
    // Tests inject their own. Otherwise this is derived from the vault key,
    // which refuses to resolve to a published placeholder or an absent value,
    // so there is no environment where session cookies are signed with a
    // secret an attacker already knows.
    return (
      this.options.secret ?? derivedSecret("beam-studio.browser-session.v1")
    );
  }

  /**
   * The secrets a cookie may have been signed with, active first.
   *
   * Rotating the vault key would otherwise invalidate every session at once,
   * which made rotation something an operator would avoid. Accepting keys that
   * are on the ring but retired moves the sign-out to the moment a key is
   * dropped, where it is a deliberate documented step.
   */
  private verificationSecrets() {
    return this.options.secret
      ? [this.options.secret]
      : derivedSecrets("beam-studio.browser-session.v1");
  }
}

export function studioCookie(
  header: string | undefined,
  name: string,
): string | null {
  const values = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  try {
    return decodeURIComponent(values[0]!.slice(name.length + 1));
  } catch {
    return null;
  }
}
