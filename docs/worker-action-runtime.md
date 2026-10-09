# Studio Action Runner runtime

This document describes how the Studio Action Runner (`apps/worker`) executes
workflow actions. The Action Dispatcher creates and reconciles child-workflow
runs directly; workflow calls are never Action Runner tasks. See
[Workflow composition](workflow-composition.md).

Execution delegated to the Beam Orchestrator is a separate path, described in
[Remote execution](remote-execution.md). Its `node-legacy`, `wasi`, and `oci`
profiles are not runtime implementations provided by `apps/worker`.

The worker is PostgreSQL/NATS only. It must not use SQLite for orchestration or
task execution.

Assignments, lease fencing, resource cleanup evidence and result settlement follow
the [common workflow executor lifecycle](workflow-executors.md). A Runner reports
an action outcome; only the Action Dispatcher finalizes the workflow run.

## Runtime library and execution targets

The loader, sandbox and host-permission helpers live in
`packages/action-runtime`. Studio registration, PostgreSQL claims and NATS
consumption remain in `apps/worker`. A Studio Action Runner claims only actions
whose frozen target permits Studio execution and, when specified, its runner
identity. Managed room-member execution is a separate backend; see
[Room-member execution](room-member-execution.md).

## Execution Flow

For each NATS task notification, the worker:

1. claims the task transactionally in PostgreSQL;
2. persists process ownership behind the assignment's preparation fence, then
   loads the workflow run, step run, and locked step snapshot from PostgreSQL;
3. resolves the action package from either the built-in registry or the locked
   remote artifact metadata;
4. validates the manifest, trust level, placement, locked version, declared
   permissions, and config shape;
5. reads cached remote action bytes or downloads them, verifies their SHA-256,
   and validates publisher signatures when supplied;
6. executes the action with a controlled `context`;
7. persists outputs, metadata, state, artifacts, events, retries, or terminal
   failure back to PostgreSQL.

Remote action artifacts are immutable and cached by artifact checksum in
`WORKER_ACTION_CACHE_DIR`.

### Artifact ports (`action-artifact-ports/v1`)

Legacy `workflow-actions/v1` manifests declare artifact ports in their existing `inputs` and `outputs` maps
with `type: "artifact"` or `type: "artifact[]"`; `type: "artifact"` with
`cardinality: "many"` also denotes a collection. `required: true` and an exact
`format` match against the artifact media type are enforced. This uses the same
port names, cardinality and format as the v3 workflow graph contract. Other manifest
fields and legacy `context.artifacts.publish()` calls retain their existing
behavior when no artifact ports are declared.

Registry `workflow-actions/v2` describes ports directly in `inputs` and
`outputs`, with `type: "artifact"`, `cardinality`, exact `format`, and
`required`. The required capability is `action-artifact-ports/v1` under
`execution.requiredCapabilities`, alongside the Agent's
`capabilityContract`, `minRuntimeVersion`, and slot/lease requirements. Studio
validates the pinned Registry v2 fixtures and preserves the published manifest
and checksum. Its port adapter reads these declarations directly.
Registry v2 execution is available in the shared action loader only when the
installed native helper probes Linux cgroup v2 memory and process controllers,
and kernel CPU and subprocess enforcement. Unsupported hosts reject v2 before
artifact download. The Studio workflow launch gate and the managed Agent's v2
admission remain closed pending the protected end-to-end path.
Installing a v2 package alone does not authorize it to run.
The pinned fixtures are in
[`packages/core/src/workflows/fixtures/registry-v2`](../packages/core/src/workflows/fixtures/registry-v2).
Graph v3 execution and its capability requirement are handled separately and
remain gated.

### Registry v2 resource budgets

The runtime advertises `manifestApiVersions: ["workflow-actions/v2"]` in
`--capabilities` only after a native probe confirms a writable delegated cgroup
v2 parent with active `memory` and `pids` controllers, process attachment, and
seccomp filter installation. Linux x64 and arm64 are the supported targets.
Windows, macOS, read-only cgroup mounts, and Linux hosts without delegation do
not advertise v2. The normal v1 protocol and sandbox behavior are unchanged.

