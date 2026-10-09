# Object storage endpoint

Builds a reusable S3-compatible endpoint object for storage actions.

Use this action to normalize bucket, object key, provider, and credential settings before passing the endpoint into `@beam/download`, `@beam/upload`, or `@beam/transfer`.

## Inputs

- `bucket`: bucket override.
- `objectKey`: object key override.

## Configuration

- `name`: human-readable endpoint name.
- `provider`: S3-compatible provider id.
- `bucket`: default bucket.
- `objectKey`: default object key.
- `sourceType`: file or directory semantics.
- `region`: provider region.
- `endpointUrl`: custom S3-compatible endpoint URL.
- `credentialId`: credential used by worker storage adapters.

## Outputs

- `endpoint`: normalized endpoint object.
- `provider`: resolved provider.
- `bucket`: resolved bucket.
- `objectKey`: resolved object key.
- `uri`: storage URI.

## Permissions

- `storage:read`

