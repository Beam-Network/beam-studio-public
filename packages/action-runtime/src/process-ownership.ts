import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ActionProcessOwnership = { path: string; nonce: string };
type Receipt = {
  protocol: string;
  nonce?: string;
  state?: string;
  scope?: string;
  hostIdentity?: string;
  bootId?: string;
  nativeScope?: string;
  cleanupConfirmed: boolean;
  error?: string;
  oomKilled?: boolean;
  peakMemoryBytes?: number;
  cpuUsedMicros?: number;
};
export const ownershipProtocol = "action-process-ownership/v1";

export function processGuardExecutable() {
  return fileURLToPath(
    new URL(
      `../native/process-guard-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
}

export async function guard(
  request: Record<string, unknown>,
): Promise<Receipt> {
  const executable = processGuardExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        BEAM_ACTION_CGROUP_PARENT: process.env.BEAM_ACTION_CGROUP_PARENT ?? "",
      },
    });
    let output = "";
    const timeout = setTimeout(() => child.kill(), 8_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 16 * 1024) child.kill();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      let receipt: Receipt;
      try {
        receipt = JSON.parse(output);
      } catch {
        reject(new Error("Process ownership helper did not return a receipt"));
        return;
      }
      if (
        code !== 0 ||
        receipt.protocol !== ownershipProtocol ||
        receipt.error
      ) {
        reject(new Error(receipt.error ?? "Process ownership helper failed"));
        return;
      }
      resolve(receipt);
    });
    child.stdin.on("error", () => {
      /* Exit/error provides the authoritative failure. */
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export type ProcessOwnershipHostEvidence = {
  ownerScope: string;
  hostIdentity: string;
  bootId: string;
  nativeScope: string;
};

let localEvidence: Promise<ProcessOwnershipHostEvidence> | undefined;
export function getProcessOwnershipHostEvidence(): Promise<ProcessOwnershipHostEvidence> {
  return (localEvidence ??= guard({ operation: "probe" })
    .then((receipt) => {
      if (
        receipt.state !== "available" ||
        !receipt.scope ||
        !receipt.hostIdentity ||
        !receipt.bootId ||
        !receipt.nativeScope
      )
        throw new Error("Native process ownership evidence is unavailable");
      return {
        ownerScope: createHash("sha256").update(receipt.scope).digest("hex"),
        hostIdentity: receipt.hostIdentity,
        bootId: receipt.bootId,
        nativeScope: receipt.nativeScope,
      };
    })
    .catch((error) => {
      localEvidence = undefined;
      throw error;
    }));
}
export function getProcessOwnershipScope(): Promise<string> {
  return getProcessOwnershipHostEvidence().then(
    (evidence) => evidence.ownerScope,
  );
}
export async function probeProcessOwnership() {
  await getProcessOwnershipScope();
  return true;
}
export async function prepareProcessOwnership(
  directory: string,
  identity: string,
  ownerPid = process.pid,
): Promise<ActionProcessOwnership> {
  const recordPath = path.join(
    path.resolve(directory),
    `${createHash("sha256").update(identity).digest("hex")}.json`,
  );
  const receipt = await guard({
    operation: "prepare",
    path: recordPath,
    pid: ownerPid,
  });
  if (!receipt.nonce || receipt.state !== "prepared")
    throw new Error("Process ownership was not prepared");
  return { path: recordPath, nonce: receipt.nonce };
}
export async function registerProcessController(
  ownership: ActionProcessOwnership,
) {
  await guard({ operation: "controller", ...ownership, pid: process.pid });
}
export async function bindActionResourceBudget(
  ownership: ActionProcessOwnership,
  token: string,
) {
  const receipt = await guard({
    operation: "bind-budget",
    ...ownership,
    token,
  });
  if (receipt.state !== "prepared")
    throw new Error("Action resource budget was not durably bound");
}
export async function grantSandboxExecution(
  ownership: ActionProcessOwnership,
  pid: number,
  budgetToken?: string,
) {
  const receipt = await guard({
    operation: "grant",
    ...ownership,
    pid,
    token: budgetToken,
  });
  if (receipt.state !== "running")
    throw new Error("Sandbox execution was not durably authorized");
}
export async function recordSandboxStopped(ownership: ActionProcessOwnership) {
  const receipt = await guard({ operation: "stopped", ...ownership });
  if (!receipt.cleanupConfirmed)
    throw new Error("Sandbox termination was not confirmed");
}
export async function reconcileProcessOwnership(
  ownership: ActionProcessOwnership,
) {
  return guard({ operation: "reconcile", ...ownership });
}