Each v2 action starts in a fresh cgroup before Node executes. `memory.max`
limits memory charged to the entire cgroup, conservatively bounding process
resident memory; `memory.peak` records the high-water mark. The kernel
`RLIMIT_CPU` hard limit enforces cumulative
process CPU time across Node threads. Its one-second granularity means the
runtime accepts integer `cpuMillis` from 1,000 through 2^40 and rounds down
to whole seconds; lower values fail before artifact loading. A seccomp filter
rejects fork, vfork, and process-creating clone calls, including clone3, while
allowing Node threads. The cgroup also caps thread count. The action timeout
is the smaller of the local sandbox limit and `contracts.resources.timeoutSeconds`.
CPU and memory exhaustion return distinct errors after cgroup termination is
confirmed. Cleanup failures fail closed and retain process ownership evidence.
V2 requires a durable process ownership record. Its cgroup token is committed
before the sandbox starts, so restart reconciliation can remove a cgroup even
if the controller dies before the sandbox's readiness message.

For a delegated service, run the Agent or Studio worker in a child cgroup of
a writable parent that has `memory` and `pids` enabled in its
`cgroup.subtree_control`. Set `BEAM_ACTION_CGROUP_PARENT` to that parent under
`/sys/fs/cgroup`. The helper requires it to be an ancestor of the service's
current cgroup, so action cgroups stay inside the delegated service subtree.
The service account needs permission to create child cgroups and write their
`cgroup.procs`, `memory.max`, `memory.oom.group`, `pids.max`, and `cgroup.kill`
files. The variable is passed only to the native helper, not to action code.
Check the installed runtime's `--capabilities` output on the actual host;
the optional v2 field is absent when any required operation fails.

The first transport supports inline `data:<mediaType>;base64,<content>` input
descriptors. Each descriptor has `type`, `name`, `uri`, and `metadata.bytes` and
`metadata.sha256` (prefixed with `sha256:`). The runtime verifies canonical
base64, byte count and SHA-256 before an action starts; unsupported external
handles fail explicitly. An action reads a verified input with
`await context.artifacts.readInput(port, index?)`, which returns canonical
base64. It publishes an output with
`await context.artifacts.publishOutput(port, base64, {name, mediaType})`.
The runtime checks port and cardinality, then publishes only after the action
returns successfully. It inserts published descriptors into both
`result.outputs[port]` and `result.artifacts`. Direct `publish()` calls,
returned artifacts, or output values on a declared artifact port are rejected
for port-aware actions.

One artifact is limited to 32 KiB; the combined input and output payload is
limited to 64 KiB and 16 artifacts per invocation. This keeps control messages
bounded. A Studio Runner publishes the bytes through its file server when one
is configured; otherwise it retains self-contained inline evidence. A room
member returns self-contained inline evidence, validated again by Studio at
settlement. Each published descriptor includes workflow run, step run, task and
attempt identity, plus assignment identity for a room member. Cancellation
prevents publication and result settlement.
Larger files require a later scoped streaming transport; external URLs and
worker-local URIs are not silently fetched by this protocol.

Members may advertise `artifactPorts: "action-artifact-ports/v1"` in their
`action-execution/v1` capability only when the installed Studio-owned runtime
supports these methods. Studio checks that advertisement before assignment.
The agent consumes the language-neutral conformity vectors in
[`packages/action-runtime/fixtures/artifact-ports-v1.json`](../packages/action-runtime/fixtures/artifact-ports-v1.json)
for admission tests and rejects v2 Registry vectors. The Studio runtime
validates the limits, format, byte integrity, cardinality and publication
evidence. A full Go-to-Studio artifact-port execution test remains open. The
locked Registry version and SHA-256 remain frozen across retries.

The bundled native process guard is required at startup on supported Linux and
Windows machines. It records sandbox identity before the execute message and
confirms termination after normal completion or owner recovery. Studio ownership
records live in `WORKER_PROCESS_OWNERSHIP_DIR` (production defaults to
`/data/beam-action-ownership` on the protected persistent volume), outside sandbox
filesystem permissions. Preserve this directory across process restarts. See
[process ownership](action-process-ownership.md) for packaging and recovery limits.
The helper manages Node subprocesses; it does not enable native action execution.

