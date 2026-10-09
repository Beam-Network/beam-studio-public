import type { ActionExecute, ActionJson } from "../../actions.js";
import { beamActionManifest } from "./manifest.js";

export const fanOutActionManifest = beamActionManifest({
  name: "@beam/fan-out",
  displayName: "Fan-out",
  description:
    "Opens multiple downstream workflow branches after one upstream step.",
  inputs: {
    value: {},
  },
  outputs: {
    value: {},
    status: { type: "string" },
  },
  catalog: {
    category: "control-flow",
    maturity: "experimental",
    tags: ["branch", "fan-out", "parallel"],
  },
});

export const joinActionManifest = beamActionManifest({
  name: "@beam/join",
  displayName: "Join",
  description: "Waits for multiple workflow branches before continuing.",
  inputs: {
    value: {},
    values: { type: "array" },
  },
  outputs: {
    value: {},
    values: { type: "array" },
    status: { type: "string" },
  },
  catalog: {
    category: "control-flow",
    maturity: "experimental",
    tags: ["join", "fan-in", "parallel"],
  },
});

const fanOutExecute: ActionExecute = ({ inputs, config }) => ({
  outputs: {
    value: valueOrNull(inputs.value ?? config.value),
    status: "ready",
  },
});

const joinExecute: ActionExecute = ({ inputs }) => {
  const values = Array.isArray(inputs.values) ? inputs.values : [];
  return {
    outputs: {
      value: valueOrNull(inputs.value ?? values[0]),
      values,
      status: "joined",
    },
  };
};

export const fanOutAction = {
  manifest: fanOutActionManifest,
  execute: fanOutExecute,
};

export const joinAction = {
  manifest: joinActionManifest,
  execute: joinExecute,
};

function valueOrNull(value: ActionJson | undefined): ActionJson {
  return value === undefined ? null : value;
}
