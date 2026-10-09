# Slack message

Posts a message to a Slack channel or sends a direct message to a person.

Pair it with the false branch of a Decision node to report a failure, or with
the true branch to confirm a transfer finished.

## Credential

Create a **Slack (bot token)** credential under Native providers. The token
starts with `xoxb-` and comes from your Slack app's *OAuth & Permissions* page.

- `chat:write` is required to post at all.
- `users:read.email` is required only to address a person by email address.
- Invite the bot to any private channel it should post in.

Studio verifies the token with `auth.test` before saving, so a wrong token is
reported at credential creation rather than in the middle of a run.

## Inputs

- `target`: `#channel`, a channel ID, `@handle`, a user ID, or a person's email
  address. An email is exchanged for a user ID with `users.lookupByEmail`
  before the message is sent.
- `message`: the message text.
- `threadTs`: optional timestamp to reply inside an existing thread.

These are inputs rather than configuration, so they accept `${…}` expressions.
Type `@` in an input binding to reference another node — its status, error,
outputs or configuration. Configuration fields elsewhere in Studio are passed
to an action verbatim and never resolve expressions.

Expressions resolve where they sit, so a message can read as a sentence:

```
Transfer ${steps.<transfer>.name} ${steps.<transfer>.status}: ${steps.<transfer>.error}
```

A binding that is nothing but a single expression keeps that expression's type
instead of becoming text, which is what lets an endpoint object pass between
steps intact. An expression that cannot be resolved raises rather than sending
the raw `${…}` through to Slack.

`status` and `error` resolve even when a step failed, unlike `outputs`, which
exist only after a step succeeds. Binding a failed step's output would raise an
error and the notification would never send.

## Outputs

- `delivered`: always true when the action completes; a refusal raises instead.
- `channel`: the channel or DM the message landed in.
- `ts`: the message timestamp, usable as `threadTs` for a follow-up.

## Failures

Slack answers HTTP 200 even when it refuses a call, so the `ok` flag is the
only reliable success signal. Refusals raise rather than returning
`delivered: false`, because a silently undelivered alert is worse than a failed
step.

Rate limits and 5xx responses are retryable. `invalid_auth`,
`channel_not_found`, `not_in_channel` and similar are not — they will not
succeed on a retry.

## Permissions

- `network:http`
- `secrets:read`