## Execution Modes

The action loader selects the execution path from the locked step metadata:

| Action source and isolation                | Execution location                             | Runtime access                                                |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------- |
| Embedded built-in package                  | Main Studio worker process                     | Controlled action context; no per-action subprocess isolation |
| Remote artifact, `sandboxed-esm` (default) | Dedicated Node.js subprocess with a VM context | Bundled ESM with no imports; host capabilities through IPC    |
| Remote artifact, `trusted-node`            | Dedicated Node.js subprocess                   | Node modules, filesystem permissions, and a network allowlist |

A step with `registryArtifactUrl` or `hippiusKey`, plus `artifactChecksum`, uses
the remote artifact path. Otherwise the loader resolves an embedded package
from `createBuiltinActionRegistry()`. `@beam/transfer` and `@beam/room-transfer`
are registry-only: they require executable artifact metadata and a manifest
snapshot and cannot fall back to an embedded implementation.

The manifest's `trustLevel: "builtin"` does not mean the action runs in the
worker process. A Registry artifact with that trust level still uses a
subprocess. Embedded actions undergo manifest, placement, version, and
permission validation, but do not receive the remote sandbox's process,
filesystem, or memory isolation.

## Remote Action Sandbox

Remote actions do not run inside the main worker process. The worker starts a
dedicated Node.js subprocess for each remote action execution.

For the default `sandboxed-esm` isolation tier, the subprocess runs with:

- `--permission`;
- no inherited environment variables;
- no `fetch`, `WebSocket`, or `EventSource` globals;
- `--frozen-intrinsics`;
- `--experimental-vm-modules`;
- read access to the directories containing the sandbox runner and action
  entrypoint, plus the per-action scratch directory when disk writes are enabled;
- write access only to the per-action scratch directory, and only when the
  action is approved for `filesystem:write`;
- no static or dynamic imports from the action artifact.

Artifacts for this tier must be bundled ESM files. They cannot import Node.js
modules at runtime. Capabilities must be accessed through `context`; the host
allows IPC methods according to the manifest's permissions.

## Trusted Node Remote Actions

Reviewed first-party actions that require Node built-ins can opt into a
separate `trusted-node` isolation tier:

```json
{
  "name": "@beam/transfer",
  "trustLevel": "builtin",
  "execution": {
    "runtime": "node",
    "isolation": "trusted-node",
    "defaultTimeoutSeconds": 3900
  }
}
```

This does not change the default remote sandbox. A trusted Node action runs
only when all of these checks pass:

- the package is under the reserved `@beam/*` namespace;
- its manifest trust is `builtin` or `verified`;
- its locked source is the public Registry;
- the worker explicitly lists the package in
  `WORKER_TRUSTED_NODE_ACTION_PACKAGES`;
- every network destination is either listed in
  `WORKER_TRUSTED_NODE_ALLOWED_NETWORK` or derived from an active credential
  referenced by the current task.

The action still runs in a dedicated subprocess with Node permissions, an empty
environment, no child processes, and no worker threads. It imports its entrypoint
through Node's module loader, without the `sandboxed-esm` VM context or
`--frozen-intrinsics`. Node built-ins are available; the runner wraps network
APIs to enforce the worker allowlist. This is a policy implemented in the Node
runner, not an OS network namespace or firewall.

Read access covers the directories containing the runner and action entrypoint.
Filesystem writes are disabled unless the manifest declares `filesystem:write`,
the worker allows that permission, and the worker file server is enabled. In
that case the shared loader grants read/write access to a unique scratch
directory for this execution, including in `trusted-node` mode. The trusted
runner does not expose `context.beam.files.createTempFile()`; direct Node file
writes do not pass through that helper's byte quota.

Example for the Beam transfer action:

