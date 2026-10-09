import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ActionJson } from "./actions.js";

const sha256Hex = (value: string) =>
  bytesToHex(sha256(new TextEncoder().encode(value)));

export type AggregationSource = {
  stepId: string;
  /** Logical task identity, independent of the member executing an attempt. */
  taskId: string;
  port: string;
  index: number;
};

export type AcceptedAggregationContribution = {
  stepId: string;
  taskId: string;
  port: string;
  accepted: true;
  format?: string;
  value: ActionJson;
};

export type FrozenAggregationCollection = {
  collectionId: string;
  inputPort: string;
  contributionFormat: string;
  sources: AggregationSource[];
  /** Leaf identities inherited through every hierarchical combination level. */
  expectedContributionIds: string[];
};

export type LogicalAggregationInput = AggregationSource & {
  /** ID covered by this leaf output, e.g. the mapped document ID. */
  contributionId: string;
};

export type PlannedAggregationInvocation = {
  taskId: string;
  index: number;
  collection: FrozenAggregationCollection;
};

/** Plan explicit action invocations from logical map tasks, not worker members. */
export function planAggregationInvocations(input: {
  scopeId: string;
  stepId: string;
  inputPort: string;
  outputPort: string;
  contributionFormat: string;
  maxArtifacts: number;
  strategy: "flat" | "hierarchical";
  associative: boolean;
  closedUnderCombination: boolean;
  sources: readonly LogicalAggregationInput[];
}): PlannedAggregationInvocation[] {
  const ordered = orderedSources(input.sources);
  if (!ordered.length)
    throw new Error("Aggregation requires at least one logical contribution.");
  const ids = input.sources.map((source) => source.contributionId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
    throw new Error("Aggregation requires unique nonempty contribution IDs.");
  const groupSize = input.maxArtifacts - 1;
  if (!Number.isInteger(groupSize) || groupSize < 2)
    throw new Error("Aggregation artifact limit cannot hold input and output.");
  if (input.strategy !== "flat" && input.strategy !== "hierarchical")
    throw new Error(
      "Aggregation strategy must be explicitly flat or hierarchical.",
    );
  if (
    input.strategy === "hierarchical" &&
    (!input.associative || !input.closedUnderCombination)
  )
    throw new Error(
      "Hierarchical aggregation requires associative closed combination.",
    );
  if (input.strategy === "flat" && ordered.length > groupSize)
    throw new Error("Flat aggregation exceeds the action artifact limit.");
  let sources = ordered.map((source) => ({
    ...source,
    contributionIds: [source.contributionId],
  }));
  const invocations: PlannedAggregationInvocation[] = [];
  const createInvocation = (
    taskId: string,
    index: number,
    group: typeof sources,
  ) => {
    const frozenSources = group.map(({ stepId, taskId, port }, index) => ({
      stepId,
      taskId,
      port,
      index,
    }));
    const expectedContributionIds = group.flatMap(
      (source) => source.contributionIds,
    );
    const collection: FrozenAggregationCollection = {
      collectionId: aggregationCollectionId(
        input.scopeId,
        { stepId: input.stepId, taskId },
        frozenSources,
      ),
      inputPort: input.inputPort,
      contributionFormat: input.contributionFormat,
      sources: frozenSources,
      expectedContributionIds,
    };
    invocations.push({ taskId, index, collection });
    return {
      stepId: input.stepId,
      taskId,
      port: input.outputPort,
      index,
      contributionId: taskId,
      contributionIds: expectedContributionIds,
    };
  };
  if (input.strategy === "hierarchical") {
    let level = 0;
    while (sources.length > groupSize) {
      const next: typeof sources = [];
      for (let offset = 0; offset < sources.length; offset += groupSize)
        next.push(
          createInvocation(
            `aggregation_${level}_${next.length}`,
            next.length,
            sources.slice(offset, offset + groupSize),
          ),
        );
      sources = next;
      level++;
    }
  }
  createInvocation("studio", 0, sources);
  return invocations;
}

/** Build the action input only when the frozen accepted set is complete. */
export function prepareAggregationActionInput(
  collection: FrozenAggregationCollection,
  notifications: readonly AcceptedAggregationContribution[],
): {
  input: Record<string, ActionJson>;
  collectionId: string;
  contentChecksum: string;
  expectedContributionIds: string[];
} | null {
  for (const notification of notifications)
    if (notification.format !== collection.contributionFormat)
      throw new Error("Aggregation contribution has an incompatible format.");
  const closed = closeAggregationCollection(
    collection.sources,
    notifications,
    collection.collectionId,
  );
  if (!closed) return null;
  return {
    input: { [collection.inputPort]: closed.values },
    collectionId: closed.collectionId,
    contentChecksum: closed.contentChecksum,
    expectedContributionIds: [...collection.expectedContributionIds],
  };
}

/** Stable identity of a planned invocation, independent of task completion. */
export function aggregationCollectionId(
  scopeId: string,
  target: { stepId: string; taskId: string },
  expected: readonly AggregationSource[],
): string {
  if (!scopeId.trim() || !target.stepId || !target.taskId)
    throw new Error(
      "Aggregation collection requires a run scope and target identity.",
    );
  const ordered = orderedSources(expected);
  return sha256Hex(
    JSON.stringify([
      scopeId,
      target.stepId,
      target.taskId,
      ordered.map(({ index, stepId, taskId, port }) => [
        index,
        stepId,
        taskId,
        port,
      ]),
    ]),
  );
}

/**
 * Close a frozen collection only after every logical source has one accepted
 * result. Accepted empty arrays, objects and nulls are contributions too.
 * Delivery order and repeated notifications do not affect its identity.
 */
export function closeAggregationCollection(
  expected: readonly AggregationSource[],
  notifications: readonly AcceptedAggregationContribution[],
  frozenCollectionId?: string,
): {
  collectionId: string;
  contentChecksum: string;
  contributions: { source: AggregationSource; value: ActionJson }[];
  values: ActionJson[];
} | null {
  const ordered = orderedSources(expected);
  const sourceKey = (
    source: Pick<AggregationSource, "stepId" | "taskId" | "port">,
  ) => JSON.stringify([source.stepId, source.taskId, source.port]);
  const identities = new Set(ordered.map(sourceKey));
  const accepted = new Map<string, { value: ActionJson; canonical: string }>();
  for (const contribution of notifications) {
    const key = sourceKey(contribution);
    if (!identities.has(key) || contribution.accepted !== true)
      throw new Error(
        "Aggregation received an unaccepted or unexpected contribution.",
      );
    const canonical = canonicalJson(contribution.value);
    const previous = accepted.get(key);
    if (previous && previous.canonical !== canonical)
      throw new Error(
        "Aggregation received conflicting accepted contributions for one source.",
      );
    accepted.set(key, { value: contribution.value, canonical });
  }
  if (accepted.size !== ordered.length) return null;
  const contributions = ordered.map((source) => ({
    source,
    value: accepted.get(sourceKey(source))!.value,
  }));
  const identity = ordered.map((source) => [
    source.index,
    source.stepId,
    source.taskId,
    source.port,
    accepted.get(sourceKey(source))!.canonical,
  ]);
  const contentChecksum = sha256Hex(JSON.stringify(identity));
  return {
    collectionId: frozenCollectionId ?? contentChecksum,
    contentChecksum,
    contributions,
    values: contributions.map(({ value }) => value),
  };
}

function orderedSources<T extends AggregationSource>(
  expected: readonly T[],
): T[] {
  const ordered = [...expected].sort((a, b) => a.index - b.index);
  const identities = new Set<string>();
  for (let index = 0; index < ordered.length; index++) {
    const source = ordered[index]!;
    const key = JSON.stringify([source.stepId, source.taskId, source.port]);
    if (source.index !== index || identities.has(key))
      throw new Error(
        "Aggregation sources require unique contiguous frozen indexes and identities.",
      );
    identities.add(key);
  }
  return ordered;
}

function canonicalJson(value: ActionJson): string {
  const normalize = (item: ActionJson): ActionJson => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item))
        throw new Error("Aggregation contribution must be JSON.");
      return item;
    }
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item !== "object")
      throw new Error("Aggregation contribution must be JSON.");
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, normalize(item[key]!)]),
    );
  };
  return JSON.stringify(normalize(value));
}
