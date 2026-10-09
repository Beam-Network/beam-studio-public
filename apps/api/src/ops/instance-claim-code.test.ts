import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { instanceClaimCode } from "@beam-studio/shared/instance-claim";
import { claimCodeOutput } from "./instance-claim-code.js";

const secret = "claim-code-test-key-0000000000000000";
const code = instanceClaimCode(secret);

test("an unclaimed or adopted Studio prints the code the claim route accepts", () => {
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  for (const state of ["unclaimed", "adopted"] as const) {
    for (const unclaimedOnly of [true, false]) {
      assert.deepEqual(claimCodeOutput({ state, unclaimedOnly, secret }), {
        stdout: `${code}\n`,
        stderr: "",
      });
    }
  }
});

test("a claimed Studio prints the code only when asked for it explicitly", () => {
  const quiet = claimCodeOutput({
    state: "claimed",
    unclaimedOnly: true,
    secret,
  });
  assert.equal(quiet.stdout, "");
  assert.match(quiet.stderr, /already claimed/);

  const explicit = claimCodeOutput({
    state: "claimed",
    unclaimedOnly: false,
    secret,
  });
  assert.equal(explicit.stdout, `${code}\n`);
  assert.match(explicit.stderr, /already claimed/);
});

test("an unreadable state still prints the code, and says why", () => {
  const output = claimCodeOutput({ state: null, unclaimedOnly: true, secret });
  assert.equal(output.stdout, `${code}\n`);
  assert.match(output.stderr, /Could not read/);
  assert.doesNotMatch(output.stderr, new RegExp(code));
});

test("the code cannot be derived without the key", () => {
  assert.throws(
    () => claimCodeOutput({ state: "unclaimed", unclaimedOnly: true, secret: " " }),
    /BEAM_STUDIO_SECRET_KEY is required/,
  );
});

// The entry point beam-updater runs in the api container, end to end.
const cli = fileURLToPath(
  new URL("./instance-claim-code-cli.ts", import.meta.url),
);

function runCli(args: string[], env: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    ["--conditions=development", "--import", "tsx", cli, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 30_000,
    },
  );
}

test("the CLI prints only the code on stdout, derived from the container's key", () => {
  const result = runCli([], { BEAM_STUDIO_SECRET_KEY: secret });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${code}\n`);
});

test("the CLI still prints the code when the database is unreachable", () => {
  const result = runCli(["--unclaimed-only"], {
    BEAM_STUDIO_SECRET_KEY: secret,
    DATABASE_URL: "postgres://beam:beam@127.0.0.1:1/beam_studio",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${code}\n`);
  assert.match(result.stderr, /Could not read/);
});

test("the CLI fails without a key instead of printing a wrong code", () => {
  const result = runCli([], { BEAM_STUDIO_SECRET_KEY: "" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /BEAM_STUDIO_SECRET_KEY is required/);
});
