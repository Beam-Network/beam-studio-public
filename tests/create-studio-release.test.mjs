import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../scripts/create-studio-release.mjs", import.meta.url),
);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const digest = (character) => `sha256:${character.repeat(64)}`;
const beam = (name, character) =>
  `ghcr.io/beam-network/beam-studio-runtime-${name}@${digest(character)}`;

const IMAGES = {
  api: beam("api", "1"),
  mcp: beam("mcp", "2"),
  orchestrator: beam("action-dispatcher", "3"),
  worker: beam("action-runner", "4"),
  studio: beam("web", "5"),
  "room-consumer": beam("room-consumer", "6"),
  postgres: `docker.io/library/postgres@${digest("7")}`,
  nats: `docker.io/library/nats@${digest("8")}`,
};

function createRelease(images) {
  const outputDir = mkdtempSync(join(tmpdir(), "beam-studio-release-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const args = [
    SCRIPT,
    "--version",
    "v1.2.3",
    "--channel",
    "dev",
    "--sequence",
    "7",
    "--source-revision",
    "a".repeat(40),
    "--updater-image",
    beam("updater", "9"),
    "--output-dir",
    outputDir,
  ];
  for (const [key, reference] of Object.entries(images)) {
    args.push(`--image-${key}`, reference);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      BEAM_STUDIO_RELEASE_SIGNING_KEY: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    },
  });
  return { result, outputDir };
}

test("the signed release lists the room consumer image", () => {
  const { result, outputDir } = createRelease(IMAGES);
  try {
    assert.equal(result.status, 0, result.stderr);
    const latest = JSON.parse(
      readFileSync(join(outputDir, "latest.json"), "utf8"),
    );
    assert.equal(
      latest.channels.dev.images["room-consumer"],
      IMAGES["room-consumer"],
    );
    assert.deepEqual(
      Object.keys(latest.channels.dev.images).sort(),
      Object.keys(IMAGES).sort(),
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("a release without the room consumer image is refused", () => {
  const { "room-consumer": _omitted, ...rest } = IMAGES;
  const { result, outputDir } = createRelease(rest);
  rmSync(outputDir, { recursive: true, force: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required option --image-room-consumer/);
});

for (const [label, reference] of [
  [
    "outside the approved namespace",
    `ghcr.io/example/room-consumer@${digest("6")}`,
  ],
  [
    "a mutable tag",
    "ghcr.io/beam-network/beam-studio-runtime-room-consumer:dev",
  ],
]) {
  test(`a room consumer image ${label} is refused`, () => {
    const { result, outputDir } = createRelease({
      ...IMAGES,
      "room-consumer": reference,
    });
    rmSync(outputDir, { recursive: true, force: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Image room-consumer/);
  });
}

test("every release image has a placeholder in the release template", () => {
  const template = readFileSync(
    join(ROOT, "deploy/compose.release.template.yml"),
    "utf8",
  );
  for (const key of Object.keys(IMAGES)) {
    const placeholder = `@IMAGE_${key.toUpperCase().replaceAll("-", "_")}@`;
    assert.ok(template.includes(placeholder), `missing ${placeholder}`);
  }
});
