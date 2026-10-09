# Zapier action

Runs one action on your Zapier MCP server.

Every other integration here costs a credential type, a connection test, an
action and a page of documentation per destination. Zapier collapses that: one
credential reaches whatever you have configured on your MCP server, so a Beam
workflow can open a Jira issue or update a Salesforce record without Beam
shipping a Jira or Salesforce connector.

Pair it with a transfer step to fan a completion out to several tools at once,
or with the false branch of a Decision node to raise an alert.

## Credential

Create a **Zapier** credential under Native providers.

1. Go to [mcp.zapier.com](https://mcp.zapier.com) and create an MCP server.
2. Add the actions you want Beam to be able to run. A server with no actions
   authenticates fine and can do nothing.
3. Copy the server URL into **MCP server URL**.

That URL contains a per-server secret, so treat it as one. Studio stores it
encrypted and never returns it to the browser — credential listings show only
its origin.

**API key** is optional and only needed if your server is configured to require
a bearer token in addition to the URL secret.

Studio lists the server's actions before saving, so an unreachable endpoint or a
rejected key is reported at credential creation rather than mid-run. The action
count is shown on the saved credential.

## Configuration

- `credentialId`: the Zapier credential.
- `tool`: the action's name on your MCP server, for example
  `slack_send_channel_message`. Studio fetches the list from your server and
  offers it as suggestions; the field stays free text so an unreachable server
  does not block editing, and an action added on Zapier's side afterwards can
  still be typed.

## Inputs

- `instructions`: what the action should do, in plain language. Zapier fills in
  whatever fields this names. This is the primary input.
- `params`: optional explicit fields, merged over what Zapier infers. Bind a
  single `${…}` expression to pass an object intact, or type a JSON object.

Inputs resolve expressions, so instructions can read as a sentence:

```
Tell #ops that ${steps.<transfer>.name} finished with status ${steps.<transfer>.status}
```

`status` and `error` resolve even when a step failed, unlike `outputs`, which
exist only after a step succeeds.

## Outputs

- `ok`: true when the action completed. A refusal raises instead.
- `toolName`: the action that ran.
- `content`: what Zapier reported, as text.
- `result`: Zapier's structured result, when it returns one.

## Failures

Zapier reports a failed action inside a successful protocol response, so a
result flagged as an error is raised rather than returned as `ok: false` — a
silently unsent notification is worse than a failed step. Those are not retried:
the same arguments produce the same refusal.

Transport failures and `5xx` are retried with backoff, honouring `Retry-After`.
A rejected credential and a JSON-RPC error are terminal.

A successful run is recorded in step state and is not repeated if the step is
retried. Zapier exposes no idempotency key, so this is the only protection
against running someone's Zap twice — keep the tool name stable across retries.

## Discovering actions

`@beam/zapier-tools` lists the actions a credential exposes, as a step you can
run. It is the same call the editor's suggestion list makes, and it is useful
when a name is not resolving.

## Permissions

- `network:http`
- `secrets:read`
