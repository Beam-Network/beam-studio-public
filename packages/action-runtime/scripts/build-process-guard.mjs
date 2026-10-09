import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = process.argv.includes("--all")
  ? [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
      ["win32", "arm64"],
    ]
  : [[process.platform, process.arch]];
mkdirSync(path.join(root, "native"), { recursive: true });
for (const [platform, arch] of targets) {
  if (
    !["linux", "win32"].includes(platform) ||
    !["x64", "arm64"].includes(arch)
  )
    throw new Error(`Unsupported process guard target ${platform}/${arch}`);
  const executable = path.join(
    root,
    "native",
    `process-guard-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`,
  );
  const result = spawnSync(
    "go",
    ["build", "-trimpath", "-o", executable, "."],
    {
      cwd: path.join(root, "process-guard"),
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: platform === "win32" ? "windows" : platform,
        GOARCH: arch === "x64" ? "amd64" : arch,
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
