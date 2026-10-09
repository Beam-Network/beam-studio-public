# Durable action process ownership

Studio Action Runners and opted-in managed agents use the shared runtime's native
process guard to recover after an executor process crashes. The action runtime
remains Node.js. The guard does not add native, OCI or WASI action capabilities.

## Launch barrier and recovery

1. The backend creates a durable `preparing` row with its assignment. Studio uses
   PostgreSQL; managed agents use their local SQLite command journal.
2. The guard creates an exclusive local record containing the owner's native
   identity and a random nonce. The backend commits the record reference with a
   compare-and-set from `preparing` to `ready` before starting action execution.
3. The runtime registers its controller once and records the sandbox identity
   before sending the sandbox an execute message. The sandbox cannot grant itself
   execution or access the ownership directory.
4. Ordinary completion waits for subprocess exit. Recovery of a crashed owner
   first saves a launch fence, then terminates the matching controller and sandbox
   and observes their native process handles signaling termination.
5. A recovery transaction may fence an unfinished `preparing` row directly:
   the old executor's compare-and-set then fails before it can start computation.
   Repeated recovery and late grants cannot restart that attempt.

Linux uses pidfds, process start time, boot identity and PID namespace. Windows
uses process handles, creation FILETIME and machine identity. A reused PID is
never killed. A signal request, elapsed timeout, missing command reply or expired
lease alone cannot certify termination. Ownership files use locking, flushed
temporary writes and atomic replacement. Studio records a hash of the local
process scope, permitting a replacement Runner registration in the same scope to
recover the old registration's assignments.

Process termination does not certify protected resource cleanup. Studio still
reconciles API-owned room publication evidence before releasing assignment claims
or allowing retries. Business output after cancellation remains fenced.

## Installation and persistent state

The package includes `native/process-guard-linux-{x64,arm64}` or
`native/process-guard-win32-{x64,arm64}.exe` beside `dist`. Linux requires pidfd
support. The runtime capability probe fails when the native helper is absent or
unusable. The Action Runner images compile the target Linux helper and include it
in the standalone runtime dependency closure.

For a source installation, run `node packages/action-runtime/scripts/build-process-guard.mjs`
with Go 1.26 installed. `--all` compiles all four supported helper targets; include
the appropriate binary when packaging the standalone runtime. Runtime dependencies
and Node.js 22+ are also required. Go is not required on execution machines.

Studio ownership records are kept in `WORKER_PROCESS_OWNERSHIP_DIR`; production
sets it to `/data/beam-action-ownership` on the existing protected persistent
volume. Managed agents keep their private ownership directory and SQLite journal
across process restarts. Keep the locally configured Node/runtime paths available
during agent recovery; an invocation command cannot replace these paths.

Missing/corrupt ownership records or an inaccessible original machine fail closed.
Replacing a container does not by itself certify that processes in its former
namespace have stopped. Such assignments remain unconfirmed; do not delete
evidence or mark them clean solely to force a retry.

The separate trusted canonical-host operator can attest a terminated Linux native
scope after container garbage collection. Every new Studio ownership row binds the
stable host identity, boot ID and native scope to the durable launch-barrier hash.
On the same boot, the operator performs full host-visible thread/namespace
observation. After a host restart, it accepts only a boot transition on the same
stable trusted host. Both paths use an exact assignment/attempt/executor/claim/
nonce/scope compare-and-set; neither relaxes this helper's local recovery contract.
A lost action result is not reconstructed merely because its processes stopped.

## Verification

The Go suite runs actual controller/sandbox processes and covers owner crashes,
concurrent reconciliation, late grants, PID reuse and unavailable evidence. The
runtime suite kills a Node owner while its actual sandbox is CPU-busy. PostgreSQL
integration tests verify preparation fencing, replacement Runner recovery and
separation from resource cleanup. The companion agent suite kills its Go daemon,
reopens its SQLite journal and uses the actual runtime to reconcile subprocesses.
The canonical Studio deployment and live Windows daemon crash/reconnect acceptance
confirmed native cleanup of the original attempt without duplicate invocation. An
explicit second attempt completed successfully.
