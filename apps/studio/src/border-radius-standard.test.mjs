import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const thisFile = fileURLToPath(import.meta.url);
const stringLiteralPattern =
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gs;
const radiusClassPattern =
  /\brounded(?:-(?:[a-z0-9]+|\[[^\]]+\]))*(?=[\s"'`)}\]])/g;
const semanticRadiusPattern =
  /^rounded(?:(?:-(?:t|b|l|r|tl|tr|bl|br))?-(?:badge|control|control-compact|surface)|-(?:full|none))$/;

test("Studio uses semantic border-radius classes", async () => {
  const files = await sourceFiles(sourceRoot);
  const violations = [];

  for (const file of files) {
    if (file === thisFile) continue;

    const source = await readFile(file, "utf8");
    for (const literal of source.matchAll(stringLiteralPattern)) {
      const classText = literal[0].replace(/\$\{[^}]*\}/g, "");
      for (const match of classText.matchAll(radiusClassPattern)) {
        const className = match[0];
        if (!semanticRadiusPattern.test(className)) {
          violations.push(`${relativePath(file)}: ${className}`);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Use the semantic radius classes documented in docs/studio-border-radius-standard.md:\n${violations.join("\n")}`,
  );
});

test("the default surface radius stays concentric with its inner control", async () => {
  const styles = await readFile(`${sourceRoot}styles.css`, "utf8");

  assert.match(styles, /--radius-surface-inset:\s*0\.25rem;/);
  assert.match(
    styles,
    /--radius-surface:\s*calc\(\s*var\(--radius-control\)\s*\+\s*var\(--radius-surface-inset\)\s*\);/,
  );
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

function relativePath(file) {
  return file.slice(sourceRoot.length + 1);
}
