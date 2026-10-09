import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = "BEAM_STUDIO_ROOM_SERVICE_CREDENTIALS";
const forbidden = [prefix];
const targets = [
  ".github/workflows",
  "apps",
  "deploy",
  "docs",
  "packages",
  "README.md",
  ...readdirSync(root).filter((name) => /^docker-compose.*\.ya?ml$/.test(name)),
];
const failures = [];

for (const target of targets) scan(resolve(root, target));

if (failures.length) {
  throw new Error(
    `Obsolete room-service configuration path(s) remain:\n${failures.join("\n")}`,
  );
}
console.log("Room-service configuration surface is clean.");

function scan(path) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    if (["node_modules", "dist", ".output"].includes(basename(path))) return;
    for (const entry of readdirSync(path)) scan(join(path, entry));
    return;
  }
  if (!/\.(?:md|mjs|ts|tsx|yml|yaml)$/.test(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const term of forbidden) {
      if (line.includes(term)) {
        failures.push(`${relative(root, path)}:${index + 1}: ${term}`);
      }
    }
  });
}
