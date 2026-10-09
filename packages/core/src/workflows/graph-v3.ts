import {
  validateWorkflowGraphV2,
  type WorkflowGraphV2Control,
  type WorkflowGraphV2Edge,
  type WorkflowGraphValidationStep,
} from "./graph-v2.js";
import { validateActionManifestV2, type ActionManifestV2 } from "./actions.js";
import {
  planAggregationInvocations,
  type FrozenAggregationCollection,
} from "./aggregation.js";

/** V3 adds room distribution without changing the interpretation of V1 or V2. */
export const WORKFLOW_GRAPH_V3 = "workflow-graph/v3" as const;
/** Registry requirement and member artifact-port advertisement protocol. */
export const GRAPH_V3_ARTIFACT_CAPABILITY = "action-artifact-ports/v1" as const;

export type DistributedMember = { memberId: string; key?: string };
export type DistributedPartition = {
  id: string;
  members:
    | { kind: "explicit"; memberIds: string[] }
    | { kind: "eligible"; requiredCapabilities?: string[] };
  order: "member-id" | "declared";
};
export type DistributedPort = {
  name: string;
  kind: "json" | "artifact" | "member-id" | "member-id-list";
  cardinality: "one" | "optional" | "many" | "non-empty-many";
  /** Exact MIME format of the Registry v2 artifact port, when applicable. */
  format?: string;
};
export type RegistryV2PortContract = {
  type: "artifact";
  cardinality: "one" | "many";
  format: string;
  required: boolean;
};
export type RuntimeV1ArtifactPortSchema = {
  type: "artifact" | "artifact[]";
  cardinality?: "many";
  required?: boolean;
  format?: string;
};
export type DistributedStep = {
  stepId: string;
  partitionId: string;
  placement: "studio" | "room-member";
  inputs: DistributedPort[];
  outputs: DistributedPort[];
  /** Exactly one Registry action invocation consumes all accepted source outputs. */
  aggregation?: { strategy: "flat" | "hierarchical" };
  transfer?: {
    topology: "ring" | "all-to-all";
    sourceInput: string;
    recipientsInput: string;
  };
};
export type DistributedRoute = {
  from: { stepId: string; port: string };
  to: { stepId: string; port: string };
  association:
    | { kind: "identity" | "position" | "broadcast" | "collect" }
    | { kind: "key" };
};
export type WorkflowGraphV3Distribution = {
  partitions: DistributedPartition[];
  steps: DistributedStep[];
  routes: DistributedRoute[];
};
/** A V3 loop owns its distributed body. Carry routes connect accepted output
 * tasks from one iteration to the next using the frozen ring successor. */
export type WorkflowGraphV3LoopControl = Extract<
  WorkflowGraphV2Control,
  { kind: "loop" }
> & {
  initial: {
    routes: Array<{
      from: { stepId: string; port: string };
      to: { stepId: string; port: string };
      association: "identity";
    }>;
  };
  carry: {
    routes: Array<{
      from: { stepId: string; port: string };
      to: { stepId: string; port: string };
      association: "ring-successor";
    }>;
  };
  stop?: { port: string; mode: "all-true" };
};
export type WorkflowGraphV3Definition = {
  version: typeof WORKFLOW_GRAPH_V3;
  controls: (WorkflowGraphV2Control | WorkflowGraphV3LoopControl)[];
  edges: WorkflowGraphV2Edge[];
  distribution: WorkflowGraphV3Distribution;
};
export type DistributedTask = {
  stepId: string;
  /** Logical route key for aggregation tasks; physical placement is assignedMemberId. */
  memberId: string;
  assignedMemberId?: string;
  index: number;
  placement: "studio" | "room-member";
  sourceMemberId?: string;
  recipientMemberIds?: string[];
  /** A frozen contribution set; this task waits until every source is accepted. */
  collection?: FrozenAggregationCollection;
};
export type ResolvedDistributedRoute = {
  from: { stepId: string; memberId: string; port: string };
  to: { stepId: string; memberId: string; port: string };
};

export class WorkflowGraphV3ValidationError extends Error {
  readonly code = "workflow_graph_v3_invalid";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "WorkflowGraphV3ValidationError";
  }
}

const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const capabilityName = /^[A-Za-z][A-Za-z0-9._/:*-]{0,159}$/;
const registryPortName = /^[a-z][a-zA-Z0-9_]*$/;
const mediaType = /^[a-z0-9][a-z0-9_.+-]*\/[a-z0-9][a-z0-9_.+-]*$/;
function fail(message: string): never {
  throw new WorkflowGraphV3ValidationError(message);
}
function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !identifier.test(value))
    fail(`${label} must be a named identifier (1–64 characters).`);
}
function only(
  value: unknown,
  keys: string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail(`${label} has unknown field "${key}".`);
}
function array(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length)
    fail(`${label} contains duplicate values.`);
}

