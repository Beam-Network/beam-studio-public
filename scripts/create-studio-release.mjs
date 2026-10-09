import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const options = parseArguments(process.argv.slice(2));
const version = normalizeVersion(required(options, "version"));
const channel = options.channel || "stable";
const sequence = positiveInteger(required(options, "sequence"), "sequence");
const sourceRevision = required(options, "source-revision");
const outputDir = resolve(options["output-dir"] || "dist/studio-release");
const installTemplatePath = resolve(
  options["install-template"] || "scripts/install-beam-studio.sh",
);
const privateKeyPem =
  process.env.BEAM_STUDIO_RELEASE_SIGNING_KEY ||
  (options["private-key"]
    ? await readFile(resolve(options["private-key"]), "utf8")
    : "");

if (!privateKeyPem) {
  throw new Error(
    "Set BEAM_STUDIO_RELEASE_SIGNING_KEY or pass --private-key to sign the control plane.",
  );
}

const privateKey = createPrivateKey(privateKeyPem);
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("The Beam Studio release signing key must use Ed25519.");
}
const publicKeyObject = createPublicKey(privateKey);
const publicKey = publicKeyObject.export({ format: "pem", type: "spki" });
const installTemplate = await readFile(installTemplatePath, "utf8");
const publicKeyMarker = "@BEAM_STUDIO_RELEASE_PUBLIC_KEY_BASE64@";
if (!installTemplate.includes(publicKeyMarker)) {
  throw new Error(
    `Installer template ${installTemplatePath} is missing ${publicKeyMarker}.`,
  );
}
const defaultChannelMarker = "@BEAM_STUDIO_DEFAULT_CHANNEL@";
if (!installTemplate.includes(defaultChannelMarker)) {
  throw new Error(
    `Installer template ${installTemplatePath} is missing ${defaultChannelMarker}.`,
  );
}
const cdnBaseUrlMarker = "@BEAM_STUDIO_PUBLISHED_CDN_BASE_URL@";
if (!installTemplate.includes(cdnBaseUrlMarker)) {
  throw new Error(
    `Installer template ${installTemplatePath} is missing ${cdnBaseUrlMarker}.`,
  );
}
const cdnBaseUrl = normalizeCdnBaseUrl(
  options["cdn-base-url"] || "https://cdn.b1m.ai/studio",
);
const installer = installTemplate
  .replaceAll(publicKeyMarker, Buffer.from(publicKey).toString("base64"))
  .replaceAll(defaultChannelMarker, channel)
  .replaceAll(cdnBaseUrlMarker, cdnBaseUrl);

if (!/^[a-f0-9]{40}$/.test(sourceRevision)) {
  throw new Error("--source-revision must be a full lowercase Git commit.");
}
if (!["dev", "nightly", "stable"].includes(channel)) {
  throw new Error(`Unsupported release channel: ${channel}`);
}

const images = Object.fromEntries(
  [
    "api",
    "mcp",
    "nats",
    "orchestrator",
    "postgres",
    "room-consumer",
    "studio",
    "worker",
  ].map((key) => [key, immutableImage(required(options, `image-${key}`), key)]),
);
const updater = immutableBeamImage(
  required(options, "updater-image"),
  "updater",
);

const existing = options["existing-control-plane"]
  ? await readExistingControlPlane(
      resolve(options["existing-control-plane"]),
      publicKeyObject,
    )
  : null;
const previousSequence = Number(existing?.channels?.[channel]?.sequence || 0);
if (sequence <= previousSequence) {
  throw new Error(
    `Sequence ${sequence} must be greater than existing ${channel} sequence ${previousSequence}.`,
  );
}

const publishedAt = options["published-at"] || new Date().toISOString();
const release = {
  sequence,
  version,
  sourceRevision,
  publishedAt,
  minimumUpdaterVersion: normalizeVersion(
    options["minimum-updater-version"] || "1.0.0",
  ),
  deploymentSchemaVersion: positiveInteger(
    options["deployment-schema-version"] || "1",
    "deployment-schema-version",
  ),
  updater,
  images,
  ...(options["release-notes-url"]
    ? { releaseNotesUrl: options["release-notes-url"] }
    : {}),
  rollbackSafe: options["rollback-safe"] !== "false",
  requiresBackup: options["requires-backup"] !== "false",
  ...(options["allow-downgrade"] === "true" ? { allowDowngrade: true } : {}),
};
const unsigned = {
  schemaVersion: 1,
  generatedAt: options["generated-at"] || new Date().toISOString(),
  channels: {
    ...(existing?.channels || {}),
    [channel]: release,
  },
};
const signature = sign(
  null,
  Buffer.from(canonicalJSON(unsigned)),
  privateKey,
).toString("base64");
const controlPlane = { ...unsigned, signature };

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(
    join(outputDir, "latest.json"),
    `${JSON.stringify(controlPlane, null, 2)}\n`,
    { mode: 0o640 },
  ),
  writeFile(join(outputDir, "beam-studio-release-key.pem"), publicKey, {
    mode: 0o644,
  }),
  writeFile(join(outputDir, "install.sh"), installer, { mode: 0o755 }),
]);

console.log(
  JSON.stringify(
    {
      channel,
      output: join(outputDir, "latest.json"),
      sequence,
      version,
    },
    null,
    2,
  ),
);

async function readExistingControlPlane(path, verificationKey) {
  const data = JSON.parse(await readFile(path, "utf8"));
  const signature = data.signature;
  delete data.signature;
  if (
    data.schemaVersion !== 1 ||
    typeof signature !== "string" ||
    !verify(
      null,
      Buffer.from(canonicalJSON(data)),
      verificationKey,
      Buffer.from(signature, "base64"),
    )
  ) {
    throw new Error(
      "Existing control plane has an invalid signature or schema.",
    );
  }
  return data;
}

function immutableImage(value, key) {
  if (key === "postgres") {
    return imageWithPrefix(value, key, "docker.io/library/postgres@sha256:");
  }
  if (key === "nats") {
    return imageWithPrefix(value, key, "docker.io/library/nats@sha256:");
  }
  return immutableBeamImage(value, key);
}

function immutableBeamImage(value, key) {
  return imageWithPrefix(value, key, "ghcr.io/beam-network/beam-studio-");
}

function imageWithPrefix(value, key, prefix) {
  if (
    !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(value)
  ) {
    throw new Error(
      `Image ${key} must use an immutable image@sha256 reference.`,
    );
  }
  if (!value.startsWith(prefix)) {
    throw new Error(`Image ${key} is outside its approved registry namespace.`);
  }
  return value;
}

function canonicalJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeCdnBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid CDN base URL: ${value}`);
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeVersion(value) {
  const version = value.startsWith("v") ? value : `v${value}`;
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return version;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return number;
}

function parseArguments(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const key = argument.slice(2);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function required(values, key) {
  const value = values[key];
  if (!value) {
    throw new Error(`Missing required option --${key}.`);
  }
  return value;
}