```env
WORKER_TRUSTED_NODE_ACTION_PACKAGES=@beam/transfer
WORKER_TRUSTED_NODE_ALLOWED_NETWORK=127.0.0.1:4222,orch-gateway.b1m.ai:4222
```

Network allowlist entries use `host:port`, without the URL scheme. Beam
credentials keep the full endpoint URL: `nats://127.0.0.1:4222` for a local
stack or `tls://orch-gateway.b1m.ai:4222` for production.
Root creation in the API or Action Dispatcher freezes `BEAM_DEFAULT_BASE_URL`,
`BEAM_DEFAULT_NATS_URL`, `BEAM_ENV`, and scoped Beam credential connection metadata.
Before `@beam/transfer` enters the sandbox, the Action Runner resolves explicit
step configuration, then selected credential metadata from that snapshot, then
the frozen deployment defaults. It does not read current deployment values or
credential metadata to choose a destination. Children and retries inherit the
snapshot; Run again captures current configuration. The canonical Studio default
remains PROD; DEV transfers need explicit target fields or DEV credential metadata.
The sandbox environment stays empty. Current credential access and network policy
remain enforceable and can deny a previously authorized destination.
For each task, the worker automatically adds endpoints from the active
credentials referenced by the action config and inputs. This lets trusted
actions reach a selected object-storage or NATS credential without adding each
bucket or provider endpoint to the deployment environment. URLs supplied only
in action inputs do not expand the allowlist.

## Timeouts and Memory

The Studio worker default remains five minutes:

```env
WORKER_ACTION_SANDBOX_TIMEOUT_MS=300000
```

Timeout precedence is the explicit step timeout, the manifest
`execution.defaultTimeoutSeconds`, then this worker default. Values above the
worker default are honored only for `builtin` or `verified` first-party
`trusted-node` actions that came from the public Registry and appear in
`WORKER_TRUSTED_NODE_ACTION_PACKAGES`. At the effective timeout the worker sends
a cooperative abort. The sandbox is killed 30 seconds later if action
cancellation and cleanup have not finished; CPU-bound code is still bounded by
that hard deadline.

Embedded actions receive the abort signal in the worker process. They must
cooperate with cancellation; there is no child process to kill if they block
the event loop.

Both remote Node tiers use `WORKER_ACTION_SANDBOX_MEMORY_MB` (default `128`) for
Node's `--max-old-space-size`, with a minimum of 16 MB. This bounds the V8 old
generation heap, not the process's total resident memory or all native buffers.

## Packaged Native Executables

Some future actions may need to ship a native executable, for example `ffmpeg`,
compression tools, ML inference binaries, or proprietary file processors. This
is useful, but it must be treated as explicit remote code execution. A packaged
binary must never be implemented as a simple `child_process.spawn()` from the
main worker or from the Node action sandbox.

Native executable actions are a separate trust and runtime tier. The current
Studio worker rejects remote manifests whose `execution.runtime` is anything
other than `node` (or omitted). The remainder of this section describes future
requirements, not an implemented native runtime in `apps/worker`.

Recommended manifest shape:

```json
{
  "name": "@beam/video-transcode",
  "version": "1.2.0",
  "execution": {
    "runtime": "native",
    "native": {
      "linux-x64": {
        "path": "bin/transcode-linux-x64",
        "sha256": "..."
      },
      "darwin-arm64": {
        "path": "bin/transcode-darwin-arm64",
        "sha256": "..."
      }
    }
  },
  "permissions": [
    "filesystem:read",
    "filesystem:write",
    "beam:tunnel-source-file"
  ],
  "limits": {
    "timeoutSeconds": 600,
    "maxScratchBytes": 10737418240,
    "maxOutputBytes": 10737418240
  }
}
```

Security requirements before native actions can run:

- immutable action artifact with manifest checksum and artifact checksum locked
  on the workflow step/run;
