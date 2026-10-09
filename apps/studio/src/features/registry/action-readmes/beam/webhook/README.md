# Webhook

Posts a completion callback to an HTTP endpoint.

Place it after the step whose outcome you want reported, or on the false branch
of a Decision node to report a failure. The body is a fixed envelope, so a
receiver parses one shape regardless of which step the callback was wired
behind.

## Configuration

- `url`: the `https://` endpoint that receives the callback. Required.
- `credentialId`: an optional **HTTP endpoint** credential. It authenticates the
  call and keys the signature.
- `method`: `POST` (default) or `PUT`.
- `timeoutSeconds`: how long to wait for a response. Defaults to 30, capped at 120.

These are configuration rather than inputs, so they are sent exactly as typed
and do not resolve `${…}` expressions.

## Inputs

- `event`: the event name. Defaults to `step.completed`; use `step.failed` on a
  failure branch.
- `payload`: carried through as the envelope's `data`.

Inputs resolve expressions. Type `@` in an input binding to reference another
node — its status, error, outputs or configuration.

`status` and `error` resolve even when a step failed, unlike `outputs`, which
exist only after a step succeeds. That is what makes a failure callback
possible: binding a failed step's output would raise, and the callback would
never send.

A binding that is nothing but a single expression keeps that expression's type
instead of becoming text, which is how an object reaches `payload` intact.

## The envelope

```json
{
  "event": "step.completed",
  "occurredAt": "2026-09-06T12:00:00.000Z",
  "workflowRunId": "wfr_...",
  "stepRunId": "wsr_...",
  "stepId": "step_...",
  "attempt": 1,
  "data": { "...": "whatever you bound to payload" }
}
```

## Delivery

Every request carries `Idempotency-Key: <stepRunId>`. That value is the same on
every attempt of the same step, so a receiver can collapse a duplicate caused by
a worker crash between the POST and its acknowledgement.

Delivery is at-least-once, not exactly-once. A successful delivery is recorded
in step state and is not repeated on a retry; an attempt that never recorded an
outcome is resent, because there is no way to know whether the receiver saw it.
The idempotency key is what makes that safe.

`429` and `5xx` are retried with backoff, honouring `Retry-After`. Every other
`4xx` is terminal — the next attempt would be refused identically. A missing or
non-HTTP URL raises immediately rather than reporting a silent non-delivery.

## Signature

Bind an **HTTP endpoint** credential and every callback carries:

```
X-Beam-Signature: t=1757160000,v1=<hex hmac-sha256>
```

The digest is `HMAC-SHA256(secret, "<t>.<raw body>")`, keyed on the credential's
`signing_secret`, or on its `token` when no separate secret is set. Verify it
against the raw body before parsing, and reject a `t` far from your own clock —
the timestamp is inside the signed material so a captured callback cannot be
replayed with a fresh one.

```js
const [t, v1] = header.split(",").map((part) => part.split("=")[1]);
const expected = crypto
  .createHmac("sha256", secret)
  .update(`${t}.${rawBody}`)
  .digest("hex");
const ok =
  crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) &&
  Math.abs(Date.now() / 1000 - Number(t)) < 300;
```

There is no signing on/off switch. A toggle only invites shipping an unsigned
callback while believing it is signed, so the signature is present exactly when
a credential carrying a key is bound.

## Outputs

- `delivered`: true when the endpoint accepted the callback. A refusal raises
  instead.
- `status`: the HTTP status returned.
- `requestId`: the value sent as `Idempotency-Key`.
- `respondedAt`: when the response arrived.

## Permissions

- `network:http`
- `secrets:read`
