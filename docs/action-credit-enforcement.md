# Action credit enforcement

Billable Studio actions hold credit before they start and settle it once they
finish. Work that never ran is never charged.

## What is billable, and who bills it

| Action            | Profile            | Permission         | Billed by |
| ----------------- | ------------------ | ------------------ | --------- |
| `transfer.create` | `beam.transfer.v1` | `transfers:create` | BeamCore  |
| `transfer.run`    | `beam.transfer.v1` | `transfers:create` | BeamCore  |
| `workflow.run`    | `beam.workflow.v1` | `workflows:run`    | Studio    |
| `room.start`      | `beam.room.v1`     | `rooms:start`      | Studio    |

Reads — listing transfers, runs, workflows, statuses — are free.

## Credit amounts

Credits never go beyond two decimals in Studio — charged, estimated, returned or
shown. A workflow run and a room start each cost one credit, but a transfer is
priced by the bytes it delivers and can cost a fraction of one: the live PROD
price is 0.01 credit per GB (`beam.transfer.v1`: 10,000 microcredits per
1,000,000,000 bytes, no minimum). Beam quotes to the microcredit (one credit is
1,000,000), so Studio brings every amount it reads from the Beam API to two
decimals (`apps/api/src/billing/credit-amount.ts`):

- amounts are parsed as finite JSON numbers; a non-number is a malformed answer
- a price or a charge (a quote, a reservation's `creditsUsed`) rounds **up** to
  the next 0.01 and zero stays zero: 1 GiB is 10,738 microcredits and shows as
  0.02 credit, 100 GB is exactly 1 credit
- a balance rounds **down** to 0.01, so a credit that is not there is never
  claimed; a pool can be overdrawn, so a balance can be negative, nothing is
  available from it, and Studio reads it as `0` available
- anything Studio adds up or compares (an estimate's total, a schedule's
  projected cost, a budget against what was consumed, an estimate against a
  balance) is summed and compared in whole hundredths, never in floating point
- every credit amount the UI shows goes through one formatter
  (`apps/studio/src/lib/format-credits.ts`): grouped thousands, at most two
  decimals, trailing zeros trimmed, never `-0` — `0.05`, `0.2`, `1,234.5`,
  `3`, `-0.5` for an overdrawn balance
- credit amounts entered in schedule settings step by 0.01; a per-run estimate
  is saved rounded up to 0.01 and a budget rounded down

**Transfers are billed by BeamCore, not Studio.** BeamCore settles each transfer
from the bytes it actually moved (`settle-transfer-billing`, keyed on the
transfer id). Studio never learns the byte count — it holds only a
`beam_transfer_id` — so a Studio-side charge could only be a flat per-run fee,
and it would land as a _second_ charge for the same transfer under a different
idempotency key.

Studio therefore verifies the key can pay before enqueueing a transfer and holds
nothing. Everything else is Studio's alone: BeamCore knows nothing about
workflows or rooms, and those are priced per invocation.

> Transfers are not charged at all unless `BILLING_SERVICE_ENABLED=true` in
> BeamCore's ops-scheduler. It defaults to `false`. This is a required setting,
> not an optional one.

Each action asks for its own permission. Before this, every billable call was
authorized as `transfers:create`, so a key restricted to transfers could also run
workflows and start rooms.

## One pool, many keys

An organization holds **one** credit pool and may issue **many** API keys against
it. A key has a _cap_, not a balance:

- available to a key = `min(pool − outstanding reservations, cap − used)`
- caps may be over-allocated on purpose; their sum can exceed the pool
- reservations are counted per **organization**, so sibling keys cannot each pass
  the same balance and oversell the pool

Because of this, every billable action must name the key it is charged to.
Transfers carry `transfer_templates.api_key_id`; workflows carry
`api_key_id` on `workflow.templates`. An action with no key
bound is refused rather than charged to an arbitrary key — that would spend a cap
the operator assigned to something else and misreport usage.

Studio stores keys under its own ids (`key_...`), which mean nothing to the Beam
API. The gate therefore decrypts the stored secret and presents it on every Beam
call as `Authorization: Bearer <key>`; Beam takes the organization, price scope
and permission from the key itself.

Historical Job executions retain their original reservation and settlement keys
after conversion into canonical workflow history. They are not charged again.
New composing workflows use `workflow.run`; child calls do not reserve a second
root invocation charge.

## Lifecycle

Studio-billed actions only. A BeamCore-billed action only verifies the key
through `/api/keys/verify`, which is itself the affordability check:
verification refuses a key whose organization cannot pay.

```
resolve  -> decrypt the stored key
reserve  -> hold credit with that key, refuse if the organization cannot pay
  run     -> credit_operation_key is stored on the run row
settle   -> commit on success, cancel/fail otherwise
```

Reserving is the only blocking billing call, and it happens before the run is
queued. Settlement is a background pass (`startCreditSettlementLoop`, every 30s)
that looks at runs which have reached a terminal state. Billing never sits
between a run and its next state.

A run that is never queued releases its hold immediately.

Retries are new work and take a fresh hold. Retrying dynamic regions reuses the
existing run row, so that row takes a new reservation and its `credit_settled_at`
is cleared.

## Refusals

`402` with a `reason` naming which limit was hit, because the fix differs:

| `reason`             | Meaning                                              | Fix                     |
| -------------------- | ---------------------------------------------------- | ----------------------- |
| `pool_exhausted`     | Organization is out of credit; every key is affected | Top up                  |
| `key_cap_exhausted`  | This key hit its own cap; sibling keys still work    | Raise the cap           |
| `key_budget_blocked` | This key's monthly budget blocks it                  | Raise or wait for reset |

Other outcomes are deliberately distinct from "out of credit":

- `400 api_key_required` — no key is bound to the action, or Studio cannot decrypt it
- `401`/`403 invalid_key` — the Beam API rejected the stored key
- `503 billing_unavailable` — the Beam API could not be reached

## Rooms

Rooms are billable, so the coordinator requires an `X-Api-Key` header on room
creation and refuses a create that names no key. The Studio proxy
(`POST /studio/rooms`) takes `apiKeyId` in the body, decrypts the stored Beam key
and forwards it. The Rooms page and the agent detail page both pick that key with
the same `BillingKeySelect` used by workflows, and neither will submit
without one.

`room.create` is **not** an agent command. Every other room operation may be
delegated to a connected agent, but a create must carry a payer, and sending a
decrypted key secret over the agent connection to a remote machine is not an
acceptable way to do that. Rooms created from an agent's page are created on the
organization's delegated path like any other; the agent adopts the room when it
next connects.

Room **duration** is not metered yet: a room is charged once when it starts. See
"Not covered" below.

## Estimating before a run

The workflow editor shows what a run will cost, next to the button that spends
it. `POST /studio/workflows/:id/credit-estimate` takes the transfers the editor
currently has on canvas — including unsaved edits — and prices them through
the Beam API's `POST /v1/pricing/quote` with the key the run would be charged to (the
workflow's selected key, or its Beam Transfer steps' credential), which holds
nothing, moves no counter and never reaches auto top-up.

