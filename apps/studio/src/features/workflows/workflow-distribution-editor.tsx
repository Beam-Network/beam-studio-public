import type { ReactNode } from "react";
import type {
  DistributedPartition,
  DistributedPort,
  DistributedRoute,
  DistributedStep,
  WorkflowGraphV3Distribution,
  WorkflowGraphV3LoopControl,
} from "@beam-studio/core/workflows/graph-v3";
import { Button } from "@/components/ui/button";

type StepOption = { id: string; name: string; enabled: boolean };
type PortEndpoint = { stepId: string; port: string };

const inputClass =
  "min-w-0 h-9 w-full rounded-control border bg-background px-2 text-sm";
const dataPort: DistributedPort = {
  name: "data",
  kind: "artifact",
  cardinality: "one",
  format: "application/octet-stream",
};

export function WorkflowDistributionEditor({
  distribution,
  loop,
  onChange,
  onLoopChange,
  steps,
  error,
}: {
  distribution: WorkflowGraphV3Distribution;
  loop: WorkflowGraphV3LoopControl | null;
  onChange(next: WorkflowGraphV3Distribution): void;
  onLoopChange(next: WorkflowGraphV3LoopControl): void;
  steps: StepOption[];
  error: string | null;
}) {
  const updatePartition = (index: number, next: DistributedPartition) =>
    onChange({
      ...distribution,
      partitions: distribution.partitions.map((item, position) =>
        position === index ? next : item,
      ),
    });
  const updateStep = (index: number, next: DistributedStep) =>
    onChange({
      ...distribution,
      steps: distribution.steps.map((item, position) =>
        position === index ? next : item,
      ),
    });
  const updateRoute = (index: number, next: DistributedRoute) =>
    onChange({
      ...distribution,
      routes: distribution.routes.map((item, position) =>
        position === index ? next : item,
      ),
    });
  const inputPorts = distribution.steps.flatMap((step) =>
    step.inputs.map((port) => ({ stepId: step.stepId, port: port.name })),
  );
  const outputPorts = distribution.steps.flatMap((step) =>
    step.outputs.map((port) => ({ stepId: step.stepId, port: port.name })),
  );

  return (
    <div className="grid gap-6 text-sm">
      <p className="text-muted-foreground">
        A partition resolves its members once per run. A per-member action
        creates one task per member; a transfer node can address the next ring
        member or all other members without expanding the canvas.
      </p>
      {error ? (
        <p
          className="rounded-control border border-destructive/40 bg-destructive/5 p-3 text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : (
        <p className="rounded-control border bg-muted/30 p-3 text-muted-foreground">
          Distribution is structurally valid. Action capabilities and room
          membership are checked again when the workflow is saved and run.
        </p>
      )}

      <Section
        title="Partitions"
        action={
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() =>
              onChange({
                ...distribution,
                partitions: [
                  ...distribution.partitions,
                  {
                    id: `partition_${distribution.partitions.length + 1}`,
                    members: { kind: "eligible", requiredCapabilities: [] },
                    order: "member-id",
                  },
                ],
              })
            }
          >
            Add partition
          </Button>
        }
      >
        {distribution.partitions.map((partition, index) => (
          <div className="grid gap-3 rounded-surface border p-3" key={index}>
            <div className="flex items-end gap-2">
              <Field label="Partition ID">
                <input
                  className={inputClass}
                  value={partition.id}
                  onChange={(event) =>
                    updatePartition(index, {
                      ...partition,
                      id: event.target.value,
                    })
                  }
                />
              </Field>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() =>
                  onChange({
                    ...distribution,
                    partitions: distribution.partitions.filter(
                      (_, position) => position !== index,
                    ),
                  })
                }
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Members">
                <select
                  className={inputClass}
                  value={partition.members.kind}
                  onChange={(event) =>
                    updatePartition(index, {
                      ...partition,
                      members:
                        event.target.value === "explicit"
                          ? { kind: "explicit", memberIds: [] }
                          : { kind: "eligible", requiredCapabilities: [] },
                      order:
                        event.target.value === "eligible"
                          ? "member-id"
                          : partition.order,
                    })
                  }
                >
                  <option value="eligible">Eligible room members</option>
                  <option value="explicit">Specific member IDs</option>
                </select>
              </Field>
              <Field label="Order">
                <select
                  className={inputClass}
                  value={partition.order}
                  disabled={partition.members.kind === "eligible"}
                  onChange={(event) =>
                    updatePartition(index, {
                      ...partition,
                      order: event.target
                        .value as DistributedPartition["order"],
                    })
                  }
                >
                  <option value="member-id">Member ID</option>
                  <option value="declared">Declared order</option>
                </select>
              </Field>
            </div>
            {partition.members.kind === "explicit" ? (
              <Field
                label="Member IDs"
                hint="One ID per line. Declared order controls ring successors."
              >
                <textarea
                  className={`${inputClass} min-h-20 py-2`}
                  value={partition.members.memberIds.join("\n")}
                  onChange={(event) =>
                    updatePartition(index, {
                      ...partition,
                      members: {
                        kind: "explicit",
                        memberIds: lines(event.target.value),
                      },
                    })
                  }
                />
              </Field>
            ) : (
              <Field
                label="Required capabilities"
                hint="One capability per line. Leave empty to include all eligible members."
              >
                <textarea
                  className={`${inputClass} min-h-20 py-2`}
                  value={(partition.members.requiredCapabilities ?? []).join(
                    "\n",
                  )}
                  onChange={(event) =>
                    updatePartition(index, {
                      ...partition,
                      members: {
                        kind: "eligible",
                        requiredCapabilities: lines(event.target.value),
                      },
                    })
                  }
                />
              </Field>
            )}
          </div>
        ))}
      </Section>

      <Section
        title="Distributed actions"
        action={
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={!steps.length}
            onClick={() =>
              onChange({
                ...distribution,
                steps: [
                  ...distribution.steps,
                  {
                    stepId:
                      steps.find(
                        (step) =>
                          !distribution.steps.some(
                            (item) => item.stepId === step.id,
                          ),
                      )?.id ?? steps[0]!.id,
                    partitionId: distribution.partitions[0]?.id ?? "",
                    placement: "room-member",
                    inputs: [],
                    outputs: [],
                  },
                ],
              })
            }
          >
            Add action
          </Button>
        }
      >
        {distribution.steps.map((step, index) => (
          <div className="grid gap-4 rounded-surface border p-3" key={index}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Canvas action">
                <select
                  className={inputClass}
                  value={step.stepId}
                  onChange={(event) =>
                    updateStep(index, { ...step, stepId: event.target.value })
                  }
                >
                  <option value="">Choose action</option>
                  {steps.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} · {option.id}
                      {option.enabled ? "" : " (disabled)"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Partition">
                <select
                  className={inputClass}
                  value={step.partitionId}
                  onChange={(event) =>
                    updateStep(index, {
                      ...step,
                      partitionId: event.target.value,
                    })
                  }
                >
                  <option value="">Choose partition</option>
                  {distribution.partitions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Execution placement">
                <select
                  className={inputClass}
                  value={step.placement}
                  onChange={(event) =>
                    updateStep(index, {
                      ...step,
                      placement: event.target
                        .value as DistributedStep["placement"],
                    })
                  }
                >
                  <option value="room-member">Room member</option>
                  <option value="studio">Studio</option>
                </select>
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <PortList
                title="Inputs"
                ports={step.inputs}
                onChange={(inputs) => updateStep(index, { ...step, inputs })}
              />
              <PortList
                title="Outputs"
                ports={step.outputs}
                onChange={(outputs) => updateStep(index, { ...step, outputs })}
              />
            </div>
            <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
              <Field label="Transfer topology">
                <select
                  className={inputClass}
                  value={step.transfer?.topology ?? "none"}
                  onChange={(event) =>
                    updateStep(index, {
                      ...step,
                      inputs:
                        event.target.value === "none"
                          ? step.inputs
                          : [
                              ...step.inputs,
                              ...(!step.inputs.some(
                                (port) => port.name === "source",
                              )
                                ? [
                                    {
                                      name: "source",
                                      kind: "member-id" as const,
                                      cardinality: "one" as const,
                                    },
                                  ]
                                : []),
                              ...(!step.inputs.some(
                                (port) => port.name === "recipients",
                              )
                                ? [
                                    {
                                      name: "recipients",
                                      kind: "member-id-list" as const,
                                      cardinality: "many" as const,
                                    },
                                  ]
                                : []),
                            ],
                      transfer:
                        event.target.value === "none"
                          ? undefined
                          : {
                              topology: event.target.value as
                                | "ring"
                                | "all-to-all",
                              sourceInput:
                                step.transfer?.sourceInput ?? "source",
                              recipientsInput:
                                step.transfer?.recipientsInput ?? "recipients",
                            },
                    })
                  }
                >
                  <option value="none">No transfer</option>
                  <option value="ring">Ring successor</option>
                  <option value="all-to-all">All other members</option>
                </select>
              </Field>
              <Field label="Aggregation">
                <select
                  className={inputClass}
                  value={step.aggregation?.strategy ?? "none"}
                  onChange={(event) =>
                    updateStep(index, {
                      ...step,
                      placement:
                        event.target.value === "none"
                          ? step.placement
                          : "room-member",
                      inputs:
                        event.target.value === "none" ||
                        step.inputs.some(
                          (port) => port.cardinality === "non-empty-many",
                        )
                          ? step.inputs
                          : [
                              ...step.inputs,
                              {
                                name: "contributions",
                                kind: "artifact",
                                cardinality: "non-empty-many",
                                format: "application/octet-stream",
                              },
                            ],
                      aggregation:
                        event.target.value === "none"
                          ? undefined
                          : {
                              strategy: event.target.value as
                                | "flat"
                                | "hierarchical",
                            },
                    })
                  }
                >
                  <option value="none">No aggregation</option>
                  <option value="flat">Flat collect</option>
                  <option value="hierarchical">Hierarchical collect</option>
                </select>
              </Field>
              {step.transfer ? (
                <>
                  <Field label="Source member input">
                    <select
                      className={inputClass}
                      value={step.transfer.sourceInput}
                      onChange={(event) =>
                        updateStep(index, {
                          ...step,
                          transfer: {
                            ...step.transfer!,
                            sourceInput: event.target.value,
                          },
                        })
                      }
                    >
                      <option value="">Choose member-id port</option>
                      {step.inputs
                        .filter((port) => port.kind === "member-id")
                        .map((port) => (
                          <option key={port.name} value={port.name}>
                            {port.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Recipients input">
                    <select
                      className={inputClass}
                      value={step.transfer.recipientsInput}
                      onChange={(event) =>
                        updateStep(index, {
                          ...step,
                          transfer: {
                            ...step.transfer!,
                            recipientsInput: event.target.value,
                          },
                        })
                      }
                    >
                      <option value="">Choose member-id-list port</option>
                      {step.inputs
                        .filter((port) => port.kind === "member-id-list")
                        .map((port) => (
                          <option key={port.name} value={port.name}>
                            {port.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                </>
              ) : null}
            </div>
            <div>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() =>
                  onChange({
                    ...distribution,
                    steps: distribution.steps.filter(
                      (_, position) => position !== index,
                    ),
                    routes: distribution.routes.filter(
                      (route) =>
                        route.from.stepId !== step.stepId &&
                        route.to.stepId !== step.stepId,
                    ),
                  })
                }
              >
                Remove action
              </Button>
            </div>
          </div>
        ))}
      </Section>

      <Section
        title="Port routes"
        action={
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={!inputPorts.length || !outputPorts.length}
            onClick={() =>
              onChange({
                ...distribution,
                routes: [
                  ...distribution.routes,
                  {
                    from: outputPorts[0]!,
                    to: inputPorts[0]!,
                    association: { kind: "identity" },
                  },
                ],
              })
            }
          >
            Add route
          </Button>
        }
      >
        <p className="text-xs text-muted-foreground">
          Connect the same actions on the canvas with an unconditional
          dependency edge. Use collect for an explicit aggregation action.
        </p>
        {distribution.routes.map((route, index) => (
          <div
            className="grid gap-2 rounded-surface border p-3 sm:grid-cols-[1fr_1fr_130px_auto]"
            key={index}
          >
            <EndpointSelect
              label="From output"
              endpoints={outputPorts}
              value={route.from}
              onChange={(from) => updateRoute(index, { ...route, from })}
            />
            <EndpointSelect
              label="To input"
              endpoints={inputPorts}
              value={route.to}
              onChange={(to) => updateRoute(index, { ...route, to })}
            />
            <Field label="Association">
              <select
                className={inputClass}
                value={route.association.kind}
                onChange={(event) =>
                  updateRoute(index, {
                    ...route,
                    association: {
                      kind: event.target
                        .value as DistributedRoute["association"]["kind"],
                    },
                  })
                }
              >
                {(
                  [
                    "identity",
                    "position",
                    "key",
                    "broadcast",
                    "collect",
                  ] as const
                ).map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              className="self-end"
              size="sm"
              variant="ghost"
              type="button"
              onClick={() =>
                onChange({
                  ...distribution,
                  routes: distribution.routes.filter(
                    (_, position) => position !== index,
                  ),
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
      </Section>

      {loop ? (
        <LoopRoutes
          loop={loop}
          inputPorts={inputPorts}
          outputPorts={outputPorts}
          stopPortNames={
            distribution.steps
              .find((step) => step.stepId === loop.body.outputStepId)
              ?.outputs.filter((port) => port.kind === "json")
              .map((port) => port.name) ?? []
          }
          onChange={onLoopChange}
        />
      ) : null}
    </div>
  );
}

function PortList({
  title,
  ports,
  onChange,
}: {
  title: string;
  ports: DistributedPort[];
  onChange(next: DistributedPort[]): void;
}) {
  const update = (index: number, next: DistributedPort) =>
    onChange(ports.map((port, position) => (position === index ? next : port)));
  return (
    <div className="grid content-start gap-2">
      <div className="flex items-center justify-between">
        <strong>{title}</strong>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() =>
            onChange([
              ...ports,
              { ...dataPort, name: `port${ports.length + 1}` },
            ])
          }
        >
          Add port
        </Button>
      </div>
      {ports.map((port, index) => (
        <div className="grid gap-2 rounded-control border p-2" key={index}>
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <Field label="Name">
              <input
                className={inputClass}
                value={port.name}
                onChange={(event) =>
                  update(index, { ...port, name: event.target.value })
                }
              />
            </Field>
            <Field label="Kind">
              <select
                className={inputClass}
                value={port.kind}
                onChange={(event) => {
                  const kind = event.target.value as DistributedPort["kind"];
                  update(index, {
                    name: port.name,
                    kind,
                    cardinality:
                      kind === "member-id-list"
                        ? "many"
                        : kind === "member-id"
                          ? "one"
                          : port.cardinality,
                    ...(kind === "json" || kind === "artifact"
                      ? { format: port.format ?? "application/json" }
                      : {}),
                  });
                }}
              >
                <option value="artifact">Artifact</option>
                <option value="json">JSON</option>
                <option value="member-id">Member ID</option>
                <option value="member-id-list">Member ID list</option>
              </select>
            </Field>
            <Button
              className="self-end"
              size="sm"
              variant="ghost"
              type="button"
              aria-label={`Remove ${title.toLowerCase()} port ${port.name}`}
              onClick={() =>
                onChange(ports.filter((_, position) => position !== index))
              }
            >
              ×
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Cardinality">
              <select
                className={inputClass}
                value={port.cardinality}
                disabled={port.kind.startsWith("member-id")}
                onChange={(event) =>
                  update(index, {
                    ...port,
                    cardinality: event.target
                      .value as DistributedPort["cardinality"],
                  })
                }
              >
                <option value="one">One</option>
                <option value="optional">Optional</option>
                <option value="many">Many</option>
                <option value="non-empty-many">Non-empty many</option>
              </select>
            </Field>
            <Field label="Exact MIME format">
              <input
                className={inputClass}
                value={port.format ?? ""}
                disabled={port.kind.startsWith("member-id")}
                onChange={(event) =>
                  update(index, { ...port, format: event.target.value })
                }
              />
            </Field>
          </div>
        </div>
      ))}
    </div>
  );
}

function LoopRoutes({
  loop,
  inputPorts,
  outputPorts,
  stopPortNames,
  onChange,
}: {
  loop: WorkflowGraphV3LoopControl;
  inputPorts: PortEndpoint[];
  outputPorts: PortEndpoint[];
  stopPortNames: string[];
  onChange(next: WorkflowGraphV3LoopControl): void;
}) {
  const initial = loop.initial?.routes ?? [];
  const carry = loop.carry?.routes ?? [];
  const seedOutputs = outputPorts.filter(
    (item) => !loop.body.stepIds.includes(item.stepId),
  );
  const entryInputs = inputPorts.filter(
    (item) => item.stepId === loop.body.entryStepId,
  );
  const carryOutputs = outputPorts.filter(
    (item) => item.stepId === loop.body.outputStepId,
  );
  const add = (kind: "initial" | "carry") => {
    const from = kind === "initial" ? seedOutputs[0] : carryOutputs[0];
    const to = entryInputs[0];
    if (!from || !to) return;
    onChange(
      kind === "initial"
        ? {
            ...loop,
            initial: {
              routes: [...initial, { from, to, association: "identity" }],
            },
          }
        : {
            ...loop,
            carry: {
              routes: [...carry, { from, to, association: "ring-successor" }],
            },
          },
    );
  };
  return (
    <Section title={`Loop state · ${loop.id}`}>
      <p className="text-xs text-muted-foreground">
        The loop uses one seed action outside its body. Its final ring transfer
        carries accepted artifacts to the next member for the next iteration.
        Set the maximum iteration count on the loop node.
      </p>
      {(["initial", "carry"] as const).map((kind) => {
        const routes = kind === "initial" ? initial : carry;
        const sources = kind === "initial" ? seedOutputs : carryOutputs;
        return (
          <div className="grid gap-2" key={kind}>
            <div className="flex items-center justify-between">
              <strong>
                {kind === "initial" ? "Seed routes" : "Carry routes"}
              </strong>
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={!sources.length || !entryInputs.length}
                onClick={() => add(kind)}
              >
                Add route
              </Button>
            </div>
            {routes.map((route, index) => (
              <div
                className="grid gap-2 rounded-surface border p-3 sm:grid-cols-[1fr_1fr_auto]"
                key={index}
              >
                <EndpointSelect
                  label="From output"
                  endpoints={sources}
                  value={route.from}
                  onChange={(from) =>
                    onChange(
                      kind === "initial"
                        ? {
                            ...loop,
                            initial: {
                              routes: initial.map((item, position) =>
                                position === index ? { ...item, from } : item,
                              ),
                            },
                          }
                        : {
                            ...loop,
                            carry: {
                              routes: carry.map((item, position) =>
                                position === index ? { ...item, from } : item,
                              ),
                            },
                          },
                    )
                  }
                />
                <EndpointSelect
                  label="To entry input"
                  endpoints={entryInputs}
                  value={route.to}
                  onChange={(to) =>
                    onChange(
                      kind === "initial"
                        ? {
                            ...loop,
                            initial: {
                              routes: initial.map((item, position) =>
                                position === index ? { ...item, to } : item,
                              ),
                            },
                          }
                        : {
                            ...loop,
                            carry: {
                              routes: carry.map((item, position) =>
                                position === index ? { ...item, to } : item,
                              ),
                            },
                          },
                    )
                  }
                />
                <Button
                  className="self-end"
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() =>
                    onChange(
                      kind === "initial"
                        ? {
                            ...loop,
                            initial: {
                              routes: initial.filter(
                                (_, position) => position !== index,
                              ),
                            },
                          }
                        : {
                            ...loop,
                            carry: {
                              routes: carry.filter(
                                (_, position) => position !== index,
                              ),
                            },
                          },
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        );
      })}
      <Field label="Stop when every member returns true on JSON output">
        <select
          className={inputClass}
          value={loop.stop?.port ?? ""}
          onChange={(event) =>
            onChange({
              ...loop,
              stop: event.target.value
                ? { port: event.target.value, mode: "all-true" }
                : undefined,
            })
          }
        >
          <option value="">No early stop</option>
          {stopPortNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Field>
    </Section>
  );
}

function EndpointSelect({
  label,
  endpoints,
  value,
  onChange,
}: {
  label: string;
  endpoints: PortEndpoint[];
  value: PortEndpoint;
  onChange(next: PortEndpoint): void;
}) {
  const token = (endpoint: PortEndpoint) =>
    `${endpoint.stepId}\u0000${endpoint.port}`;
  return (
    <Field label={label}>
      <select
        className={inputClass}
        value={token(value)}
        onChange={(event) => {
          const next = endpoints.find(
            (item) => token(item) === event.target.value,
          );
          if (next) onChange(next);
        }}
      >
        <option value={token(value)}>
          {value.stepId}.{value.port}
        </option>
        {endpoints
          .filter((item) => token(item) !== token(value))
          .map((item) => (
            <option key={token(item)} value={token(item)}>
              {item.stepId}.{item.port}
            </option>
          ))}
      </select>
    </Field>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid min-w-0 content-start gap-1 text-xs">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
function lines(value: string) {
  return value === "" ? [] : value.split(/\r?\n/).map((part) => part.trim());
}
