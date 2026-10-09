import type { ActionJson, ActionLogger } from "@beam-studio/core";
import type { TaskWorkerOptions } from "./taskTypes.js";
import { redactTelemetryValue } from "@beam-studio/telemetry";

export function memoryStorage() {
  const values = new Map<string, ActionJson>();
  return {
    getJson: async (key: string) => values.get(key),
    putJson: async (key: string, value: ActionJson) => {
      values.set(key, value);
    },
  };
}

export function actionLogger(options: TaskWorkerOptions): ActionLogger {
  return {
    debug(message, payload) {
      options.logger.debug(redactTelemetryValue(payload), message);
    },
    info(message, payload) {
      options.logger.info(redactTelemetryValue(payload), message);
    },
    warn(message, payload) {
      options.logger.warn(redactTelemetryValue(payload), message);
    },
    error(message, payload) {
      options.logger.error(redactTelemetryValue(payload), message);
    },
  };
}