- publisher signature or organization-private approval before installation;
- per-platform binary `sha256` verified before every execution;
- no inherited environment variables except explicit runtime variables;
- no direct access to worker credentials or orchestration database;
- no network access by default;
- scratch directory mounted as the only writable filesystem path;
- read-only mounts for the unpacked action artifact and declared input files;
- hard timeout, process group kill, and cleanup on cancellation;
- captured stdout/stderr with secret and signed URL redaction;
- audit event for native runtime start, finish, timeout, and denied permission;
- SBOM or dependency metadata for reviewed public packages.

The isolation boundary for native actions must be stronger than the current
Node subprocess sandbox. Acceptable implementations include a rootless
container, gVisor, Firecracker, or an equivalent per-execution sandbox with
filesystem, network, process, CPU, memory, and disk limits. A plain subprocess
under the worker user is not sufficient for external or verified native
actions.

Trust policy:

- `builtin` native actions may be allowed only on first-party workers.
- `verified` native actions require publisher verification, signature checks,
  and explicit worker policy opt-in.
- `external` native actions are installable only when an organization-private
  policy approves them for specific execution locations.
- native actions must never run on public or third-party workers unless that
  worker advertises a dedicated `native-action-runtime` capability and accepts
  the action trust tier.

Native actions may produce files through the same scratch and worker file export
system as Node actions. They must communicate with the worker through a narrow
host protocol such as stdin/stdout JSON, a Unix socket inside the sandbox, or a
small sidecar IPC channel. They should not receive direct access to the
orchestration database, NATS, Beam API credentials, or tunnel coordinator
credentials.

### Tunnel Capability For Native Actions

Native actions that produce large local files may request a short-lived public
source URL for a specific output file. This must be modeled as a narrow
capability, not as arbitrary public networking.

Allowed shape:

```text
beam:tunnel-source-file
```

This permission means:

- expose only a declared output file under the worker scratch directory;
- expose it only for the current workflow run, step run, and Beam transfer;
- use `HEAD`, `GET`, and `Range` semantics;
- bind the tunnel TTL to the transfer timeout plus a small grace window;
- persist tunnel metadata in step state so cleanup can run on success, failure,
  cancellation, timeout, or worker shutdown.

It does not mean:

- expose an arbitrary local port;
- expose a directory listing;
- open an inbound listener inside the action sandbox;
- let the action choose tunnel credentials, public tokens, or raw tunnel policy.

The worker owns tunnel creation and cleanup. The action only returns or
publishes a file; the worker decides whether to expose it directly, through
Beam Tunnel, or by falling back to object storage.

## Permission Gates

The manifest declares action permissions. The worker also has a local allowlist.
Both must agree before a capability is usable.

Default worker-allowed permissions:

```text
storage:read
storage:write
storage:delete
storage:list
network:http
network:nats
secrets:read
beam:room-publish
beam:room-status
beam:room-cancel
beam:transfer-create
beam:transfer-read
beam:transfer-cancel
```

Override with the full desired permission list (this replaces the defaults):

```env
WORKER_ACTION_ALLOWED_PERMISSIONS=storage:read,storage:write,network:http
```

`filesystem:write` is intentionally not allowed by default. It must be
explicitly approved on the worker before a remote action can create large local
files.

Runtime capability checks:

| Capability                                                | Required manifest permission                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `context.beam.objectStorage.download`                     | `storage:read`                                                       |
| `context.beam.objectStorage.upload`                       | `storage:write`                                                      |
| `context.beam.objectStorage.delete`                       | `storage:delete`                                                     |
| `context.secrets.get("name")`                             | `secrets:read` or `secrets:name`                                     |
| `context.beam.fileExports.publishLocalFile`               | `filesystem:read`                                                    |
| `context.beam.files.createTempFile` + publish             | `filesystem:write`                                                   |
| worker-managed Beam Tunnel source URL for a produced file | `beam:tunnel-source-file`                                            |
| `context.beam.transfer.execute`                           | `beam:transfer-create`, `beam:transfer-read`, `beam:transfer-cancel` |
| `context.beam.rooms.publish`                              | `beam:room-publish`                                                  |
| `context.beam.rooms.status`                               | `beam:room-status`                                                   |
| `context.beam.rooms.cancel`                               | `beam:room-cancel`                                                   |