export function validateWorkflowGraphV3(
  definition: WorkflowGraphV3Definition,
  steps: WorkflowGraphValidationStep[],
) {
  only(definition, ["version", "controls", "edges", "distribution"], "graph");
  if (definition.version !== WORKFLOW_GRAPH_V3)
    fail(`Unsupported workflow graph version "${String(definition.version)}".`);
  const base = validateWorkflowGraphV2(
    {
      version: "workflow-graph/v2",
      controls: definition.controls,
      edges: definition.edges,
    },
    steps,
  );
  if (
    definition.controls.length > 1 ||
    definition.controls.some((control) => control.kind !== "loop")
  )
    fail(
      "V3 distribution supports at most one bounded loop; fan-out and nested distribution are unsupported.",
    );
  const loop = definition.controls[0] as WorkflowGraphV3LoopControl | undefined;
  if (loop) {
    only(
      loop,
      [
        "id",
        "kind",
        "iterations",
        "outputMode",
        "layout",
        "body",
        "initial",
        "carry",
        "stop",
      ],
      "V3 loop",
    );
    if (
      loop.body.edges.some(
        (edge) =>
          edge.condition !== undefined &&
          edge.condition !== null &&
          edge.condition !== true,
      )
    )
      fail(`V3 loop "${loop.id}" requires unconditional body dependencies.`);
  }
  if (
    loop &&
    (typeof loop.iterations !== "number" ||
      !Number.isSafeInteger(loop.iterations) ||
      loop.iterations < 1 ||
      loop.iterations > 128)
  )
    fail(
      `V3 loop "${loop.id}" requires a literal maximum iteration count from 1 to 128.`,
    );
  const distribution = definition.distribution;
  only(distribution, ["partitions", "steps", "routes"], "distribution");
  array(distribution.partitions, "partitions");
  array(distribution.steps, "distributed steps");
  array(distribution.routes, "routes");
  if (!distribution.partitions.length || !distribution.steps.length)
    fail(
      "A V3 graph requires at least one partition and one distributed step.",
    );
  if (
    distribution.partitions.length > 128 ||
    distribution.steps.length > 128 ||
    distribution.routes.length > 512
  )
    fail(
      "Distribution exceeds its partition, step or route limit (128, 128, 512).",
    );
  const partitions = new Map<string, DistributedPartition>();
  for (const partition of distribution.partitions) {
    only(partition, ["id", "members", "order"], "partition");
    name(partition.id, "Partition id");
    if (partitions.has(partition.id))
      fail(`Duplicate partition "${partition.id}".`);
    if (partition.order !== "member-id" && partition.order !== "declared")
      fail(`Partition "${partition.id}" has invalid order.`);
    only(
      partition.members,
      ["kind", "memberIds", "requiredCapabilities"],
      "member selection",
    );
    if (partition.members.kind === "explicit") {
      only(
        partition.members,
        ["kind", "memberIds"],
        "explicit member selection",
      );
      array(partition.members.memberIds, "explicit member IDs");
      if (!partition.members.memberIds.length)
        fail(`Partition "${partition.id}" explicitly selects no members.`);
      if (partition.members.memberIds.length > 10_000)
        fail(`Partition "${partition.id}" exceeds 10,000 members.`);
      for (const id of partition.members.memberIds) name(id, "Member id");
      unique(
        partition.members.memberIds,
        `Partition "${partition.id}" member IDs`,
      );
    } else if (partition.members.kind === "eligible") {
      only(
        partition.members,
        ["kind", "requiredCapabilities"],
        "eligible member selection",
      );
      if (partition.order === "declared")
        fail(`Eligible partition "${partition.id}" requires member-id order.`);
      if (partition.members.requiredCapabilities !== undefined) {
        array(partition.members.requiredCapabilities, "required capabilities");
        if (partition.members.requiredCapabilities.length > 64)
          fail("A partition may require at most 64 capabilities.");
        for (const capability of partition.members.requiredCapabilities)
          if (
            typeof capability !== "string" ||
            !capabilityName.test(capability)
          )
            fail("Required capability name is invalid.");
        if (
          partition.members.requiredCapabilities.includes("artifact-ports/v1")
        )
          fail(
            `Use ${GRAPH_V3_ARTIFACT_CAPABILITY} as a required capability; artifact-ports/v1 is superseded.`,
          );
        unique(partition.members.requiredCapabilities, "Required capabilities");
      }
    } else
      fail(`Partition "${partition.id}" has unsupported member selection.`);
    partitions.set(partition.id, partition);
  }
  const active = new Set(
    steps.filter((step) => step.enabled).map((step) => step.id),
  );
  const distributed = new Map<string, DistributedStep>();
  for (const step of distribution.steps) {
    only(
      step,
      [
        "stepId",
        "partitionId",
        "placement",
        "inputs",
        "outputs",
        "transfer",
        "aggregation",
      ],
      "distributed step",
    );
    if (typeof step.stepId !== "string" || !active.has(step.stepId))
      fail(`Distributed step "${String(step.stepId)}" is unknown or disabled.`);
    if (distributed.has(step.stepId))
      fail(`Duplicate distributed step "${step.stepId}".`);
    if (base.ownedStepIds.has(step.stepId) && !loop)
      fail(`Distributed step "${step.stepId}" must be a top-level graph step.`);
    if (loop && step.aggregation)
      fail(`Aggregation inside V3 loop "${loop.id}" is unsupported.`);
    if (!partitions.has(step.partitionId))
      fail(
        `Step "${step.stepId}" uses unknown partition "${String(step.partitionId)}".`,
      );
    if (step.placement !== "studio" && step.placement !== "room-member")
      fail(`Step "${step.stepId}" has invalid placement.`);
    if (step.aggregation !== undefined) {
      only(step.aggregation, ["strategy"], "aggregation");
      if (
        step.placement !== "room-member" ||
        step.transfer !== undefined ||
        !["flat", "hierarchical"].includes(step.aggregation.strategy)
      )
        fail(
          `Aggregation step "${step.stepId}" requires room-member placement and a valid strategy.`,
        );
    }
    for (const direction of ["inputs", "outputs"] as const) {
      array(step[direction], `${step.stepId} ${direction}`);
      if (step[direction].length > 128)
        fail(`Step "${step.stepId}" has too many ${direction}.`);
      const names: string[] = [];
      for (const port of step[direction]) {
        only(port, ["name", "kind", "cardinality", "format"], "port");
        name(port.name, "Port name");
        if (!registryPortName.test(port.name))
          fail(`Port "${port.name}" must use a Registry-compatible name.`);
        if (
          !["json", "artifact", "member-id", "member-id-list"].includes(
            port.kind,
          )
        )
          fail(`Port "${port.name}" has invalid kind.`);
        if (
          !["one", "optional", "many", "non-empty-many"].includes(
            port.cardinality,
          )
        )
          fail(`Port "${port.name}" has invalid cardinality.`);
        if (port.kind === "member-id-list" && port.cardinality !== "many")
          fail(`Port "${port.name}" must have many cardinality.`);
        if (port.kind === "member-id" && port.cardinality !== "one")
          fail(`Port "${port.name}" must have one cardinality.`);
        if (
          (port.kind === "artifact" || port.kind === "json") &&
          (typeof port.format !== "string" || !mediaType.test(port.format))
        )
          fail(`Data port "${port.name}" requires an exact MIME format.`);
        if (
          (port.kind === "member-id" || port.kind === "member-id-list") &&
          port.format !== undefined
        )
          fail(`Port "${port.name}" cannot declare a MIME format.`);
        names.push(port.name);
      }
      unique(names, `${step.stepId} ${direction}`);
    }
    if (step.transfer !== undefined) {
      only(
        step.transfer,
        ["topology", "sourceInput", "recipientsInput"],
        "transfer",
      );
      if (
        step.transfer.topology !== "ring" &&
        step.transfer.topology !== "all-to-all"
      )
        fail(`Step "${step.stepId}" has invalid transfer topology.`);
      const source = step.inputs.find(
        (port) => port.name === step.transfer!.sourceInput,
      );
      const recipients = step.inputs.find(
        (port) => port.name === step.transfer!.recipientsInput,
      );
      if (source?.kind !== "member-id" || recipients?.kind !== "member-id-list")
        fail(
          `Step "${step.stepId}" transfer requires member-id and member-id-list input ports.`,
        );
    }
    distributed.set(step.stepId, step);
  }
  const undistributedStep = [...active].find((id) => !distributed.has(id));
  if (undistributedStep)
    fail(`Active step "${undistributedStep}" requires a V3 distribution entry.`);
  const routeTargets = new Set<string>();
  for (const route of distribution.routes) {
    only(route, ["from", "to", "association"], "route");
    only(route.from, ["stepId", "port"], "route source");
    only(route.to, ["stepId", "port"], "route target");
    only(route.association, ["kind"], "route association");
    const source = distributed.get(route.from.stepId);
    const target = distributed.get(route.to.stepId);
    const output = source?.outputs.find(
      (port) => port.name === route.from.port,
    );
    const input = target?.inputs.find((port) => port.name === route.to.port);
    if (!output || !input)
      fail(
        `Route ${route.from.stepId}.${route.from.port} -> ${route.to.stepId}.${route.to.port} references an unknown port.`,
      );
    const collect = route.association.kind === "collect";
    if (
      output.kind !== input.kind ||
      (collect
        ? !target?.aggregation ||
          output.kind !== "artifact" ||
          output.cardinality !== "one" ||
          input.cardinality !== "non-empty-many"
        : output.cardinality !== input.cardinality ||
          output.format !== input.format)
    )
      fail(
        `Route ${route.from.stepId}.${route.from.port} -> ${route.to.stepId}.${route.to.port} has incompatible ports.`,
      );
    if (
      !["identity", "position", "key", "broadcast", "collect"].includes(
        route.association.kind,
      )
    )
      fail("Route has invalid association kind.");
    if (
      route.association.kind === "identity" &&
      source!.partitionId !== target!.partitionId
    )
      fail(
        "Identity association requires the same partition; use explicit key or position association across partitions.",
      );
    const targetKey = `${route.to.stepId}\u0000${route.to.port}`;
    if (route.from.stepId === route.to.stepId)
      fail("A distributed route cannot target its own step.");
    if (
      target?.transfer &&
      [target.transfer.sourceInput, target.transfer.recipientsInput].includes(
        route.to.port,
      )
    )
      fail(
        `Input ${route.to.stepId}.${route.to.port} is generated by transfer topology.`,
      );
    if (
      !(loop ? loop.body.edges : definition.edges).some(
        (edge) =>
          edge.from === route.from.stepId &&
          edge.to === route.to.stepId &&
          (edge.condition === undefined ||
            edge.condition === null ||
            edge.condition === true),
      )
    )
      fail(
        `Route ${route.from.stepId} -> ${route.to.stepId} requires an unconditional graph dependency edge.`,
      );
    if (routeTargets.has(targetKey))
      fail(`Input ${route.to.stepId}.${route.to.port} has ambiguous routes.`);
    routeTargets.add(targetKey);
  }
  for (const step of distributed.values()) {
    const inbound = distribution.routes.filter(
      (route) => route.to.stepId === step.stepId,
    );
    if (step.aggregation) {
      if (inbound.length !== 1 || inbound[0]?.association.kind !== "collect")
        fail(
          `Aggregation step "${step.stepId}" requires exactly one collect route.`,
        );
    } else if (inbound.some((route) => route.association.kind === "collect")) {
      fail(`Collect route requires an aggregation step.`);
    }
  }
  if (loop) {
    if (
      loop.body.stepIds.length > distributed.size ||
      loop.body.stepIds.some((id) => !distributed.has(id)) ||
      steps.some((step) => step.enabled && !distributed.has(step.id))
    )
      fail(
        `V3 loop "${loop.id}" must contain all active steps and no unsupported nesting.`,
      );
    const outside = [...distributed.values()].filter(
      (step) => !loop.body.stepIds.includes(step.stepId),
    );
    if (outside.length !== 1 || !loop.initial)
      fail(
        `V3 loop "${loop.id}" requires one initial top-level distributed seed step.`,
      );
    {
      only(loop.initial, ["routes"], "V3 loop initial state");
      array(loop.initial.routes, "V3 loop initial routes");
      if (
        outside.length !== 1 ||
        !loop.initial.routes.length ||
        loop.initial.routes.length > 16
      )
        fail(`V3 loop "${loop.id}" requires one bounded initial seed step.`);
      const seed = outside[0]!;
      const entry = distributed.get(loop.body.entryStepId)!;
      if (seed.partitionId !== entry.partitionId || definition.edges.length)
        fail(
          `V3 loop "${loop.id}" initial seed requires a matching partition and explicit initial routes without top-level edges.`,
        );
      const targets = new Set<string>();
      for (const route of loop.initial.routes) {
        only(route, ["from", "to", "association"], "V3 initial route");
        only(route.from, ["stepId", "port"], "V3 initial source");
        only(route.to, ["stepId", "port"], "V3 initial target");
        if (
          entry.transfer &&
          [entry.transfer.sourceInput, entry.transfer.recipientsInput].includes(
            route.to.port,
          )
        )
          fail(
            `Input ${route.to.stepId}.${route.to.port} is generated by transfer topology.`,
          );
        const output = seed.outputs.find(
          (port) => port.name === route.from.port,
        );
        const input = entry.inputs.find((port) => port.name === route.to.port);
        if (
          route.association !== "identity" ||
          route.from.stepId !== seed.stepId ||
          route.to.stepId !== entry.stepId ||
          !output ||
          !input ||
          output.kind !== input.kind ||
          output.cardinality !== "one" ||
          input.cardinality !== "one" ||
          output.format !== input.format ||
          targets.has(route.to.port)
        )
          fail(`V3 loop "${loop.id}" has invalid or ambiguous initial route.`);
        targets.add(route.to.port);
      }
    }
    only(loop.carry, ["routes"], "V3 loop carry");
    array(loop.carry.routes, "V3 loop carry routes");
    if (loop.carry.routes.length < 1 || loop.carry.routes.length > 16)
      fail(`V3 loop "${loop.id}" requires bounded artifact carry routes.`);
    const source = distributed.get(loop.body.outputStepId);
    const target = distributed.get(loop.body.entryStepId);
    if (
      !source?.transfer ||
      source.transfer.topology !== "ring" ||
      !target ||
      source.partitionId !== target.partitionId
    )
      fail(
        `V3 loop "${loop.id}" requires a ring transfer output and matching entry partition.`,
      );
    const carriedTargets = new Set<string>();
    let carriesArtifact = false;
    for (const route of loop.carry.routes) {
      only(route, ["from", "to", "association"], "V3 carry route");
      only(route.from, ["stepId", "port"], "V3 carry source");
      only(route.to, ["stepId", "port"], "V3 carry target");
      if (
        target?.transfer &&
        [target.transfer.sourceInput, target.transfer.recipientsInput].includes(
          route.to.port,
        )
      )
        fail(
          `Input ${route.to.stepId}.${route.to.port} is generated by transfer topology.`,
        );
      if (
        route.association !== "ring-successor" ||
        route.from.stepId !== source.stepId ||
        route.to.stepId !== target.stepId
      )
        fail(
          `V3 loop "${loop.id}" has unsupported carry association or boundary.`,
        );
      const output = source.outputs.find(
        (port) => port.name === route.from.port,
      );
      const input = target.inputs.find((port) => port.name === route.to.port);
      if (
        !output ||
        !input ||
        output.kind !== input.kind ||
        output.cardinality !== "one" ||
        input.cardinality !== "one" ||
        output.format !== input.format
      )
        fail(`V3 loop "${loop.id}" has incompatible carry ports.`);
      if (carriedTargets.has(route.to.port))
        fail(
          `V3 loop "${loop.id}" has ambiguous carried input "${route.to.port}".`,
        );
      carriedTargets.add(route.to.port);
      carriesArtifact ||= output.kind === "artifact";
    }
    if (!carriesArtifact)
      fail(`V3 loop "${loop.id}" must carry an accepted artifact.`);
    if (
      loop.carry.routes.some(
        (route) =>
          !loop.initial.routes.some(
            (initial) => initial.to.port === route.to.port,
          ),
      )
    )
      fail(`V3 loop "${loop.id}" must seed every carried input.`);
    if (loop.stop !== undefined) {
      only(loop.stop, ["port", "mode"], "V3 loop stop");
      if (
        loop.stop.mode !== "all-true" ||
        !source.outputs.some(
          (port) =>
            port.name === loop.stop!.port &&
            port.kind === "json" &&
            port.cardinality === "one",
        )
      )
        fail(`V3 loop "${loop.id}" requires a JSON all-true stop output.`);
    }
  }
  return definition;
}

