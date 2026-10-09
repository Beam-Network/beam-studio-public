import { createHash } from "node:crypto";
import type {
  ActionArtifact,
  ActionContext,
  ActionJson,
  ActionManifest,
  ActionResult,
  RegisteredActionPackage,
} from "@beam-studio/core";

export const artifactPortLimits = {
  maxArtifactBytes: 32 * 1024,
  maxTotalBytes: 64 * 1024,
  maxArtifacts: 16,
} as const;

type PortSpec = {
  type?: unknown;
  cardinality?: unknown;
  format?: unknown;
  required?: unknown;
};
type PortValue = { base64: string };

function portSpecs(
  manifest: ActionManifest,
  direction: "inputs" | "outputs",
): Record<string, PortSpec> {
  return manifest[direction] ?? {};
}

function assertMediaType(spec: PortSpec, mediaType: string, port: string) {
  if (spec.format !== undefined && spec.format !== mediaType)
    throw new Error(`Artifact port "${port}" has an incompatible media type.`);
}

function kind(schema: PortSpec | undefined) {
  if (
    schema?.type === "artifact[]" ||
    (schema?.type === "artifact" && schema.cardinality === "many")
  )
    return "artifact[]";
  return schema?.type === "artifact" ? "artifact" : null;
}

function bytes(base64: string, limit = artifactPortLimits.maxArtifactBytes) {
  if (typeof base64 !== "string" || base64.length > Math.ceil(limit / 3) * 4)
    throw new Error("Artifact exceeds the per-port byte limit.");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  )
    throw new Error("Artifact content must be canonical base64.");
  const value = Buffer.from(base64, "base64");
  if (value.toString("base64") !== base64)
    throw new Error("Artifact content must be canonical base64.");
  if (value.byteLength > limit)
    throw new Error("Artifact exceeds the per-port byte limit.");
  return value;
}

