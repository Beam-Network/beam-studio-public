# Download

Downloads object content from an object storage endpoint and publishes it as a workflow artifact.

Use this action when a workflow needs to pull text or binary-like content into later transform, validation, or upload steps.

## Inputs

- `endpoint`: endpoint object produced by `@beam/object-storage-endpoint`.
- `provider`: provider override.
- `bucket`: bucket override.
- `objectKey`: object key override.
- `credentialId`: credential override.

## Configuration

- `mediaType`: media type for the published artifact.

## Outputs

- `content`: downloaded content when available as text.
- `uri`: artifact URI.
- `bytes`: downloaded byte count.

## Permissions

- `storage:read`

