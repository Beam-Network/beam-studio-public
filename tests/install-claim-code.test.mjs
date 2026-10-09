import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A fresh installation serves nobody until a team claims it with a code
 * derived from BEAM_STUDIO_SECRET_KEY. The installer is the one moment the
 * operator is certainly at a terminal on the host, so it prints the code there
 * (asked of the running api container through `beam-updater claim-code`), and
 * nowhere a log would keep it.
 */
const INSTALLER = fileURLToPath(
  new URL("../scripts/install-beam-studio.sh", import.meta.url),
);
const CODE = "ABCD-EFGH-JKLM-NPQR";

/**
 * Runs print_claim_instructions against a fake updater that records its
 * arguments and answers like `beam-updater claim-code --unclaimed-only`.
 */
function printClaimInstructions({ updater, terminal, publicUrl }) {
  const dir = mkdtempSync(join(tmpdir(), "beam-install-claim-"));
  try {
    const fake = join(dir, "beam-updater");
    const argsFile = join(dir, "args");
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf '%s\\n' "$@" >"${argsFile}"\n${updater}\n`,
    );
    chmodSync(fake, 0o755);
    const result = spawnSync(
      "sh",
      [
        "-c",
        [
          '. "$INSTALLER"',
          'UPDATER_PATH="$FAKE_UPDATER"',
          'CONFIG_PATH="$FAKE_CONFIG"',
          `stdout_is_terminal() { return ${terminal ? 0 : 1}; }`,
          "print_claim_instructions",
        ].join(" && "),
        "install-claim-test",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          INSTALLER,
          BEAM_STUDIO_INSTALLER_SOURCE_ONLY: "1",
          BEAM_STUDIO_PUBLIC_URL: publicUrl ?? "https://studio.example.com",
          FAKE_UPDATER: fake,
          FAKE_CONFIG: "/etc/beam-studio/updater.json",
        },
      },
    );
    let args = null;
    try {
      args = readFileSync(argsFile, "utf8").trim().split("\n");
    } catch {
      // The fake was never called.
    }
    return { ...result, args };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an unclaimed install prints the claim code and where to use it", () => {
  const result = printClaimInstructions({
    updater: `printf '%s\\n' '${CODE}'`,
    terminal: true,
    publicUrl: "https://studio.example.com/",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.args, [
    "claim-code",
    "--config",
    "/etc/beam-studio/updater.json",
    "--unclaimed-only",
  ]);
  assert.match(result.stdout, new RegExp(`Claim code: ${CODE}\\n`));
  assert.match(result.stdout, /https:\/\/studio\.example\.com\/settings\/access/);
  assert.match(result.stdout, /Needed once/);
  assert.match(result.stdout, /sudo beam-updater claim-code/);
  assert.doesNotMatch(result.stderr, new RegExp(CODE));
});

test("the code is not printed when the output is not a terminal", () => {
  // cloud-init and CI keep the installer's output in a log file.
  const result = printClaimInstructions({
    updater: `printf '%s\\n' '${CODE}'`,
    terminal: false,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(CODE));
  assert.match(result.stdout, /not claimed yet/);
  assert.match(result.stdout, /sudo beam-updater claim-code/);
});

test("a rerun on a claimed install prints nothing about claiming", () => {
  const result = printClaimInstructions({ updater: "exit 0", terminal: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("an updater or api image without the command still tells the operator how", () => {
  const result = printClaimInstructions({
    updater: "echo 'usage: beam-updater ...' >&2; exit 1",
    terminal: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/settings\/access/);
  assert.match(result.stdout, /sudo beam-updater claim-code/);
  // The updater's own error is not echoed at the operator.
  assert.equal(result.stderr, "");
});
