import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The Compose files are what a client runs on their own machine. Publishing a
 * datastore there hands out the Studio database — which holds vault-encrypted
 * provider credentials, Beam API keys and workflow state — and the NATS task
 * stream. Services reach both over the Compose network by service name, so a
 * host port mapping buys nothing and costs everything.
 */
const COMPOSE_FILES = readdirSync(fileURLToPath(new URL("..", import.meta.url)))
  .filter((name) => /^docker-compose.*\.ya?ml$/.test(name))
  .sort();
const DATASTORES = ["postgres", "nats"];

const read = (name) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

/** The lines of one top-level `services:` entry, by indentation. */
function serviceBlock(text, service) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith("    ")) break;
    body.push(line);
  }
  return body;
}

for (const name of COMPOSE_FILES) {
  for (const service of DATASTORES) {
    test(`${name}: ${service} publishes no host port`, () => {
      const body = serviceBlock(read(name), service);
      assert.ok(body, `${name} must define a ${service} service`);
      const ports = body.find((line) => line.startsWith("    ports:"));
      assert.equal(
        ports,
        undefined,
        `${service} must not publish a host port in ${name}`,
      );
    });
  }

  test(`${name}: the database password has no default`, () => {
    const text = read(name);
    assert.doesNotMatch(
      text,
      /beam:beam@/,
      "a default database password must not ship in a Compose file",
    );
    // `:?` makes Compose refuse to start rather than fall back to a known value.
    for (const match of text.matchAll(/^\s*POSTGRES_PASSWORD:[ \t]*(.+)$/gm)) {
      const value = match[1].trim();
      assert.match(
        value,
        /^\$\{POSTGRES_PASSWORD:\?/,
        `POSTGRES_PASSWORD must be a required variable, found ${value}`,
      );
    }
    assert.match(
      text,
      /\$\{POSTGRES_PASSWORD:\?/,
      "the password must be interpolated as a required variable",
    );
  });

  test(`${name}: services still reach the datastores by service name`, () => {
    const text = read(name);
    assert.match(text, /@postgres:5432\/beam_studio/);
    assert.match(text, /nats:\/\/nats:4222/);
  });
}

/**
 * The release template is what the installer and the host updater run. Unlike
 * the development Compose files it has no `env_file`, so a variable written to
 * the install's `.env` reaches a container only if the template names it.
 * Every HTTP listener validates `Host` (packages/shared/src/perimeter.ts), so a
 * service that does not receive `BEAM_STUDIO_ALLOWED_HOSTS` answers `421` to
 * every DNS name, which leaves an install reachable only by IP.
 */
const RELEASE_TEMPLATE = "deploy/compose.release.template.yml";
const HOST_CHECKING_SERVICES = [
  "studio",
  "api",
  "mcp",
  "orchestrator",
  "worker-1",
  "worker-2",
  "worker-3",
];

/** The lines of a top-level `x-*` extension block, by indentation. */
function extensionBlock(text, anchorLine) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === anchorLine);
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith("  ")) break;
    body.push(line);
  }
  return body;
}

test(`${RELEASE_TEMPLATE}: the shared environment passes the Host allowlist`, () => {
  const appEnv = extensionBlock(read(RELEASE_TEMPLATE), "x-app-env: &app-env");
  assert.ok(appEnv, "the release template must define x-app-env");
  assert.ok(
    appEnv.some(
      (line) =>
        line.trim() ===
        "BEAM_STUDIO_ALLOWED_HOSTS: ${BEAM_STUDIO_ALLOWED_HOSTS:-}",
    ),
    "x-app-env must pass BEAM_STUDIO_ALLOWED_HOSTS from the install's .env",
  );
});

test(`${RELEASE_TEMPLATE}: the worker environment inherits the shared environment`, () => {
  const workerService = extensionBlock(
    read(RELEASE_TEMPLATE),
    "x-worker-service: &worker-service",
  );
  assert.ok(workerService, "the release template must define x-worker-service");
  assert.ok(workerService.includes("  environment: &worker-env"));
  assert.ok(workerService.includes("    <<: *app-env"));
});

