import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  decryptString,
  encryptString,
  vaultSecretFromEnv,
} from "@beam-studio/vault";

const STORE_VERSION = 2;

type PersistedToken = {
  version: typeof STORE_VERSION;
  encrypted_refresh_token: string;
};

export interface RefreshTokenStore {
  load(): Promise<string | null>;
  save(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

export function defaultRefreshTokenPath() {
  return (
    process.env.BEAM_STUDIO_AUTH_STORE_PATH?.trim() ||
    join(homedir(), ".beam-studio", "oauth-session.json")
  );
}

/**
 * Encrypted, owner-only persistence for the local Studio API process.
 * A complete temp file is renamed over the previous generation so refresh
 * token rotation is atomic even if the process exits during a write.
 */
export class EncryptedFileRefreshTokenStore implements RefreshTokenStore {
  constructor(
    private readonly path = defaultRefreshTokenPath(),
    private readonly secret = vaultSecretFromEnv(),
  ) {}

  async load() {
    try {
      const payload = JSON.parse(
        await readFile(this.path, "utf8"),
      ) as Partial<PersistedToken>;
      if (
        payload.version !== STORE_VERSION ||
        typeof payload.encrypted_refresh_token !== "string"
      ) {
        return null;
      }
      return decryptString(payload.encrypted_refresh_token, this.secret);
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      // Corrupt, legacy, or undecryptable credentials are intentionally ignored.
      return null;
    }
  }

  async save(refreshToken: string) {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const payload: PersistedToken = {
      version: STORE_VERSION,
      encrypted_refresh_token: encryptString(refreshToken, this.secret),
    };

    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async clear() {
    await rm(this.path, { force: true });
  }
}

function isMissingFile(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
