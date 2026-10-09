import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  reconcileProcessOwnership,
  type ActionProcessOwnership,
} from "./process-ownership.js";
import { probeActionResourceBudgets } from "./resource-budgets.js";

for (const budgeted of [false, ...(await probeActionResourceBudgets() ? [true] : [])]) test(
  `a crashed executor's ${budgeted ? "budgeted " : ""}CPU-busy sandbox is fenced and terminated before recovery confirms cleanup`,
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "beam-process-recovery-"),
    );
    const ownerPath = path.join(directory, "owner.mjs");
    const actionPath = path.join(directory, "action.mjs");
    await writeFile(
      actionPath,
      `export async function execute(_,ctx){await ctx.state.patch({started:true});while(true){}}`,
    );
    await writeFile(
      ownerPath,
      `
    import {sandboxedActionExecute} from ${JSON.stringify(new URL("./actionSandbox.ts", import.meta.url).href)};
    import {prepareProcessOwnership,registerProcessController} from ${JSON.stringify(new URL("./process-ownership.ts", import.meta.url).href)};
    const ownership=await prepareProcessOwnership(${JSON.stringify(path.join(directory, "records"))},'crash-test');
    await registerProcessController(ownership);
    process.send({ownership});
    const noop=()=>{};
    const execute=sandboxedActionExecute({entrypointPath:${JSON.stringify(actionPath)},actionCacheDir:${JSON.stringify(path.join(directory, "cache"))},processOwnership:ownership,resourceBudget:${budgeted ? JSON.stringify({ cpuMillis: 10_000, memoryMiB: 256, timeoutSeconds: 12 }) : "undefined"},allowedRpcMethods:['state.patch'],logger:{info:noop,warn:noop,error:noop,debug:noop}});
    await execute({config:{},inputs:{}},{workflowRunId:'run',stepRunId:'step',stepId:'step',attempt:1,logger:{info:noop,warn:noop,error:noop,debug:noop},state:{get:()=>({}),set:async()=>{},patch:async()=>{process.send({started:true})}},storage:{getJson:async()=>undefined,putJson:async()=>{}},artifacts:{publish:async()=>{}},secrets:{get:async()=>null},beam:{objectStorage:{}},signal:new AbortController().signal});
  `,
    );
    const owner = fork(ownerPath, [], {
      execArgv: [
        "--conditions=development",
        "--import",
        pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      ],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      ...{ windowsHide: true },
    });
    let ownership: ActionProcessOwnership | undefined;
    let diagnostics = "";
    owner.stderr?.on("data", (chunk) => {
      diagnostics += String(chunk);
    });
    t.after(async () => {
      if (owner.exitCode === null && owner.signalCode === null) {
        const exited = once(owner, "exit");
        owner.kill("SIGKILL");
        await exited;
      }
      if (ownership) await reconcileProcessOwnership(ownership);
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve, reject) => {
      owner.on(
        "message",
        (message: {
          ownership?: ActionProcessOwnership;
          started?: boolean;
        }) => {
          if (message.ownership) ownership = message.ownership;
          if (message.started) resolve();
        },
      );
      owner.once("error", reject);
      owner.once("exit", () =>
        reject(new Error(`Owner exited before action start: ${diagnostics}`)),
      );
    });
    assert.ok(ownership);
    assert.equal(
      (await reconcileProcessOwnership(ownership)).cleanupConfirmed,
      false,
    );
    const record = JSON.parse(await readFile(ownership.path, "utf8"));
    assert.equal(record.state, "running");
    assert.equal(Boolean(record.budgetToken), budgeted);
    assert.notEqual(record.sandbox.pid, owner.pid);
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
    const receipt = await reconcileProcessOwnership(ownership);
    assert.equal(receipt.cleanupConfirmed, true);
    assert.equal(receipt.state, "stopped");
    assert.equal(
      (await reconcileProcessOwnership(ownership)).cleanupConfirmed,
      true,
    );
  },
);
