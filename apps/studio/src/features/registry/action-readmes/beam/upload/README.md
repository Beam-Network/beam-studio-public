# Upload

Uploads workflow content to an object storage endpoint and publishes the uploaded object as an artifact reference.

Use this action at the end of data preparation workflows or after transforms that produce content for S3-compatible storage.

## Inputs

- `endpoint`: endpoint object produced by `@beam/object-storage-endpoint`.
- `content`: content to upload.
- `provider`: provider override.
- `bucket`: bucket override.
- `objectKey`: object key override.
- `credentialId`: credential override.

## Configuration

- `mediaType`: media type for the uploaded object and artifact.

## Outputs

- `uri`: uploaded artifact URI.
- `bytes`: uploaded byte count.

## Permissions

- `storage:write`

