import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * After a host reboot dockerd restarts the Studio containers before
 * beam-updater.service has created its socket. The api container used to
 * bind-mount the socket FILE, so Docker created a directory at the socket path;
 * the api then failed ("not a directory") and the updater refused to replace
 * the directory. Neither came back until someone intervened.
 *
 * The api now mounts the socket's directory, read-only, which Docker can
 * create and which picks up the socket whenever the updater creates it.
 */

const path = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const read = (name) => readFileSync(path(name), "utf8");
const TEMPLATE = "deploy/compose.release.template.yml";

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

/** The long-syntax volume entries of a service, as trimmed key/value maps. */
function longVolumes(body) {
  const start = body.findIndex((line) => line === "    volumes:");
  assert.notEqual(start, -1, "the api service must declare volumes");
  const entries = [];
  let current = null;
  for (const line of body.slice(start + 1)) {
    if (line.trim().startsWith("#") || !line.trim()) continue;
    if (!line.startsWith("      ")) break;
    const item = line.match(/^      - (.*)$/);
    if (item) {
      current = {};
      entries.push(current);
      const pair = item[1].match(/^([a-z_]+):\s*(.*)$/);
      if (pair) current[pair[1]] = pair[2];
      else current.short = item[1];
      continue;
    }
    const nested = line.trim().match(/^([a-z_]+):\s*(.*)$/);
    if (current && nested) current[nested[1]] = nested[2];
  }
  return entries;
}

test(`${TEMPLATE}: the api mounts the updater socket's directory, not the socket file`, () => {
  const body = serviceBlock(read(TEMPLATE), "api");
  assert.ok(body, "the release template must define the api service");
  const binds = longVolumes(body).filter((entry) => entry.type === "bind");
  assert.equal(binds.length, 1, "the api has exactly one bind mount");
  const [bind] = binds;
  assert.equal(bind.source, "${BEAM_UPDATER_SOCKET_DIR:-/run/beam-studio}");
  assert.equal(bind.target, "${BEAM_UPDATER_SOCKET_DIR:-/run/beam-studio}");
  assert.equal(bind.read_only, "true");
  // `create_host_path: false` makes Docker refuse to create or start the
  // container while the path is missing, which is the reboot case itself.
  assert.equal(bind.create_host_path, undefined);
  for (const line of body) {
    assert.doesNotMatch(
      line,
      /^\s*(-\s+)?(source|target):.*\.sock\b/,
      "no bind may name the socket file itself",
    );
  }
  assert.ok(
    body.some(
      (line) =>
        line.trim() ===
        "BEAM_UPDATER_SOCKET_PATH: ${BEAM_UPDATER_SOCKET_PATH:-/run/beam-studio/updater.sock}",
    ),
    "the api must look for the socket inside the mounted directory",
  );
});

for (const [name, text] of [
  ["deploy/beam-updater.service", () => read("deploy/beam-updater.service")],
  [
    "the unit written by scripts/install-beam-studio.sh",
    () => {
      const script = read("scripts/install-beam-studio.sh");
      const start = script.indexOf('cat >"$SERVICE_PATH" <<UNIT');
      const end = script.indexOf("\nUNIT\n", start);
      assert.ok(
        start !== -1 && end !== -1,
        "the installer must write the unit",
      );
      return script.slice(start, end);
    },
  ],
]) {
  test(`${name}: starts after Docker and keeps its runtime directory`, () => {
    const unit = text();
    assert.match(unit, /^After=docker\.service/m);
    assert.doesNotMatch(unit, /^Before=.*docker\.service/m);
    assert.match(unit, /^RuntimeDirectory=beam-studio$/m);
    // The api container has this directory mounted. Removing it on stop would
    // leave the container holding a deleted directory.
    assert.match(unit, /^RuntimeDirectoryPreserve=yes$/m);
  });
}

const docker = spawnSync("docker", ["compose", "version"], {
  encoding: "utf8",
});

test(
  `${TEMPLATE}: Docker Compose resolves the mount as a read-only directory bind`,
  { skip: docker.status !== 0 ? "docker compose is not available" : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "beam-socket-mount-"));
    try {
      // Placeholders become any valid image reference; only the mount matters.
      const rendered = read(TEMPLATE).replace(/@[A-Z_]+@/g, "alpine:3");
      writeFileSync(join(dir, "compose.yml"), rendered);
      writeFileSync(
        join(dir, ".env"),
        "POSTGRES_PASSWORD=unused\nBEAM_STUDIO_SECRET_KEY=unused\n",
      );
      const result = spawnSync(
        "docker",
        [
          "compose",
          "--project-directory",
          dir,
          "--file",
          join(dir, "compose.yml"),
          "config",
          "--format",
          "json",
          "--no-path-resolution",
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const api = JSON.parse(result.stdout).services.api;
      const binds = api.volumes.filter((volume) => volume.type === "bind");
      assert.equal(binds.length, 1);
      assert.equal(binds[0].source, "/run/beam-studio");
      assert.equal(binds[0].target, "/run/beam-studio");
      assert.equal(binds[0].read_only, true);
      assert.notEqual(binds[0].bind?.create_host_path, false);
      assert.equal(
        api.environment.BEAM_UPDATER_SOCKET_PATH,
        "/run/beam-studio/updater.sock",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
