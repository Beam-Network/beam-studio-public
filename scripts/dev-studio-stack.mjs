import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);

function connectionTarget(rawUrl, defaultPort) {
  const url = new URL(rawUrl);

  return {
    host: url.hostname,
    port: Number(url.port || defaultPort),
  };
}

function canConnect({ host, port }, timeout = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (connected) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(connected);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeout, () => finish(false));
  });
}

function hasJetStream({ host, port }, timeout = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (enabled) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(enabled);
    };

    socket.once("data", (data) => {
      const infoLine = data.toString().split("\r\n", 1)[0];

      if (!infoLine.startsWith("INFO ")) {
        finish(false);
        return;
      }

      try {
        finish(JSON.parse(infoLine.slice(5)).jetstream === true);
      } catch {
        finish(false);
      }
    });
    socket.once("error", () => finish(false));
    socket.setTimeout(timeout, () => finish(false));
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDirectory,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} stopped with ${signal ?? `exit code ${code ?? "unknown"}`}.`,
        ),
      );
    });
  });
}

async function waitForConnection(target, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await canConnect(target)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

/**
 * The vault refuses to start without BEAM_STUDIO_SECRET_KEY, and deliberately
 * has no fallback: a shared default is a published key. Local development gets
 * a generated one instead, written once to .env.local, so "no default" does not
 * mean "no local stack".
 */
async function ensureLocalSecretKey() {
  if (process.env.BEAM_STUDIO_SECRET_KEY?.trim()) return;

  const envPath = join(rootDirectory, ".env.local");
  const secret = randomBytes(32).toString("hex");
  const line = `BEAM_STUDIO_SECRET_KEY=${secret}\n`;

  let existing = "";
  try {
    existing = await readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (/^BEAM_STUDIO_SECRET_KEY=.+$/m.test(existing)) {
    throw new Error(
      `.env.local sets BEAM_STUDIO_SECRET_KEY but it did not reach this process. Run through \`pnpm dev:stack\`, which loads ${envPath}.`,
    );
  }

  const separator = !existing || existing.endsWith("\n") ? "" : "\n";
  await writeFile(envPath, `${existing}${separator}${line}`, { mode: 0o600 });
  process.env.BEAM_STUDIO_SECRET_KEY = secret;
  console.log(`Generated a local BEAM_STUDIO_SECRET_KEY in ${envPath}.`);
}

async function main() {
  await ensureLocalSecretKey();

  const postgresTarget = connectionTarget(
    process.env.DATABASE_URL ??
      "postgres://127.0.0.1:5432/beam_studio",
    5432,
  );

  if (!(await canConnect(postgresTarget))) {
    throw new Error(
      `PostgreSQL is not reachable at ${postgresTarget.host}:${postgresTarget.port}. Start the local beam_studio database before running this command.`,
    );
  }

  const natsTarget = connectionTarget(
    process.env.NATS_URL ?? "nats://127.0.0.1:4222",
    4222,
  );
  let natsProcess;

  if (!(await canConnect(natsTarget))) {
    if (!localHosts.has(natsTarget.host)) {
      throw new Error(
        `NATS is not reachable at ${natsTarget.host}:${natsTarget.port}. Automatic startup is only available for a local NATS server.`,
      );
    }

    const storeDirectory = join(rootDirectory, "data", "nats");
    await mkdir(storeDirectory, { recursive: true });

    console.log(
      `[studio-stack] Starting local NATS JetStream on ${natsTarget.host}:${natsTarget.port}`,
    );
    natsProcess = spawn(
      "nats-server",
      [
        "--jetstream",
        "--addr",
        natsTarget.host,
        "--port",
        String(natsTarget.port),
        "--http_port",
        "8222",
        "--store_dir",
        storeDirectory,
      ],
      {
        cwd: rootDirectory,
        stdio: "inherit",
      },
    );

    const natsStartupError = new Promise((_, reject) => {
      natsProcess.once("error", (error) => {
        if (error.code === "ENOENT") {
          reject(
            new Error(
              "nats-server is not installed. Install it with `brew install nats-server`, then retry.",
            ),
          );
          return;
        }

        reject(error);
      });
      natsProcess.once("exit", (code) => {
        reject(
          new Error(
            `The local NATS server stopped during startup with exit code ${code ?? "unknown"}.`,
          ),
        );
      });
    });

    const natsReady = waitForConnection(natsTarget).then((ready) => {
      if (!ready) {
        throw new Error(
          `NATS did not become reachable at ${natsTarget.host}:${natsTarget.port}.`,
        );
      }
    });

    await Promise.race([natsReady, natsStartupError]);
  } else {
    if (!(await hasJetStream(natsTarget))) {
      throw new Error(
        `NATS is reachable at ${natsTarget.host}:${natsTarget.port}, but JetStream is disabled. Stop that server and rerun this command so it can start NATS with JetStream, or restart it with \`nats-server --jetstream\`.`,
      );
    }

    console.log(
      `[studio-stack] Using NATS already running on ${natsTarget.host}:${natsTarget.port}`,
    );
  }

  console.log("[studio-stack] Building internal workspace packages");
  await run("pnpm", [
    "-r",
    "--filter",
    "./packages/**",
    "run",
    "build",
  ]);

  const servicesEnv = {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgres://127.0.0.1:5432/beam_studio",
  };

  const servicesProcess = spawn(
    "pnpm",
    [
      "-r",
      "--parallel",
      "--filter",
      "@beam-studio/studio",
      "--filter",
      "@beam-studio/api",
      "--filter",
      "@beam-studio/orchestrator",
      "--filter",
      "@beam-studio/worker",
      "run",
      "dev",
    ],
    {
      cwd: rootDirectory,
      env: servicesEnv,
      stdio: "inherit",
    },
  );

  let shuttingDown = false;

  const shutdown = (signal = "SIGTERM") => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    servicesProcess.kill(signal);
    natsProcess?.kill(signal);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  servicesProcess.once("error", (error) => {
    console.error(
      "[studio-stack] Unable to start the application services:",
      error,
    );
    shutdown();
    process.exitCode = 1;
  });

  servicesProcess.once("exit", (code, signal) => {
    shutdown(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    process.exitCode = code ?? (signal ? 1 : 0);
  });

  natsProcess?.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `[studio-stack] NATS stopped unexpectedly (${signal ?? `exit ${code}`}).`,
      );
      shutdown();
      process.exitCode = 1;
    }
  });
}

main().catch((error) => {
  console.error(`[studio-stack] ${error.message}`);
  process.exitCode = 1;
});