export function resolveWorkflowGraphV3InitialRoutes(
  loop: WorkflowGraphV3LoopControl,
  tasks: readonly DistributedTask[],
): ResolvedDistributedRoute[] {
  return loop.initial.routes.flatMap((route) => {
    const sources = tasks.filter((task) => task.stepId === route.from.stepId);
    const targets = tasks.filter((task) => task.stepId === route.to.stepId);
    return targets.map((target) => {
      const source = sources.find((task) => task.memberId === target.memberId);
      if (!source)
        fail(
          `V3 loop "${loop.id}" initial route lacks a frozen identity match.`,
        );
      return {
        from: {
          stepId: source.stepId,
          memberId: source.memberId,
          port: route.from.port,
        },
        to: {
          stepId: target.stepId,
          memberId: target.memberId,
          port: route.to.port,
        },
      };
    });
  });
}

export function resolveWorkflowGraphV3CarryRoutes(
  loop: WorkflowGraphV3LoopControl,
  tasks: readonly DistributedTask[],
): ResolvedDistributedRoute[] {
  const sources = tasks.filter(
    (task) => task.stepId === loop.body.outputStepId,
  );
  const targets = tasks.filter((task) => task.stepId === loop.body.entryStepId);
  if (!sources.length || sources.length !== targets.length)
    fail(`V3 loop "${loop.id}" has a mismatched frozen ring cohort.`);
  return loop.carry.routes.flatMap((route) =>
    sources.map((source) => {
      const recipient = source.recipientMemberIds?.[0];
      if (
        !recipient ||
        source.recipientMemberIds?.length !== 1 ||
        !targets.some((target) => target.memberId === recipient)
      )
        fail(`V3 loop "${loop.id}" has no frozen ring successor.`);
      return {
        from: {
          stepId: source.stepId,
          memberId: source.memberId,
          port: route.from.port,
        },
        to: {
          stepId: loop.body.entryStepId,
          memberId: recipient,
          port: route.to.port,
        },
      };
    }),
  );
}