for (const service of HOST_CHECKING_SERVICES) {
  test(`${RELEASE_TEMPLATE}: ${service} receives the Host allowlist`, () => {
    const body = serviceBlock(read(RELEASE_TEMPLATE), service);
    assert.ok(body, `${RELEASE_TEMPLATE} must define a ${service} service`);
    const merges = body.map((line) => line.trim());
    assert.ok(
      merges.includes("<<: *app-env") || merges.includes("<<: *worker-env"),
      `${service} must merge the shared environment that carries BEAM_STUDIO_ALLOWED_HOSTS`,
    );
  });
}

const OWNER_LEVER = "BEAM_STUDIO_OWNER_ORGANIZATION_ID";

test(`${RELEASE_TEMPLATE}: the shared environment passes the owner recovery lever`, () => {
  const appEnv = extensionBlock(read(RELEASE_TEMPLATE), "x-app-env: &app-env");
  assert.ok(appEnv, "the release template must define x-app-env");
  assert.ok(
    appEnv.some(
      (line) => line.trim() === `${OWNER_LEVER}: \${${OWNER_LEVER}:-}`,
    ),
    `x-app-env must pass ${OWNER_LEVER} from the install's .env, empty by default`,
  );
});

/** Release services by the app directory whose code they run. */
const SERVICES_BY_APP = {
  api: ["api"],
  "mcp-server": ["mcp"],
  orchestrator: ["orchestrator"],
  studio: ["studio"],
  worker: ["worker-1", "worker-2", "worker-3"],
};

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) &&
      !/\.test\.|\.fixture\./.test(entry.name)
      ? [path]
      : [];
  });
}

test(`${RELEASE_TEMPLATE}: every service that reads the owner lever receives it`, () => {
  const template = read(RELEASE_TEMPLATE);
  const readers = Object.keys(SERVICES_BY_APP).filter((app) =>
    sourceFiles(fileURLToPath(new URL(`../apps/${app}/src`, import.meta.url))).some(
      (file) => readFileSync(file, "utf8").includes(OWNER_LEVER),
    ),
  );
  assert.ok(readers.includes("api"), "the api reads the owner lever at start-up");
  for (const app of readers) {
    for (const service of SERVICES_BY_APP[app]) {
      const body = serviceBlock(template, service);
      assert.ok(body, `${RELEASE_TEMPLATE} must define a ${service} service`);
      const lines = body.map((line) => line.trim());
      assert.ok(
        lines.includes("<<: *app-env") || lines.includes("<<: *worker-env"),
        `${service} reads ${OWNER_LEVER} and must merge the shared environment`,
      );
    }
  }
});

test(".env.example documents the owner recovery lever, empty", () => {
  const example = read(".env.example");
  assert.match(example, new RegExp(`^${OWNER_LEVER}=$`, "m"));
});

const ROOM_CONSUMER = "room-consumer";

function roomConsumerLines() {
  const body = serviceBlock(read(RELEASE_TEMPLATE), ROOM_CONSUMER);
  assert.ok(body, `${RELEASE_TEMPLATE} must define a ${ROOM_CONSUMER} service`);
  return body.map((line) => line.trim());
}

test(`${RELEASE_TEMPLATE}: the room consumer runs the release's pinned image`, () => {
  const lines = roomConsumerLines();
  assert.ok(lines.includes('image: "@IMAGE_ROOM_CONSUMER@"'));
  assert.ok(lines.includes("restart: unless-stopped"));
  const dependsOn = lines.indexOf("depends_on:");
  assert.notEqual(dependsOn, -1, "the consumer must wait for the api");
  assert.equal(lines[dependsOn + 1], "api:");
});

test(`${RELEASE_TEMPLATE}: the room consumer keeps its identity on a named volume`, () => {
  const template = read(RELEASE_TEMPLATE);
  assert.ok(
    roomConsumerLines().includes("- beam-studio-room-consumer:/var/lib/beam"),
  );
  const volumes = extensionBlock(template, "volumes:");
  assert.ok(volumes, "the release template must declare its volumes");
  const declared = volumes.map((line) => line.trim());
  const index = declared.indexOf("beam-studio-room-consumer:");
  assert.notEqual(index, -1, "the consumer volume must be declared");
  assert.equal(declared[index + 1], "name: beam-studio-room-consumer");
});

