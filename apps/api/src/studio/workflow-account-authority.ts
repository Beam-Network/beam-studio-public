import { webEnv } from "../env.js";

export function workflowAccountApiUrl(_run: unknown): string {
  return webEnv.apiUrl;
}

export function workflowManagedEnvironment(_run: unknown): string | undefined {
  return undefined;
}
