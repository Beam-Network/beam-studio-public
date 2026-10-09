# Durable workflow invocation billing

New workflows automatically select an available Beam key for the organization's
default Beam environment. Selection is organization-scoped and respects the
workflow project. Active, unexpired keys with an active, unrevoked secret version
are eligible. Organization-wide keys precede project-scoped keys; creation time
and ID provide a stable default among eligible keys. Keys for other Beam endpoints,
NATS targets, or environments are excluded. Explicit workflow key choices always
win and remain fixed after creation; defaults never replace a frozen run's key.

The common creation path applies this selection to UI, assistant, and programmatic
authoring. **Workflow Settings → Execution and billing** remains available as an
override. A workflow with no selected key is charged to the Beam credential its
enabled Beam Transfer steps name (`resolveWorkflowBillingKey` in
`packages/core/src/workflows/billing-key.ts`), so a customer who created the
credential after the workflow picks the key once, in the transfer step. Settings
shows that default as "Same as the Beam Transfer step". Transfer steps naming
different credentials need an explicit selection. Launch and the credit estimate
resolve the key the same way; only a Beam Transfer step's credential counts,
never another action's. When neither exists, a workflow can still be drafted, but
launch requires configuration. Missing keys are rejected before a run or dispatch
record is created. There is no permanent execution-key banner in the editor or run page.
Failed runs show a readable explanation and Settings link in the ordinary failure
summary; raw evidence remains in Timeline and Payload. Retry cannot repair a
frozen missing-key snapshot; use **Run** after updating the workflow.

Children inherit their parent's frozen key. Automatic triggers without a workflow
key (selected, or one Beam Transfer credential; `workflowHasBillingKeySql`) wait
for selection and do not enter the launch batch, so incomplete definitions cannot
block other schedules or roll back a source workflow's completion.

Workflow settings keep Save changes in the top-right page header and show
details, execution/billing and availability first. The
advanced Public contract editor follows them, collapsed by default; collapsing
it preserves unsaved contract fields. Input/output schemas share a row on wider
screens and stack on smaller screens.

Every root launch stores a billing intent in the same transaction as its frozen
workflow run and dispatch record. Manual, API, MCP, assistant, scheduled and
completion-trigger launches all use this path. Launch returns a queued run;
current authorization and a confirmed reservation are required before dispatch.
Billing refusals appear in run history as execution authorization failures.

`execution.workflow_billing_attempts` owns the operation key, selected credential
reference, resolved account key identity, reservation state, terminal outcome,
settlement receipt time and recovery errors. No secret is stored in the attempt.
The key is derived from the run ID and billing attempt. Concurrent dispatchers
serialize reservation recovery for that identity through PostgreSQL advisory
locking; the identity is committed before any remote reservation request.

Child calls use their nearest billable ancestor. Calls do not independently
charge for composition. An explicit retry, including a direct child retry,
creates a new billing attempt while retaining the original immutable execution
context and every older attempt. Failed-only retry preserves completed children.
Run again creates a new run with current definitions and a new identity.

Before replaying an uncertain reservation, the API reads its original account
ledger receipt. A changed price or rotated credential cannot silently replace
that reservation. Current authorization remains mandatory even when an existing
hold is recovered. Network failures leave the billing intent recoverable; no
computation starts without a confirmed hold.

Terminal status transitions capture the attempt outcome transactionally.
Settlement runs separately from execution progression: completed runs commit,
failed/cancelled runs release. A lost response leaves the attempt pending until
the account authority confirms the same outcome. A failed settlement does not
block the other selected attempts, and later passes rotate past attempted
failures. A previous attempt's receipt cannot mark a newer retry settled.

A failed or cancelled intent whose durable authority identity and reservation
start are both absent closes locally under the reservation lock: no hold was
requested. This requires no usable key and prevents a later reserve of that
terminal attempt. Once reservation starts, external confirmation remains
mandatory; completed work always requires it.

The account service persists a terminal fence when settling an owned reservation.
A delayed reserve therefore cannot recreate that hold after cancellation. The
key-authenticated route requires an owned operation; it cannot fence another
organization's future identity. Never-started intents close under Studio's lock.
Deploy the account service's `WorkflowBillingFence` migration and its
key-authenticated `/v1` billing routes before activating this gate. Studio authenticates with the organization's Beam API key:
it reserves with the run's key, and looks up and settles with the run's key while
it is usable, otherwise with the organization's default key. Unavailable
reconciliation, or no usable key, fails closed and leaves settlement pending.

## Migration and verification

Migration 0027 imports existing workflow and migrated Job reservation identities,
outcomes and settled timestamps. It verifies one owner per operation identity;
repeat execution preserves existing attempts. Historical runs keep their billing
records and do not acquire a claim of output-contract validation.

The API's PostgreSQL tests cover concurrent reservation, response loss, child
reservation reuse, retries before old settlement completes, denied launches,
settlement failure isolation, historical backfill and identity collision rollback.
Account-service tests independently verify real ledger counters and reserve/cancel
races. Transfer byte billing and generic reservation expiry retain their separate
lifecycles.
