import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

test("DEV action catalog does not retarget the built-in Beam registry", () => {
  const source = `import { webEnv } from ${JSON.stringify(new URL("../env.ts", import.meta.url).href)};
    console.log(JSON.stringify([webEnv.beamActionRegistryUrl, webEnv.beamDefaultRegistryUrl]));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, BEAM_ACTION_REGISTRY_URL: "https://api.dev.example/registry", BEAM_DEFAULT_REGISTRY_URL: "https://api.example/registry" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["https://api.dev.example/registry", "https://api.example/registry"]);
});

test("no environment combination reintroduces an authentication bypass", () => {
  // BEAM_STUDIO_AUTH_BYPASS used to fabricate a SUPERADMIN principal with no
  // organization verification. It is gone; setting it must do nothing at all.
  const source = `import { webEnv } from ${JSON.stringify(new URL("../env.ts", import.meta.url).href)};
    console.log(JSON.stringify(Object.keys(webEnv)));`;
  for (const nodeEnv of ["development", "production"]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: nodeEnv,
          BEAM_STUDIO_AUTH_BYPASS: "true",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const keys = JSON.parse(result.stdout) as string[];
    assert.ok(
      !keys.some((key) => key.toLowerCase().includes("bypass")),
      `webEnv must expose no bypass under NODE_ENV=${nodeEnv}`,
    );
  }
});
