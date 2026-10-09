import type { Node } from "@xyflow/react";
import {
  formatCreditAmount,
  formatCredits,
  toHundredths,
} from "@/lib/format-credits";
import { stringValue } from "./workflow-config-schema";
import {
  BEAM_TRANSFER_ACTION,
  OBJECT_STORAGE_ENDPOINT_ACTION,
} from "./workflow-graph-constants";
import { isStepNode } from "./workflow-graph-model";
import type {
  ObjectListPayload,
  WorkflowCanvasNodeData,
  WorkflowNodeData,
} from "./workflow-graph-types";

/** A transfer step described for pricing: what it moves and where it lands. */
export type TransferProjection = {
  stepId: string;
  label: string;
  /** Summed source bytes, or null when nothing about this transfer could be sized. */
  sourceBytes: string | null;
  destinationCount: number;
  /** The byte count is a floor: a listing was cut short, or a source went unsized. */
  partial: boolean;
  /**
   * The transfer step's Beam credential, blank when it names none. Without a
   * key selected in Workflow Settings, the run is charged to this one.
   */
  credentialId: string;
};

export type WorkflowEstimateLine = {
  kind: "workflow-run" | "transfer";
  label: string;
  stepId?: string;
  credits: number;
  bytes: string | null;
  volumeUnknown: boolean;
  partial: boolean;
};

export type WorkflowCreditEstimate = {
  total: number;
  atLeast: boolean;
  lines: WorkflowEstimateLine[];
  /**
   * Credits the billing key may spend right now, at two decimals (never more
   * than the balance) and never below zero, or null when no balance bounds it. Absent when the balance
   * could not be read.
   */
  availableCredits?: number | null;
};

/** An estimate the billing key cannot pay: what it needs, and what it has. */
export type CreditShortfall = {
  needed: number;
  available: number;
  /** `needed` is a floor, as the estimate's own total is. */
  atLeast: boolean;
};

/**
 * Whether the run would need more credits than the key can spend.
 *
 * Compares the total the pill shows, exactly at two decimals. For a floor ("≥ N")
 * that is still a shortfall: the run cannot cost less. No balance, or no bound
 * on it, is never a shortfall — a warning nobody can confirm is noise.
 */
export function creditShortfall(
  estimate: WorkflowCreditEstimate,
): CreditShortfall | null {
  const available = estimate.availableCredits;
  if (
    typeof available !== "number" ||
    toHundredths(estimate.total) <= toHundredths(available)
  )
    return null;
  return {
    needed: estimate.total,
    available: Math.max(0, available),
    atLeast: estimate.atLeast,
  };
}

/** What the shortfall means for the operator, and where it is fixed. */
export function creditShortfallMessage(shortfall: CreditShortfall) {
  const availableAmount = formatCreditAmount(shortfall.available);
  const available =
    availableAmount === "0"
      ? "no credits are"
      : `only ${availableAmount} ${availableAmount === "1" ? "is" : "are"}`;
  return `This run needs ${shortfall.atLeast ? "at least" : "about"} ${formatCredits(
    shortfall.needed,
  )}, but ${available} available. Add credits in the Console.`;
}

export type ObjectLister = (input: {
  bucket: string;
  credentialId: string;
  prefix: string;
}) => Promise<ObjectListPayload>;

const ENDPOINT_BINDING = /^\$\{steps\.([^.}]+)\.outputs\.endpoint\}$/;

export function isTransferNode(
  node: Node<WorkflowCanvasNodeData>,
): node is Node<WorkflowNodeData> {
  return (
    isStepNode(node) &&
    node.data.actionPackageName === BEAM_TRANSFER_ACTION &&
    node.data.enabled
  );
}

/** Endpoint node ids bound to one side of a transfer. */
export function boundEndpointIds(
  node: Node<WorkflowNodeData>,
  inputKey: "sourceEndpoints" | "destinationEndpoints",
) {
  const value = node.data.inputBindings[inputKey];
  const expressions = Array.isArray(value) ? value : value === undefined ? [] : [value];

  return expressions.flatMap((expression) => {
    const match = ENDPOINT_BINDING.exec(String(expression));
    return match?.[1] ? [match[1]] : [];
  });
}

