import type { ApiConfig } from "./types.js";

export function readConfig(): ApiConfig {
  return {
    port: envInt("API_PORT", 8787),
  };
}

function envInt(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