It is deliberately off the run path. An estimate that cannot be fetched must
never delay or block starting a workflow.

Two owners charge for one run, so two things are priced, separately:

| Line | Profile | Priced on |
| --- | --- | --- |
| Workflow run | `beam.workflow.v1` | one invocation — Studio's own reservation |
| Each transfer | `beam.transfer.v1` | the bytes it will deliver — BeamCore's settlement |

A transfer's bytes are its **source size multiplied by its destination count**,
because BeamCore settles on `delivery_bytes_completed`: a source sent to two
destinations is delivered twice and billed twice.

Credits are summed **per reservation**, never pooled into one quote. Each
reservation rounds up to 0.01 credit on its own and carries its profile's base
and minimum, so a single pooled quote can read cheaper than the bill. The lines
are summed in whole hundredths: three transfers quoted at 0.1, 0.2 and 0.01
credits total exactly 0.31.

A file endpoint picked in the bucket explorer records its object's size
(`config.objectSize`), and that recorded size is used as is. Other sizes come
from the object storage the endpoints point at, and the estimate says so when it
cannot know:

- a source it cannot list — no credential, another provider, an unreachable
  bucket — leaves the transfer's volume unknown, and the line reads "volume
  measured after the run" against what the profile charges for zero bytes (its
  minimum, which may be zero), the least that transfer can cost. It is never
  reported as zero bytes.
- a truncated listing, or one unsized source among several, makes the figure a
  floor; the total is then shown as `≥`.