/**
 * Describe every transfer in the graph for pricing.
 *
 * Sizes are resolved from the object storage the endpoints already point at.
 * What cannot be sized is reported as unsized rather than guessed: an estimate
 * that quietly treats an unknown source as empty reads as "this is nearly free"
 * for exactly the transfers that are not.
 *
 * Disabled nodes are skipped because they will not run, and so will not bill.
 */
export async function projectTransfers(
  nodes: Node<WorkflowCanvasNodeData>[],
  listObjects: ObjectLister,
): Promise<TransferProjection[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // One listing per endpoint, however many transfers share it.
  const sizes = new Map<string, Promise<EndpointSize>>();

  const sizeOf = (endpointId: string) => {
    const existing = sizes.get(endpointId);
    if (existing) return existing;
    const pending = endpointSize(byId.get(endpointId), listObjects);
    sizes.set(endpointId, pending);
    return pending;
  };

  return Promise.all(
    nodes.filter(isTransferNode).map(async (node) => {
      const sources = await Promise.all(
        boundEndpointIds(node, "sourceEndpoints").map(sizeOf),
      );

      const sized = sources.filter((source) => source.bytes !== null);
      const sourceBytes = sized.length
        ? sized.reduce((total, source) => total + BigInt(source.bytes ?? "0"), 0n).toString()
        : null;

      return {
        stepId: node.id,
        label:
          stringValue(node.data.name) ||
          stringValue(node.data.config.name) ||
          "Transfer",
        sourceBytes,
        destinationCount: boundEndpointIds(node, "destinationEndpoints").length,
        // A sum missing one of its sources, or built from a cut-short listing,
        // can only be a lower bound.
        partial:
          sized.length > 0 &&
          (sized.length < sources.length || sized.some((source) => source.partial)),
        credentialId: stringValue(node.data.config.credentialId),
      };
    }),
  );
}

type EndpointSize = { bytes: string | null; partial: boolean };

/** The byte size an endpoint recorded for its object, or null. */
function recordedObjectSize(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? BigInt(Math.trunc(value)).toString()
    : null;
}

const UNSIZED: EndpointSize = { bytes: null, partial: false };

/**
 * Size one object-storage endpoint.
 *
 * A file endpoint picked in the bucket explorer records its object's size, and
 * that is the size used: listing the bucket again would only repeat it, and
 * cannot when the listing is refused. Otherwise a file endpoint is sized by
 * its exact key, because a prefix listing also returns siblings that share it
 * — `model.safetensors` and `model.safetensors.bak` would otherwise be
 * billed as one source.
 *
 * A listing that reports more to come yields a floor rather than a total.
 * Anything else — no credential, another provider, an unreachable bucket — is
 * unsized, and the operator is told so.
 */
async function endpointSize(
  node: Node<WorkflowCanvasNodeData> | undefined,
  listObjects: ObjectLister,
): Promise<EndpointSize> {
  if (
    !node ||
    !isStepNode(node) ||
    node.data.actionPackageName !== OBJECT_STORAGE_ENDPOINT_ACTION
  ) {
    return UNSIZED;
  }

  const config = node.data.config;
  const credentialId = stringValue(config.credentialId);
  const bucket = stringValue(config.bucket);
  const objectKey = stringValue(config.objectKey);

  if (!credentialId || !bucket || !objectKey) return UNSIZED;

  const isDirectory = stringValue(config.sourceType) === "directory";
  const recordedSize = recordedObjectSize(config.objectSize);
  if (!isDirectory && recordedSize !== null) {
    return { bytes: recordedSize, partial: false };
  }

  try {
    const listing = await listObjects({ bucket, credentialId, prefix: objectKey });
    const objects = listing.objects.filter((object) =>
      isDirectory ? true : object.key === objectKey,
    );

    if (!objects.length) return UNSIZED;

    const total = objects.reduce(
      (bytes, object) => bytes + BigInt(Math.max(0, Math.trunc(object.size ?? 0))),
      0n,
    );

    return {
      bytes: total.toString(),
      partial: isDirectory && listing.truncated,
    };
  } catch {
    // A bucket we cannot read is a size we do not know. Reporting zero here
    // would be reporting that this transfer is free.
    return UNSIZED;
  }
}