/** Match the direct Registry v2 artifact declaration, including requiredness. */
export function assertGraphV3RegistryPort(
  port: DistributedPort,
  contract: RegistryV2PortContract,
) {
  if (port.kind !== "artifact")
    fail(`Port "${port.name}" has no Registry v2 artifact contract.`);
  if (
    !contract ||
    contract.type !== "artifact" ||
    contract.cardinality !==
      (port.cardinality === "one" || port.cardinality === "optional"
        ? "one"
        : "many") ||
    contract.required !==
      (port.cardinality === "one" || port.cardinality === "non-empty-many") ||
    contract.format !== port.format
  )
    fail(
      `Port "${port.name}" is incompatible with the locked Registry v2 contract.`,
    );
}

/** The bounded runtime v1 supports the same four cardinalities via type/required. */
export function assertGraphV3RuntimeArtifactPort(
  port: DistributedPort,
  schema: RuntimeV1ArtifactPortSchema,
) {
  if (
    port.kind !== "artifact" ||
    !schema ||
    (schema.type !== "artifact" && schema.type !== "artifact[]")
  )
    fail(
      `Port "${port.name}" is not an artifact port in the installed runtime.`,
    );
  const collection =
    schema.type === "artifact[]" || schema.cardinality === "many";
  const cardinality = collection
    ? schema.required === true
      ? "non-empty-many"
      : "many"
    : schema.required === true
      ? "one"
      : "optional";
  if (port.cardinality !== cardinality || port.format !== schema.format)
    fail(
      `Port "${port.name}" is incompatible with the installed artifact runtime.`,
    );
}