- no key to charge (none selected and no Beam Transfer credential, or transfer
  steps naming different credentials) is `400 api_key_required`, and the pill
  says which key to select rather than showing a number priced under some other
  organization's scope.

Alongside the quotes, the estimate reads what the same key can spend from
the Beam API's read-only `GET /v1/credits/available` (the pool net of outstanding
holds, bounded by the key's own cap; no hold, no auto top-up) and returns it as
`availableCredits`: any finite number of credits rounded down to 0.01, `0`
when the pool is overdrawn (a negative balance), `null` when no balance bounds
the key, or omitted when the balance could not be read within 2 seconds — a
Beam without the route, an unreachable API, a refused key or a malformed
answer. The estimate never fails or waits longer because of the balance. When
the total the pill shows (`~N`, or the floor `≥ N`) exceeds a known balance —
compared in hundredths — the pill turns into a warning ("~ 0.2 credits · 0.05
available", "This run needs about 0.2 credits, but only 0.05 are available. Add
credits in the Console."). An unknown or unbounded balance shows no warning.

A `workflow.run` reservation refused with `402` cancels the run with "Your
organization doesn't have enough credits to start this run. Add credits in the
Console, then run it again." Transfer admission refusals are worded by the
`@beam/transfer` action from BeamCore's estimate and balance.

Steps other than transfers are not priced, because nothing meters them: Studio
reserves no per-step credit and neither the worker nor the orchestrator reports
usage. The registry's billing descriptors declare that vocabulary, but no rate is
charged against it today.

## Transfer schedule estimates

A transfer template stores only its byte totals (`total_source_size_bytes`, and
`total_transfer_size_bytes` — sources summed, times the destination count);
saving a transfer, an endpoint or a schedule never prices anything and never
calls Beam. No credit rate is held in Studio.

The per-run estimate is priced when the schedules API is read
(`GET /studio/schedules`, `GET /studio/schedules/:id`, and the assistant's
`transfer.estimate`), through the same `POST /v1/pricing/quote` as the editor:
`beam.transfer.v1` for the delivered bytes, one source connector and each
destination connector, under the key the transfer's runs are charged to, so an
organization or billing-plan price book applies exactly as on the bill
(`apps/api/src/billing/transfer-price.ts`). The amount is rounded up to 0.01.

- A quote is reused for 5 minutes per key and usage, so a list asks Beam once
  per distinct transfer shape and a price book change shows within 5 minutes.
- A read waits at most 2 seconds for a quote; a slower quote keeps going and is
  reused by the next read.
- No key, a key Studio cannot read, a refused key, an unreachable Beam or a
  malformed answer is `estimatedCreditCost: null` — not remembered, so the next
  read asks again — and the scheduling UI shows "Estimate unavailable" rather
  than a stale or locally computed number.

A schedule's `estimatedTotalCreditCost` is that per-run estimate times its
projected runs, exact at two decimals, or `null` when the estimate is
unavailable. A transfer schedule's `credit_budget_limit` is compared only in the
scheduling UI, against credits consumed plus this projection; nothing enforces
it at run time. When the estimate is unavailable, the UI says the budget cannot
be checked. The workflow schedule trigger's budget is the separate local budget
of the schedule runtime, compared against the per-run estimate entered in the
trigger settings.

## Configuration

```bash
BEAM_API_URL=https://api.b1m.ai
```

Studio needs no shared secret: it authenticates to the Beam API with the
organization's own Beam API key, so a self-hosted install bills like the hosted
one. Reservations and their release go to `/v1/usage/reservations`, workflow
billing to `/v1/workflow-billing/*` and quotes to `/v1/pricing/quote`. Settlement
uses the key that reserved while it is usable and otherwise the organization's
default Beam key; a hold with no usable key stays pending and is retried.

## Not covered

- Room duration (`room.minutes`) is not metered; only room start is charged.
- Studio-billed actions settle the reserved amount; they are priced per
  invocation, so there are no actuals to reconcile. Volume billing belongs to
  BeamCore, which is the only component that measures bytes. It reports the
  measurement; the Beam API holds the rates and converts it to credits.
- Scheduled fires go through `startRun`/`startWorkflowRun` and inherit the gate
  only where the caller reserves first; the schedule runtime's own
  `credit_budget_*` states remain a separate local budget.
