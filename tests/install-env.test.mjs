import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The installer is rerun to upgrade a host, and it must never touch a value an
 * existing install depends on — the database password and vault key above all.
 * It still has to add settings introduced after the host was first installed,
 * or those hosts silently miss them (a v1.0.3 install never received
 * BEAM_STUDIO_ALLOWED_HOSTS and answered 421 to its own DNS name).
 */
const INSTALLER = fileURLToPath(
  new URL("../scripts/install-beam-studio.sh", import.meta.url),
);

/** Runs write_install_env against a temporary install directory. */
function writeInstallEnv(installDir, env = {}) {
  return spawnSync(
    "sh",
    ["-c", '. "$INSTALLER" && write_install_env', "install-env-test"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        INSTALLER,
        BEAM_STUDIO_INSTALLER_SOURCE_ONLY: "1",
        BEAM_STUDIO_INSTALL_DIR: installDir,
        BEAM_UPDATER_SOCKET_PATH: "/run/beam-studio/updater.sock",
        ...env,
      },
    },
  );
}

function withInstallDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "beam-install-env-"));
  try {
    run(dir, join(dir, ".env"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseEnv(text) {
  const entries = text
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]);
  const keys = entries.map(([key]) => key);
  assert.equal(new Set(keys).size, keys.length, `duplicate keys in:\n${text}`);
  return Object.fromEntries(entries);
}

// What the v1.0.3 installer wrote: everything except BEAM_STUDIO_ALLOWED_HOSTS.
const V103_ENV = [
  "POSTGRES_PASSWORD=existing-database-password",
  "BEAM_STUDIO_SECRET_KEY=existing-vault-key",
  "BEAM_STUDIO_PUBLIC_URL=https://studio.example.com",
  "BEAM_STUDIO_SECURE_COOKIES=true",
  "STUDIO_PORT=3004",
  "STUDIO_BIND_ADDRESS=0.0.0.0",
  "API_BIND_ADDRESS=127.0.0.1",
  "BEAM_UPDATER_SOCKET_PATH=/run/beam-studio/updater.sock",
  "",
].join("\n");

test("a fresh install writes generated secrets and every setting", () => {
  withInstallDir((dir, envPath) => {
    const result = writeInstallEnv(dir, {
      BEAM_STUDIO_PUBLIC_URL: "https://studio.example.com",
    });
    assert.equal(result.status, 0, result.stderr);
    const env = parseEnv(readFileSync(envPath, "utf8"));
    assert.match(env.POSTGRES_PASSWORD, /^[0-9a-f]{48}$/);
    assert.match(env.BEAM_STUDIO_SECRET_KEY, /^[0-9a-f]{64}$/);
    assert.equal(env.BEAM_STUDIO_PUBLIC_URL, "https://studio.example.com");
    assert.equal(env.BEAM_STUDIO_SECURE_COOKIES, "true");
    assert.equal(env.BEAM_STUDIO_ALLOWED_HOSTS, "studio.example.com");
    assert.equal(env.STUDIO_PORT, "3004");
    assert.equal(env.STUDIO_BIND_ADDRESS, "0.0.0.0");
    assert.equal(env.API_BIND_ADDRESS, "127.0.0.1");
    assert.equal(env.BEAM_UPDATER_SOCKET_PATH, "/run/beam-studio/updater.sock");
    assert.equal(env.BEAM_UPDATER_SOCKET_DIR, "/run/beam-studio");
    assert.match(env.BEAM_STUDIO_SHARED_SECRET, /^[0-9a-f]{64}$/);
    assert.notEqual(env.BEAM_STUDIO_SHARED_SECRET, env.BEAM_STUDIO_SECRET_KEY);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
  });
});

test("a rerun keeps every existing line and appends only missing settings", () => {
  withInstallDir((dir, envPath) => {
    writeFileSync(envPath, V103_ENV, { mode: 0o600 });
    // The operator reruns without the original URL; the file still wins.
    const result = writeInstallEnv(dir);
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(envPath, "utf8");
    assert.ok(text.startsWith(V103_ENV), "existing lines must be unchanged");
    assert.match(
      text.slice(V103_ENV.length),
      new RegExp(
        "^BEAM_STUDIO_ALLOWED_HOSTS=studio\\.example\\.com\\n" +
          "BEAM_UPDATER_SOCKET_DIR=/run/beam-studio\\n" +
          "BEAM_STUDIO_SHARED_SECRET=[0-9a-f]{64}\\n$",
      ),
    );
    assert.match(
      result.stdout,
      /added missing settings: BEAM_STUDIO_ALLOWED_HOSTS BEAM_UPDATER_SOCKET_DIR BEAM_STUDIO_SHARED_SECRET/,
    );
    // The secret is generated, never printed.
    assert.doesNotMatch(result.stdout, /[0-9a-f]{64}/);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
  });
});

test("a rerun never overrides an existing value with this run's input", () => {
  withInstallDir((dir, envPath) => {
    writeFileSync(envPath, V103_ENV);
    const result = writeInstallEnv(dir, {
      BEAM_STUDIO_PUBLIC_URL: "http://203.0.113.7:3004",
      BEAM_STUDIO_PORT: "8080",
    });
    assert.equal(result.status, 0, result.stderr);
    const env = parseEnv(readFileSync(envPath, "utf8"));
    assert.equal(env.POSTGRES_PASSWORD, "existing-database-password");
    assert.equal(env.BEAM_STUDIO_SECRET_KEY, "existing-vault-key");
    assert.equal(env.BEAM_STUDIO_PUBLIC_URL, "https://studio.example.com");
    assert.equal(env.STUDIO_PORT, "3004");
    assert.equal(env.BEAM_STUDIO_ALLOWED_HOSTS, "studio.example.com");
  });
});

test("an existing empty value counts as set", () => {
  withInstallDir((dir, envPath) => {
    const original = `${V103_ENV}BEAM_STUDIO_ALLOWED_HOSTS=\nBEAM_UPDATER_SOCKET_DIR=\nBEAM_STUDIO_SHARED_SECRET=existing-shared-secret\n`;
    writeFileSync(envPath, original);
    const result = writeInstallEnv(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(envPath, "utf8"), original);
    assert.match(result.stdout, /preserving existing .*\.env$/m);
  });
});

test("a second rerun is a no-op", () => {
  withInstallDir((dir, envPath) => {
    writeFileSync(envPath, V103_ENV);
    assert.equal(writeInstallEnv(dir).status, 0);
    const once = readFileSync(envPath, "utf8");
    assert.equal(writeInstallEnv(dir).status, 0);
    assert.equal(readFileSync(envPath, "utf8"), once);
  });
});

test("quoted, exported and unterminated lines are understood", () => {
  withInstallDir((dir, envPath) => {
    const original = [
      "export POSTGRES_PASSWORD='existing-database-password'",
      "BEAM_STUDIO_SECRET_KEY = existing-vault-key",
      'BEAM_STUDIO_PUBLIC_URL="https://studio.example.com:8443/"',
    ].join("\n");
    writeFileSync(envPath, original);
    const result = writeInstallEnv(dir);
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(envPath, "utf8");
    assert.ok(
      text.startsWith(`${original}\n`),
      "the last line must stay intact",
    );
    const added = parseEnv(text.slice(original.length + 1));
    assert.deepEqual(Object.keys(added).sort(), [
      "API_BIND_ADDRESS",
      "BEAM_STUDIO_ALLOWED_HOSTS",
      "BEAM_STUDIO_SECURE_COOKIES",
      "BEAM_STUDIO_SHARED_SECRET",
      "BEAM_UPDATER_SOCKET_DIR",
      "BEAM_UPDATER_SOCKET_PATH",
      "STUDIO_BIND_ADDRESS",
      "STUDIO_PORT",
    ]);
    assert.equal(added.BEAM_STUDIO_ALLOWED_HOSTS, "studio.example.com");
    assert.equal(added.BEAM_STUDIO_SECURE_COOKIES, "true");
  });
});

test("the consumer shared secret is generated once and kept on every rerun", () => {
  withInstallDir((dir, envPath) => {
    assert.equal(writeInstallEnv(dir).status, 0);
    const first = parseEnv(readFileSync(envPath, "utf8"));
    assert.match(first.BEAM_STUDIO_SHARED_SECRET, /^[0-9a-f]{64}$/);
    for (let rerun = 0; rerun < 2; rerun += 1) {
      assert.equal(writeInstallEnv(dir).status, 0);
      const env = parseEnv(readFileSync(envPath, "utf8"));
      assert.equal(
        env.BEAM_STUDIO_SHARED_SECRET,
        first.BEAM_STUDIO_SHARED_SECRET,
      );
    }
  });
});

test("a rerun keeps an operator's own consumer shared secret", () => {
  withInstallDir((dir, envPath) => {
    writeFileSync(
      envPath,
      `${V103_ENV}BEAM_STUDIO_SHARED_SECRET=operator-chosen\n`,
    );
    assert.equal(writeInstallEnv(dir).status, 0);
    const env = parseEnv(readFileSync(envPath, "utf8"));
    assert.equal(env.BEAM_STUDIO_SHARED_SECRET, "operator-chosen");
  });
});

for (const secret of ["POSTGRES_PASSWORD", "BEAM_STUDIO_SECRET_KEY"]) {
  test(`a rerun refuses to generate a missing ${secret}`, () => {
    withInstallDir((dir, envPath) => {
      const original = V103_ENV.replace(
        new RegExp(`^${secret}=.*\\n`, "m"),
        "",
      );
      writeFileSync(envPath, original);
      const result = writeInstallEnv(dir);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`has no ${secret}`));
      assert.equal(readFileSync(envPath, "utf8"), original);
    });
  });
}

test("the socket directory follows a custom socket path", () => {
  withInstallDir((dir, envPath) => {
    const result = writeInstallEnv(dir, {
      BEAM_UPDATER_SOCKET_PATH: "/run/beam-studio/custom.sock",
    });
    assert.equal(result.status, 0, result.stderr);
    const env = parseEnv(readFileSync(envPath, "utf8"));
    assert.equal(env.BEAM_UPDATER_SOCKET_PATH, "/run/beam-studio/custom.sock");
    assert.equal(env.BEAM_UPDATER_SOCKET_DIR, "/run/beam-studio");
  });
});
