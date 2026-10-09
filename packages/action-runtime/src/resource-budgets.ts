import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { guard, processGuardExecutable } from "./process-ownership.js";

export const resourceBudgetCapability = "action-resource-budgets/v1";

/** The native probe tests cgroup creation, controller writes and process attachment. */
export async function probeActionResourceBudgets() {
  if (process.platform !== "linux") return false;
  try {
    const receipt = await guard({ operation: "budget-probe" });
    return receipt.state === "available" && receipt.scope === resourceBudgetCapability;
  } catch {
    return false;
  }
}

export type ActionResourceBudget = { cpuMillis: number; memoryMiB: number };

export function assertRepresentableResourceBudget(budget: ActionResourceBudget) {
  if (
    !Number.isSafeInteger(budget.cpuMillis) ||
    budget.cpuMillis < 1_000 ||
    budget.cpuMillis > 2 ** 40 ||
    !Number.isSafeInteger(budget.memoryMiB) ||
    budget.memoryMiB < 1 ||
    budget.memoryMiB > 2 ** 20
  ) {
    throw new Error(
      "Registry v2 CPU or peak-memory budget cannot be enforced by this runtime.",
    );
  }
}

export function newActionResourceBudgetToken() {
  return randomBytes(16).toString("hex");
}

export function launchBudgetedSandbox(
  budget: ActionResourceBudget,
  args: string[],
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  token: string,
) {
  assertRepresentableResourceBudget(budget);
  const child = spawn(
    processGuardExecutable(),
    [
      "--budget-launch",
      JSON.stringify({
        token,
        cpuMillis: budget.cpuMillis,
        memoryMiB: budget.memoryMiB,
        executable: process.execPath,
        arguments: args,
      }),
    ],
    {
      env: {
        BEAM_ACTION_CGROUP_PARENT: process.env.BEAM_ACTION_CGROUP_PARENT ?? "",
      },
      stdio,
      windowsHide: true,
    },
  );
  return { child, token };
}

export async function sealActionResourceBudget(token: string) {
  const receipt = await guard({ operation: "budget-seal", token });
  if (receipt.state !== "sealed" || receipt.scope !== resourceBudgetCapability)
    throw new Error("Action process count was not enforced");
}

export async function cleanupActionResourceBudget(token: string) {
  const receipt = await guard({ operation: "budget-cleanup", token });
  if (!receipt.cleanupConfirmed)
    throw new Error("Action budget process cleanup was not confirmed");
  return {
    oomKilled: receipt.oomKilled === true,
    peakMemoryBytes: receipt.peakMemoryBytes,
    cpuUsedMicros: receipt.cpuUsedMicros,
  };
}