/** Resolve a frozen membership snapshot into task identities and explicit routes. */
export function resolveWorkflowGraphV3(
  definition: WorkflowGraphV3Definition,
  steps: WorkflowGraphValidationStep[],
  membersByPartition: Record<string, DistributedMember[]>,
  aggregationActions: Record<string, ActionManifestV2> = {},
  collectionScope?: string,
) {
  validateWorkflowGraphV3(definition, steps);
  if (
    !membersByPartition ||
    typeof membersByPartition !== "object" ||
    Array.isArray(membersByPartition)
  )
    fail("Resolved partitions must be an object.");
  const members = new Map<string, DistributedMember[]>();
  for (const partition of definition.distribution.partitions) {
    const supplied = membersByPartition[partition.id];
    if (!Array.isArray(supplied) || !supplied.length)
      fail(`Partition "${partition.id}" resolved to no members.`);
    if (
      supplied.some(
        (member) =>
          !member || typeof member !== "object" || Array.isArray(member),
      )
    )
      fail(`Partition "${partition.id}" contains an invalid member.`);
    if (supplied.length > 10_000)
      fail(`Partition "${partition.id}" exceeds 10,000 members.`);
    const ids = supplied.map((member) => member.memberId);
    for (const id of ids) name(id, "Resolved member id");
    unique(ids, `Partition "${partition.id}" resolved member IDs`);
    if (
      partition.members.kind === "explicit" &&
      (ids.length !== partition.members.memberIds.length ||
        new Set(ids).size !== partition.members.memberIds.length ||
        partition.members.memberIds.some((id) => !ids.includes(id)))
    )
      fail(
        `Partition "${partition.id}" does not match its explicit member selection.`,
      );
    const ordered =
      partition.order === "member-id"
        ? [...supplied].sort((a, b) =>
            a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0,
          )
        : partition.members.kind === "explicit"
          ? partition.members.memberIds.map(
              (id) => supplied.find((member) => member.memberId === id)!,
            )
          : supplied;
    members.set(partition.id, ordered);
  }
  const plannedCount = definition.distribution.steps.reduce(
    (count, step) =>
      count + (step.aggregation ? 1 : members.get(step.partitionId)!.length),
    0,
  );
  const loopIterations = definition.controls.length
    ? Number((definition.controls[0] as WorkflowGraphV3LoopControl).iterations)
    : 1;
  if (plannedCount * loopIterations > 100_000)
    fail("Distribution exceeds 100,000 action tasks.");
  const recipientAssignments = definition.distribution.steps.reduce(
    (count, step) => {
      if (!step.transfer) return count;
      const size = members.get(step.partitionId)!.length;
      return count + size * (step.transfer.topology === "ring" ? 1 : size - 1);
    },
    0,
  );
  if (recipientAssignments * loopIterations > 1_000_000)
    fail("Distribution exceeds 1,000,000 transfer recipient assignments.");
  const routeAssignments = definition.distribution.routes.reduce(
    (count, route) => {
      const target = definition.distribution.steps.find(
        (step) => step.stepId === route.to.stepId,
      )!;
      return count + members.get(target.partitionId)!.length;
    },
    0,
  );
  const loop = definition.controls[0] as WorkflowGraphV3LoopControl | undefined;
  const loopRouteAssignments = loop
    ? members.get(
        definition.distribution.steps.find(
          (step) => step.stepId === loop.body.entryStepId,
        )!.partitionId,
      )!.length *
      (loop.initial.routes.length + loop.carry.routes.length * loopIterations)
    : 0;
  if (routeAssignments * loopIterations + loopRouteAssignments > 1_000_000)
    fail("Distribution exceeds 1,000,000 routed task inputs.");
  const tasks: DistributedTask[] = [];
  const byStep = new Map<string, DistributedTask[]>();
  for (const step of definition.distribution.steps) {
    const group = members.get(step.partitionId)!;
    if (step.aggregation) {
      if (!collectionScope?.trim())
        fail(
          `Aggregation step "${step.stepId}" requires a frozen workflow run scope.`,
        );
      const route = definition.distribution.routes.find(
        (candidate) => candidate.to.stepId === step.stepId,
      )!;
      const sourceStep = definition.distribution.steps.find(
        (candidate) => candidate.stepId === route.from.stepId,
      )!;
      if (sourceStep.aggregation)
        fail(
          `Aggregation step "${step.stepId}" cannot collect another aggregation step.`,
        );
      const sourceMembers = members.get(sourceStep.partitionId)!;
      const manifest = aggregationActions[step.stepId];
      const contract = manifest?.contracts?.computation?.aggregation;
      if (
        manifest?.apiVersion !== "workflow-actions/v2" ||
        !contract ||
        contract.inputPort !== route.to.port ||
        manifest.inputs[contract.inputPort]?.format !==
          step.inputs.find((port) => port.name === route.to.port)?.format ||
        contract.contributionFormat !==
          sourceStep.outputs.find((port) => port.name === route.from.port)
            ?.format
      )
        fail(
          `Aggregation step "${step.stepId}" requires a matching locked Registry action contract.`,
        );
      validateActionManifestV2(manifest);
      const inputPort = step.inputs.find(
        (port) => port.name === contract.inputPort,
      );
      const outputPort = step.outputs.find(
        (port) => port.name === contract.outputPort,
      );
      if (
        !inputPort ||
        !outputPort ||
        !manifest.runtime.placements.includes("room-members")
      )
        fail(
          `Aggregation step "${step.stepId}" requires Registry ports and room-member placement.`,
        );
      assertGraphV3RegistryPort(
        inputPort,
        manifest.inputs[contract.inputPort]!,
      );
      assertGraphV3RegistryPort(
        outputPort,
        manifest.outputs[contract.outputPort]!,
      );
      if (
        step.aggregation.strategy === "hierarchical" &&
        (!contract.associative ||
          !contract.closedUnderCombination ||
          manifest.inputs[contract.inputPort]?.cardinality !== "many" ||
          Object.keys(manifest.inputs).length !== 1 ||
          Object.keys(manifest.outputs).length !== 1)
      )
        fail(
          `Aggregation step "${step.stepId}" action does not declare associative closed combination.`,
        );
      const invocations = planAggregationInvocations({
        scopeId: collectionScope,
        stepId: step.stepId,
        inputPort: contract.inputPort,
        outputPort: contract.outputPort,
        contributionFormat: contract.contributionFormat,
        maxArtifacts: manifest.contracts.resources.maxArtifacts,
        strategy: step.aggregation.strategy,
        associative: contract.associative,
        closedUnderCombination: contract.closedUnderCombination,
        sources: sourceMembers.map((member, index) => ({
          stepId: sourceStep.stepId,
          taskId: member.memberId,
          contributionId: member.memberId,
          port: route.from.port,
          index,
        })),
      });
      const expanded = invocations.map(
        (invocation): DistributedTask => ({
          stepId: step.stepId,
          memberId: invocation.taskId,
          assignedMemberId: group[0]!.memberId,
          index: invocation.index,
          placement: "room-member",
          collection: invocation.collection,
        }),
      );
      tasks.push(...expanded);
      byStep.set(step.stepId, [expanded.at(-1)!]);
      continue;
    }
    if (step.transfer && group.length < 2)
      fail(`Transfer step "${step.stepId}" needs at least two members.`);
    const expanded = group.map(
      (member, index): DistributedTask => ({
        stepId: step.stepId,
        memberId: member.memberId,
        index,
        placement: step.placement,
        ...(step.transfer
          ? {
              sourceMemberId: member.memberId,
              recipientMemberIds:
                step.transfer.topology === "ring"
                  ? [group[(index + 1) % group.length]!.memberId]
                  : group
                      .filter((other) => other.memberId !== member.memberId)
                      .map((other) => other.memberId),
            }
          : {}),
      }),
    );
    tasks.push(...expanded);
    byStep.set(step.stepId, expanded);
  }
  if (tasks.length > 100_000)
    fail("Distribution exceeds 100,000 action tasks.");
  const routes: ResolvedDistributedRoute[] = tasks.flatMap((task) =>
    (task.collection?.sources ?? []).map((source) => ({
      from: {
        stepId: source.stepId,
        memberId: source.taskId,
        port: source.port,
      },
      to: {
        stepId: task.stepId,
        memberId: task.memberId,
        port: task.collection!.inputPort,
      },
    })),
  );
  for (const route of definition.distribution.routes) {
    const sourceStep = definition.distribution.steps.find(
      (step) => step.stepId === route.from.stepId,
    )!;
    const targetStep = definition.distribution.steps.find(
      (step) => step.stepId === route.to.stepId,
    )!;
    const sources = byStep.get(sourceStep.stepId)!;
    const targets = byStep.get(targetStep.stepId)!;
    const sourceMembers = members.get(sourceStep.partitionId)!;
    const targetMembers = members.get(targetStep.partitionId)!;
    const association = route.association.kind;
    if (association === "collect") {
      continue;
    }
    if (association === "broadcast" && sources.length !== 1)
      fail(
        `Broadcast from "${sourceStep.stepId}" is ambiguous: expected one source task.`,
      );
    if (association === "position" && sources.length !== targets.length)
      fail(
        `Position route ${sourceStep.stepId} -> ${targetStep.stepId} requires equal partition sizes.`,
      );
    let sourceByKey: Map<string, DistributedTask> | undefined;
    if (association === "key") {
      sourceByKey = new Map();
      for (let index = 0; index < sources.length; index++) {
        const key = sourceMembers[index]?.key;
        if (typeof key !== "string" || !key.trim() || sourceByKey.has(key))
          fail(
            `Key route from "${sourceStep.stepId}" has missing or ambiguous source keys.`,
          );
        sourceByKey.set(key, sources[index]!);
      }
      const targetKeys = targetMembers.map((member) => member.key);
      if (
        targetKeys.some((key) => typeof key !== "string" || !key.trim()) ||
        new Set(targetKeys).size !== targetKeys.length
      )
        fail(
          `Key route to "${targetStep.stepId}" has missing or ambiguous target keys.`,
        );
    }
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]!;
      const source =
        association === "broadcast"
          ? sources[0]
          : association === "position"
            ? sources[index]
            : association === "identity"
              ? sources.find(
                  (candidate) => candidate.memberId === target.memberId,
                )
              : sourceByKey!.get(targetMembers[index]!.key!);
      if (!source)
        fail(
          `Route ${sourceStep.stepId} -> ${targetStep.stepId} has no ${association} match for member "${target.memberId}".`,
        );
      routes.push({
        from: {
          stepId: source.stepId,
          memberId: source.memberId,
          port: route.from.port,
        },
        to: {
          stepId: target.stepId,
          memberId: target.memberId,
          port: route.to.port,
        },
      });
    }
  }
  if (routes.length > 1_000_000)
    fail("Distribution exceeds 1,000,000 routed task inputs.");
  return { tasks, routes };
}