test(`${RELEASE_TEMPLATE}: the room consumer bootstraps over the Compose network`, () => {
  const lines = roomConsumerLines();
  for (const expected of [
    "BEAM_STUDIO_INTERNAL_URL: http://api:8787",
    "BEAM_STUDIO_SHARED_SECRET: ${BEAM_STUDIO_SHARED_SECRET:-}",
    "BEAM_STUDIO_ENVIRONMENT_TEMPLATE: ${BEAM_STUDIO_ENVIRONMENT_TEMPLATE:-}",
    "BEAM_STUDIO_MEDIA_PUBLIC_IP: ${BEAM_STUDIO_MEDIA_PUBLIC_IP:-}",
    'BEAM_STUDIO_MEDIA_UDP_ADDR: ":${BEAM_STUDIO_MEDIA_UDP_PORT:-50400}"',
  ]) {
    assert.ok(lines.includes(expected), `missing ${expected}`);
  }
  // The advertised media port is the one it listens on, so both sides match.
  assert.ok(
    lines.includes(
      '- "${BEAM_STUDIO_MEDIA_UDP_BIND_ADDRESS:-0.0.0.0}:${BEAM_STUDIO_MEDIA_UDP_PORT:-50400}:${BEAM_STUDIO_MEDIA_UDP_PORT:-50400}/udp"',
    ),
  );
  // Its api bootstrap URL is a single-label service name, which the Host
  // allowlist always accepts.
  assert.ok(!lines.some((line) => line.startsWith("BEAM_STUDIO_URL:")));
});

test(`${RELEASE_TEMPLATE}: the room consumer gets no database, vault key or NATS`, () => {
  const lines = roomConsumerLines();
  assert.ok(
    !lines.includes("<<: *app-env") && !lines.includes("<<: *worker-env"),
    "the consumer must not inherit the shared environment",
  );
  for (const secret of ["DATABASE_URL", "BEAM_STUDIO_SECRET_KEY", "NATS_URL"]) {
    assert.ok(
      !lines.some((line) => line.startsWith(`${secret}:`)),
      `the consumer must not receive ${secret}`,
    );
  }
});

test(`${RELEASE_TEMPLATE}: the room consumer waits rather than exits without a secret`, () => {
  const body = serviceBlock(read(RELEASE_TEMPLATE), ROOM_CONSUMER).join("\n");
  // Compose escapes $ as $$; the shell then reads the container's variable.
  assert.match(body, /if \[ -z "\$\$\{BEAM_STUDIO_SHARED_SECRET\}" \]; then/);
  assert.match(body, /while :; do sleep 3600 & wait \$\$!; done/);
  // Otherwise it runs the image's own entrypoint.
  assert.match(
    body,
    /exec beam-tunnel-agent-dev \\\n\s+--state-dir \/var\/lib\/beam\/state \\\n\s+--socket \/var\/lib\/beam\/state\/beam-agent\.sock \\\n\s+--room-inbox \/var\/lib\/beam\/inbox/,
  );
});

test("deploy/room-consumer-image.json pins an approved, immutable image", () => {
  const pin = JSON.parse(read("deploy/room-consumer-image.json"));
  assert.equal(
    pin.image,
    "ghcr.io/beam-network/beam-studio-runtime-room-consumer",
  );
  assert.match(pin.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(pin.commit, /^[a-f0-9]{40}$/);
  assert.match(pin.version, /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
});

test(".env.example leaves the consumer organization to the instance owner", () => {
  const example = read(".env.example");
  assert.match(example, /^BEAM_STUDIO_SHARED_SECRET=$/m);
  assert.match(example, /^BEAM_STUDIO_CONSUMER_ORGANIZATION_ID=$/m);
});

for (const name of [...COMPOSE_FILES, RELEASE_TEMPLATE]) {
  test(`${name}: the Ops API port is never published`, () => {
    const text = read(name);
    assert.doesNotMatch(text, /STUDIO_OPS_PORT|STUDIO_OPS_SECRET/);
    assert.doesNotMatch(text, /^\s*- "?[^\n]*:8789(?:\/tcp)?"?\s*$/m);
  });
}