The worker refuses to load an action when the manifest declares a permission
that is not allowed by local policy.

## Large Disk Files

Some approved actions need to generate multi-GB files without buffering them in
memory. The `sandboxed-esm` runner exposes a controlled disk-writing protocol
for that case. The example below uses that tier.

Required worker configuration:

```env
WORKER_FILE_SERVER_ENABLED=true
WORKER_ACTION_ALLOWED_PERMISSIONS=filesystem:write
WORKER_ACTION_SCRATCH_DIR=/data/beam-worker-scratch
WORKER_ACTION_SCRATCH_MAX_BYTES=10737418240
```

Required manifest permission:

```json
{
  "permissions": ["filesystem:write"]
}
```

Action example:

```js
export async function execute(_input, context) {
  const file = await context.beam.files.createTempFile({
    name: "random.bin",
    mediaType: "application/octet-stream",
    ttlSeconds: 3600,
  });

  for (let i = 0; i < 1024; i += 1) {
    const chunk = crypto.getRandomValues(new Uint8Array(1024 * 1024));
    await file.write(chunk);
  }

  const published = await file.publish();

  return {
    outputs: {
      uri: published.uri,
      bytes: published.size,
    },
    artifacts: [
      {
        name: "random.bin",
        type: "file",
        uri: published.uri,
        mediaType: published.mediaType,
      },
    ],
  };
}
```

`createTempFile()` writes only in the execution's unique subdirectory under
`WORKER_ACTION_SCRATCH_DIR`. Writes across all files created by this helper in
that execution count against `WORKER_ACTION_SCRATCH_MAX_BYTES`. Exceeding the
quota fails the action. This is an application-level quota on the helper, not
a filesystem quota covering direct writes by trusted Node code.

`file.publish()` registers the file with the worker file server and returns a
`beam-worker://<workerId>/<exportId>` URI. The file server supports `GET`,
`HEAD`, signed URLs, and byte ranges.

Files created through `context.beam.files.createTempFile()` are marked for
cleanup when the export expires or when the worker file server closes.

## Worker File Export

Worker-local files are ephemeral. A `beam-worker://` URI is valid only while:

- the source worker is alive;
- the export has not expired;
- the worker file server is reachable from the consumer;
- the signed URL has not expired.

Use object storage for durable output.

## Security Notes

The sandbox protects the worker process and host by combining process isolation,
Node.js permissions, manifest permissions, worker allowlists, and controlled IPC
capabilities.

These Node subprocess restrictions do not provide container or microVM
isolation. They apply to remote artifacts; embedded built-ins execute in the
worker process. The stronger native isolation described above remains a design
requirement.

The sandbox is not a package manager. Remote action artifacts must be bundled
before publishing. The worker does not run `npm install` during task execution.

Approving `filesystem:write` should be treated as a privileged operation. Use a
dedicated scratch volume with enough space, monitor disk usage, and keep the
quota lower than the physical capacity of the volume.

## Room transfer action

`@beam/room-transfer` is registry-only and uses trusted Node isolation with
explicit worker allowlisting. Its host methods are `beam.rooms.publish`,
`beam.rooms.status`, and `beam.rooms.cancel`, each gated by its corresponding
`beam:room-*` permission. `BEAM_STUDIO_API_URL` points to the internal API;
task claims authorize operations without disclosing credentials to the action.
The worker repeats the same manifest-driven config validation used when Studio
saves and queues a workflow. Room coordinator URLs are resolved by the API from
the selected environment template and never accepted from action config.
See [Room transfer workflows](room-transfer-workflows.md).

## Implementation References

- [Action loading and runtime selection](../packages/action-runtime/src/actionLoader.ts)
- [Subprocess runners, filesystem access, IPC, and cleanup](../packages/action-runtime/src/actionSandbox.ts)
- [Permission defaults and IPC capability gates](../packages/action-runtime/src/actionPermissions.ts)
- [Task execution, timeout policy, and credential-derived network targets](../apps/worker/src/services/postgresTaskWorker.ts)
- [Worker environment configuration](../apps/worker/src/services/config.ts)