function digest(value: Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function artifactInput(
  value: ActionJson,
  port: string,
  spec: PortSpec,
  limit = artifactPortLimits.maxArtifactBytes,
): PortValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Artifact input "${port}" must be an artifact descriptor.`);
  const uri = value.uri;
  if (typeof uri === "string" && uri.length > 128 + Math.ceil(limit / 3) * 4)
    throw new Error(
      `Artifact input "${port}" exceeds the per-port byte limit.`,
    );
  const match =
    typeof uri === "string" &&
    /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]*)$/.exec(uri);
  if (
    !match ||
    typeof value.name !== "string" ||
    !value.name ||
    typeof value.type !== "string"
  )
    throw new Error(
      `Artifact input "${port}" has no supported materialized handle.`,
    );
  const data = bytes(match[2]!, limit);
  if (value.mediaType !== undefined && value.mediaType !== match[1])
    throw new Error(`Artifact input "${port}" has a mismatched media type.`);
  assertMediaType(spec, match[1]!, port);
  const metadata = value.metadata;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.bytes !== data.byteLength ||
    metadata.sha256 !== digest(data)
  )
    throw new Error(
      `Artifact input "${port}" failed size or SHA-256 verification.`,
    );
  return { base64: match[2]! };
}

export function assertArtifactPortPublication(
  manifest: ActionManifest,
  artifact: ActionArtifact,
  identity: {
    workflowRunId: string;
    stepRunId: string;
    attempt: number;
    taskId?: string;
    assignmentId?: string;
  },
) {
  const metadata = artifact.metadata;
  const port = metadata?.port;
  const spec =
    typeof port === "string" ? portSpecs(manifest, "outputs")[port] : undefined;
  if (typeof port !== "string" || !kind(spec))
    throw new Error("Artifact publication has no declared output port.");
  if (
    metadata?.workflowRunId !== identity.workflowRunId ||
    metadata?.stepRunId !== identity.stepRunId ||
    metadata?.attempt !== identity.attempt ||
    (identity.taskId !== undefined && metadata?.taskId !== identity.taskId) ||
    (identity.assignmentId !== undefined &&
      metadata?.assignmentId !== identity.assignmentId)
  )
    throw new Error("Artifact publication belongs to another task attempt.");
  artifactInput(
    artifact as ActionJson,
    port,
    spec!,
    manifest.apiVersion === "workflow-actions/v2"
      ? manifest.contracts!.resources.maxArtifactBytes
      : undefined,
  );
  return port;
}

export function assertArtifactPortResult(
  manifest: ActionManifest,
  result: ActionResult,
  identity: {
    workflowRunId: string;
    stepRunId: string;
    attempt: number;
    taskId?: string;
    assignmentId?: string;
  },
  inputs?: Record<string, ActionJson>,
  inputBudget?: { count: number; totalBytes: number },
) {
  const ports = Object.entries(portSpecs(manifest, "outputs")).filter(
    ([, spec]) => kind(spec),
  );
  if (!ports.length) {
    if (result.artifacts?.length)
      throw new Error("Artifact outputs have no declared port.");
    if (
      manifest.apiVersion === "workflow-actions/v2" &&
      Object.keys(result.outputs ?? {}).length
    )
      throw new Error("Result contains an undeclared Registry v2 output port.");
    return;
  }
  if (inputs && inputBudget)
    throw new Error("Artifact input budget has two sources.");
  const materializedInputs = inputs
    ? materializeArtifactInputs(manifest, inputs)
    : inputBudget;
  if (
    materializedInputs &&
    (!Number.isSafeInteger(materializedInputs.count) ||
      !Number.isSafeInteger(materializedInputs.totalBytes) ||
      materializedInputs.count < 0 ||
      materializedInputs.totalBytes < 0 ||
      materializedInputs.count >
        (manifest.apiVersion === "workflow-actions/v2"
          ? manifest.contracts!.resources.maxArtifacts
          : artifactPortLimits.maxArtifacts) ||
      materializedInputs.totalBytes > artifactPortLimits.maxTotalBytes ||
      (manifest.apiVersion === "workflow-actions/v2" &&
        materializedInputs.totalBytes >
          manifest.contracts!.resources.maxInputBytes))
  )
    throw new Error("Artifact input budget exceeds invocation limits.");
  const inputBytes = materializedInputs?.totalBytes ?? 0;
  if (
    (result.artifacts?.length ?? 0) + (materializedInputs?.count ?? 0) >
      (manifest.apiVersion === "workflow-actions/v2"
        ? manifest.contracts!.resources.maxArtifacts
        : artifactPortLimits.maxArtifacts) ||
    (result.artifacts ?? []).reduce(
      (sum, artifact) => sum + Number(artifact.metadata?.bytes ?? 0),
      0,
    ) +
      inputBytes >
      artifactPortLimits.maxTotalBytes
  )
    throw new Error("Artifact result exceeds invocation limits.");
  const grouped = new Map<string, ActionArtifact[]>();
  const outputBytes = (result.artifacts ?? []).reduce(
    (sum, artifact) => sum + Number(artifact.metadata?.bytes ?? 0),
    0,
  );
  if (
    manifest.apiVersion === "workflow-actions/v2" &&
    outputBytes > manifest.contracts!.resources.maxOutputBytes
  )
    throw new Error(
      "Artifact result exceeds Registry v2 output resource limit.",
    );
  for (const artifact of result.artifacts ?? []) {
    const port = assertArtifactPortPublication(manifest, artifact, identity);
    grouped.set(port, [...(grouped.get(port) ?? []), artifact]);
  }
  for (const [port, spec] of ports) {
    const values = grouped.get(port) ?? [];
    if (spec.required === true && !values.length)
      throw new Error(`Required artifact output "${port}" is missing.`);
    if (kind(spec) === "artifact" && values.length > 1)
      throw new Error(`Artifact output "${port}" has invalid cardinality.`);
    const expected = kind(spec) === "artifact[]" ? values : values[0];
    if (
      values.length &&
      JSON.stringify(result.outputs?.[port]) !== JSON.stringify(expected)
    )
      throw new Error(
        `Artifact output "${port}" does not match published evidence.`,
      );
    if (!values.length && result.outputs?.[port] !== undefined)
      throw new Error(`Artifact output "${port}" has no published evidence.`);
  }
  if (
    manifest.apiVersion === "workflow-actions/v2" &&
    Object.keys(result.outputs ?? {}).some(
      (port) => !Object.hasOwn(portSpecs(manifest, "outputs"), port),
    )
  )
    throw new Error("Result contains an undeclared Registry v2 output port.");
}

/** A transport-neutral, bounded port layer shared by Runner and member execution. */
export function prepareArtifactPorts(
  manifest: ActionManifest,
  inputs: Record<string, ActionJson>,
  context: ActionContext,
) {
  const {
    inputPorts,
    count: inputCount,
    totalBytes: inputBytes,
  } = materializeArtifactInputs(manifest, inputs);
  const outputPorts = new Map<
    string,
    { spec: PortSpec; artifacts: ActionArtifact[] }
  >();
  let totalBytes = inputBytes;
  let count = inputCount;
  for (const [port, spec] of Object.entries(portSpecs(manifest, "outputs")))
    if (kind(spec)) outputPorts.set(port, { spec, artifacts: [] });
  const portContract =
    manifest.apiVersion === "workflow-actions/v2" ||
    outputPorts.size > 0 ||
    Object.values(portSpecs(manifest, "inputs")).some((spec) => kind(spec));
  if (portContract && !context.taskId)
    throw new Error("Artifact port execution is missing its task identity.");

  const artifacts: ActionContext["artifacts"] = {
    ...context.artifacts,
    async publish(artifact) {
      if (portContract)
        throw new Error(
          "Artifact publication must use a declared output port.",
        );
      return context.artifacts.publish(artifact);
    },
    async readInput(port, index = 0) {
      context.signal.throwIfAborted();
      if (
        !inputPorts.has(port) ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        !inputPorts.get(port)?.[index]
      )
        throw new Error(
          `Artifact input handle "${port}[${index}]" is unavailable.`,
        );
      return inputPorts.get(port)![index]!.base64;
    },
    async publishOutput(port, base64, options = {}) {
      context.signal.throwIfAborted();
      const output = outputPorts.get(port);
      if (!output)
        throw new Error(`Artifact output port "${port}" is undeclared.`);
      if (kind(output.spec) === "artifact" && output.artifacts.length)
        throw new Error(`Artifact output port "${port}" accepts one artifact.`);
      const data = bytes(
        base64,
        manifest.apiVersion === "workflow-actions/v2"
          ? manifest.contracts!.resources.maxArtifactBytes
          : undefined,
      );
      const mediaType = options.mediaType ?? "application/octet-stream";
      if (
        typeof mediaType !== "string" ||
        !/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)
      )
        throw new Error("Invalid artifact media type.");
      assertMediaType(output.spec, mediaType, port);
      const name = options.name ?? port;
      if (typeof name !== "string" || !name || name.length > 160)
        throw new Error("Invalid artifact name.");
      if (
        count + 1 >
          (manifest.apiVersion === "workflow-actions/v2"
            ? manifest.contracts!.resources.maxArtifacts
            : artifactPortLimits.maxArtifacts) ||
        totalBytes + data.byteLength > artifactPortLimits.maxTotalBytes ||
        (manifest.apiVersion === "workflow-actions/v2" &&
          totalBytes - inputBytes + data.byteLength >
            manifest.contracts!.resources.maxOutputBytes)
      )
        throw new Error(
          "Artifact output publication exceeds the invocation limits.",
        );
      count++;
      totalBytes += data.byteLength;
      const artifact: ActionArtifact = {
        type: "file",
        name,
        uri: `data:${mediaType};base64,${base64}`,
        mediaType,
        metadata: {
          port,
          bytes: data.byteLength,
          sha256: digest(data),
          workflowRunId: context.workflowRunId,
          stepRunId: context.stepRunId,
          attempt: context.attempt,
          ...(context.taskId ? { taskId: context.taskId } : {}),
          ...(context.assignmentId
            ? { assignmentId: context.assignmentId }
            : {}),
        },
      };
      output.artifacts.push(artifact);
      return artifact;
    },
  };
  return {
    context: { ...context, artifacts },
    async finish(result: ActionResult): Promise<ActionResult> {
      context.signal.throwIfAborted();
      if (!outputPorts.size) {
        if (inputPorts.size && result.artifacts?.length)
          throw new Error("Artifact outputs have no declared port.");
        if (
          manifest.apiVersion === "workflow-actions/v2" &&
          Object.keys(result.outputs ?? {}).length
        )
          throw new Error(
            "Result contains an undeclared Registry v2 output port.",
          );
        return result;
      }
      if (result.artifacts?.length)
        throw new Error(
          "Artifact outputs must use declared publishOutput ports.",
        );
      const outputs = { ...result.outputs };
      if (
        manifest.apiVersion === "workflow-actions/v2" &&
        Object.keys(outputs).some((port) => !outputPorts.has(port))
      )
        throw new Error(
          "Result contains an undeclared Registry v2 output port.",
        );
      const published: ActionArtifact[] = [];
      for (const [port, output] of outputPorts) {
        if (output.spec.required === true && !output.artifacts.length)
          throw new Error(`Required artifact output "${port}" is missing.`);
        if (outputs[port] !== undefined)
          throw new Error(
            `Artifact output "${port}" must use its controlled port.`,
          );
        const values: ActionArtifact[] = [];
        for (const artifact of output.artifacts) {
          context.signal.throwIfAborted();
          values.push(await context.artifacts.publish(artifact));
        }
        published.push(...values);
        if (values.length)
          outputs[port] = (
            kind(output.spec) === "artifact[]" ? values : values[0]
          ) as ActionJson;
      }
      return { ...result, outputs, artifacts: published };
    },
  };
}

export function assertArtifactPortInputs(
  manifest: ActionManifest,
  inputs: Record<string, ActionJson>,
) {
  materializeArtifactInputs(manifest, inputs);
}

export async function executeWithArtifactPorts(
  action: RegisteredActionPackage,
  input: Parameters<RegisteredActionPackage["execute"]>[0],
  context: ActionContext,
): Promise<ActionResult> {
  const ports = prepareArtifactPorts(action.manifest, input.inputs, context);
  return ports.finish(await action.execute(input, ports.context));
}

function materializeArtifactInputs(
  manifest: ActionManifest,
  inputs: Record<string, ActionJson>,
) {
  const inputPorts = new Map<string, PortValue[]>();
  let totalBytes = 0;
  let count = 0;
  for (const [port, spec] of Object.entries(portSpecs(manifest, "inputs"))) {
    const portKind = kind(spec);
    if (!portKind) continue;
    const value = inputs[port];
    if (value === undefined || value === null) {
      if (spec.required === true)
        throw new Error(`Required artifact input "${port}" is missing.`);
      continue;
    }
    if ((portKind === "artifact[]") !== Array.isArray(value))
      throw new Error(`Artifact input "${port}" has the wrong cardinality.`);
    if (
      Array.isArray(value) &&
      count + value.length >
        (manifest.apiVersion === "workflow-actions/v2"
          ? manifest.contracts!.resources.maxArtifacts
          : artifactPortLimits.maxArtifacts)
    )
      throw new Error(
        "Artifact input preparation exceeds the invocation limits.",
      );
    const values = (Array.isArray(value) ? value : [value]).map((entry) =>
      artifactInput(
        entry,
        port,
        spec,
        manifest.apiVersion === "workflow-actions/v2"
          ? manifest.contracts!.resources.maxArtifactBytes
          : undefined,
      ),
    );
    if (spec.required === true && values.length === 0)
      throw new Error(`Required artifact input "${port}" is empty.`);
    count += values.length;
    totalBytes += values.reduce(
      (sum, entry) => sum + bytes(entry.base64).byteLength,
      0,
    );
    inputPorts.set(port, values);
  }
  if (
    count >
      (manifest.apiVersion === "workflow-actions/v2"
        ? manifest.contracts!.resources.maxArtifacts
        : artifactPortLimits.maxArtifacts) ||
    totalBytes > artifactPortLimits.maxTotalBytes ||
    (manifest.apiVersion === "workflow-actions/v2" &&
      totalBytes > manifest.contracts!.resources.maxInputBytes)
  )
    throw new Error(
      "Artifact input preparation exceeds the invocation limits.",
    );
  return { inputPorts, count, totalBytes };
}
