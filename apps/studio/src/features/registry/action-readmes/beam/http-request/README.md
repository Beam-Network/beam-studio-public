# HTTP Request

Calls an HTTP API and makes the response available to downstream steps and
gateways.

## Configuration

- `url`: required `http://` or `https://` URL.
- `method`: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, or `HEAD`.
- `credentialId`: optional HTTP credential. Its token is sent as a Bearer token.
- `timeoutSeconds`: defaults to 30 seconds and is capped at 120 seconds.
- `headers`: static string-valued request headers.

Configuration is not expression-resolved. Put per-run values in inputs.

## Inputs

- `body`: request body. Objects and arrays are JSON encoded; strings are sent as-is.
- `headers`: expression-capable string-valued headers merged over configured headers.
- `credentialId`: optional expression-capable credential selection.

GET and HEAD requests never send a body.

## Outputs

```json
{
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": { "result": "parsed JSON when the response declares JSON" }
}
```

Empty responses return `body: null`; other non-JSON responses return text.
Malformed declared JSON and every non-2xx response fail the action, so a
downstream Switch cannot run against a missing or ambiguous response.

`429` and `5xx` responses retry with bounded exponential backoff and honour
`Retry-After`. Other `4xx` responses are terminal.

## Permissions

- `network:http`
- `secrets:read`
